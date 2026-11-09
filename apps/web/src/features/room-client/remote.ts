import { io, type Socket } from "socket.io-client";
import { createUuid } from "@/lib/uuid";
import type {
  RoomClient,
  InterruptedSketch,
  RoomEvent,
  RoomSession,
  RoomSettings,
} from "@/contracts/room";
import { RoomClientError } from "@/contracts/room";
import type { PlayerProfile } from "@/contracts/player";
import type { DrawingBatch } from "@/contracts/drawing";
import { toDrawingPayload } from "@/contracts/drawing";
import { saveDrawingEnvelope, deleteDrawingEnvelope, deleteDrawingEnvelopes, loadDrawingEnvelopes, type DrawingEnvelope } from "./outbox";
import { loadRoomSession } from "./session";
const MAX_DRAWING_IN_FLIGHT = 16;

export interface RemoteOptions {
  apiUrl?: string;
  socketUrl?: string;
  fetch?: typeof fetch;
  socketFactory?: (
    url: string,
    options: { autoConnect: false; auth: { token: string; code: string } },
  ) => Socket;
}
export class RemoteRoomClient implements RoomClient {
  private session: RoomSession | null = null;
  private socket: Socket | null = null;
  private sequence = -1;
  private pending = new Map<
    string,
    {
      requestId: string;
      expectedRevision?: number;
      generation?: number;
      payload?: unknown;
    }
  >();
  private stream = "";
  private outboxChain: Promise<void> = Promise.resolve();
  private outboxOrder = Date.now() * 1000;
  private drawingInFlight = new Set<Promise<void>>();
  private drawingWrites = new Set<Promise<unknown>>();
  private drawingMetadata = new Map<string, { playerId: string; roomCode: string; canvasId: string; generation?: number; acceptedSequence?: number }>();
  private lastQueueCount: number | undefined;
  private pruneTimer: ReturnType<typeof setTimeout> | undefined;
  private pruneInProgress: Promise<void> | undefined;
  private pruneDirty = false;
  private resyncInProgress: Promise<void> | undefined;
  private sessionEpoch = 0;
  private expiringSession: RoomSession | null = null;
  private drawingFailure: unknown = null;
  private drawingFailureRecovery: Promise<void> | null = null;
  private durableWatermarks = new Map<string, number>();
  private unbind: (() => void) | null = null;
  private listeners = new Set<(event: RoomEvent) => void>();
  private fetcher: typeof fetch;
  constructor(private options: RemoteOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private emit(event: RoomEvent) {
    this.listeners.forEach((fn) => fn(event));
  }
  private async bootstrap(path: string, init?: RequestInit) {
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.options.apiUrl ?? ""}${path}`,
        init,
      );
    } catch {
      throw new RoomClientError(
        "connection",
        "Could not connect to the room service.",
        true,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new RoomClientError(
        "malformed",
        "Room service returned invalid JSON.",
      );
    }
    if (!response.ok) {
      const error =
        data && typeof data === "object"
          ? (data as { code?: string; message?: string })
          : {};
      throw new RoomClientError(
        error.code ?? "connection",
        error.message ?? "Room request failed.",
        response.status >= 500,
      );
    }
    const candidate = data as Partial<RoomSession> | null;
    const snapshot = candidate?.snapshot;
    if (
      !candidate ||
      typeof candidate.playerId !== "string" ||
      !candidate.playerId ||
      typeof candidate.resumeToken !== "string" ||
      !candidate.resumeToken ||
      typeof candidate.demo !== "boolean" ||
      !snapshot ||
      typeof snapshot.code !== "string" ||
      !snapshot.code ||
      !Number.isInteger(snapshot.revision) ||
      !snapshot.settings ||
      !["individual", "team"].includes(snapshot.settings.mode) ||
      !Array.isArray(snapshot.players) ||
      !Array.isArray(snapshot.teams) ||
      !Array.isArray(snapshot.chat) ||
      typeof snapshot.hostId !== "string" ||
      !["lobby", "choosing", "drawing", "result", "finished", "interrupted", "closed"].includes(snapshot.phase)
    ) {
      throw new RoomClientError(
        "malformed",
        "Room service returned an invalid session.",
      );
    }
    this.sequence = -1;
    this.stream = "";
    this.pending.clear();
    this.resetDrawingAccounting();
    this.session = candidate as RoomSession;
    this.connect(this.session);
    return this.session;
  }
  private async expireSession(code: string, playerId?: string, missingRoom = false) {
    const session = this.session;
    this.expiringSession = session;
    // Invalidate outstanding writes before asynchronous cleanup begins. Merely
    // clearing this.session afterwards lets a late ACK recreate a deleted row.
    this.sessionEpoch++;
    try {
      await Promise.allSettled([...this.drawingWrites]);
      if (this.session !== session) return;
      if (playerId || missingRoom) for (const item of await loadDrawingEnvelopes()) {
        if (item.payload.roomCode === code && (playerId === undefined || item.playerId === playerId)) await deleteDrawingEnvelope(item.requestId);
      }
    } catch { /* Storage may be unavailable; the expired credential is still unusable. */ }
    if (this.session !== session) return;
    this.unbind?.();
    this.socket?.disconnect();
    this.socket = null;
    this.session = null;
    this.resetDrawingAccounting();
    this.emit({ type: "connection", status: "disconnected", message: "Room session ended" });
  }
  private connect(session: RoomSession) {
    this.unbind?.();
    this.socket?.disconnect();
    const socket =
      this.options.socketFactory?.(this.options.socketUrl ?? "", {
        autoConnect: false,
        auth: { token: session.resumeToken, code: session.snapshot.code },
      }) ??
      io(this.options.socketUrl ?? undefined, {
        autoConnect: false,
        auth: { token: session.resumeToken, code: session.snapshot.code },
      });
    this.socket = socket;
    const epoch = this.sessionEpoch;
    const isCurrent = () => this.socket === socket && this.session === session && this.sessionEpoch === epoch;
    const onConnect = () => {
      if (!isCurrent()) return;
      this.emit({ type: "connection", status: "restoring" });
      if (this.resyncInProgress) return;
      void this.resync().catch((error) => {
        if (isCurrent()) this.emit({ type: "connection", status: "disconnected", message: error.message });
      });
    };
    const onDisconnect = () => {
      if (!isCurrent()) return;
      this.drawingFailure ??= new RoomClientError("connection", "Connection lost. Retry after restoring.", true);
      this.emit({ type: "connection", status: "disconnected" });
    };
    const onError = (error: Error) => {
      if (!isCurrent()) return;
      this.emit({ type: "connection", status: "disconnected", message: error.message });
      void this.fetcher(`${this.options.apiUrl ?? ""}/api/rooms/${encodeURIComponent(session.snapshot.code)}/resume`, { headers: { authorization: `Bearer ${session.resumeToken}` } })
        .then(async response => {
          if (response.status !== 401 && response.status !== 404) return;
          const body = await response.json() as { code?: string };
          const expectedCode = response.status === 401 ? "unauthorized" : "not-found";
          if (this.session === session && body?.code === expectedCode) await this.expireSession(session.snapshot.code, session.playerId);
        })
        .catch(() => {});
    };
    const onEvent = (event: RoomEvent) => {
      if (!isCurrent()) return;
      if (!event || typeof event !== "object" || typeof event.type !== "string")
        return;
      if (event.type === "snapshot") {
        if (
          !event.snapshot ||
          !Number.isInteger(event.snapshot.revision) ||
          (this.session &&
            event.snapshot.revision < this.session.snapshot.revision)
        )
          return;
        if (this.session) {
          this.session.snapshot = event.snapshot;
          const game = event.snapshot.game;
          if (game?.sync) {
            const key = `${event.snapshot.code}:${game.canvasId}:${game.generation}`;
            this.durableWatermarks.set(key, Math.max(this.durableWatermarks.get(key) ?? 0, game.sync.durableSequence));
          }
          this.session.privateState = event.privateState;
          this.scheduleDurablePrune();
        }
      }
      if (event.type === "drawing") {
        const game = this.session?.snapshot.game;
        if (
          !game ||
          event.canvasId !== game.canvasId ||
          event.generation !== game.generation ||
          !Number.isInteger(event.sequence) ||
          !Array.isArray(event.operations)
        )
          return;
        const stream = `${event.canvasId}:${event.generation}`;
        if (stream !== this.stream) {
          this.stream = stream;
          this.sequence = -1;
        }
        if (
          event.sequence < this.sequence ||
          (!event.reset && event.sequence === this.sequence)
        )
          return;
        if (
          !event.reset &&
          this.sequence >= 0 &&
          event.sequence > this.sequence + event.operations.length
        ) {
          void this.resync().catch(error => {
            if (isCurrent()) this.emit({ type: "connection", status: "disconnected", message: error.message });
          });
          return;
        }
        this.sequence = event.sequence;
      }
      this.emit(event);
      if (event.type === "drawing" && event.reset && event.caughtUp) {
        void this.restoreOutbox().then(() => { if (isCurrent() && socket.connected && this.stream === `${event.canvasId}:${event.generation}`) this.emit({ type: "connection", status: "connected" }); }).catch((error) => {
          if (!isCurrent()) return;
          if (!(error instanceof RoomClientError && error.code === "invalid-drawing" && socket.connected))
            this.emit({ type: "connection", status: "disconnected", message: error.message });
        });
      }
      if (event.type === "snapshot" && !event.snapshot.game) {
        void Promise.allSettled([...this.drawingInFlight]).then(() => {
          if (isCurrent() && !this.session?.snapshot.game) { this.drawingFailure = null; this.drawingFailureRecovery = null; }
        });
        this.emit({ type: "connection", status: "connected" });
      }
    };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onError);
    socket.on("room:event", onEvent);
    this.unbind = () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onError);
      socket.off("room:event", onEvent);
    };
    socket.connect();
  }
  private command(name: string, payload?: unknown, savedEnvelope?: DrawingEnvelope, onAccepted?: (result: { sequence?: number; durableSequence?: number }) => void): Promise<void> {
    if (this.session && this.expiringSession === this.session)
      return Promise.reject(new RoomClientError("session-ended", "Room session ended."));
    if (!this.socket?.connected)
      return Promise.reject(
        new RoomClientError(
          "connection",
          "Connection lost. Retry after restoring.",
          true,
        ),
      );
    const key = savedEnvelope ? "" : JSON.stringify([name, payload]);
    let envelope = savedEnvelope ?? this.pending.get(key);
    if (!envelope) {
      envelope = {
        requestId: createUuid(),
        expectedRevision: this.session?.snapshot.revision,
        generation: this.session?.snapshot.game?.generation,
        payload,
      };
      this.pending.set(key, envelope);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      this.socket!.timeout(10000).emit(
        name,
        envelope,
        (
          error: Error | null,
          result?: { ok: boolean; code?: string; message?: string; sequence?: number; durableSequence?: number },
        ) => {
          if (settled) return;
          settled = true;
          if (error) {
            reject(
              new RoomClientError("connection", `${name.replace("room:", "")} request timed out.`, true),
            );
            return;
          }
          if (key && this.pending.get(key) === envelope) this.pending.delete(key);
          if (!result?.ok)
            reject(
              new RoomClientError(
                result?.code ?? "rejected",
                result?.message ?? "Request rejected.",
                result?.code === "saving-unavailable",
              ),
            );
          else { onAccepted?.(result); resolve(); }
        },
      );
    });
  }
  create(profile: PlayerProfile) {
    return this.bootstrap("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile }),
    });
  }
  join(code: string, profile: PlayerProfile) {
    return this.bootstrap(
      `/api/rooms/${encodeURIComponent(code.trim().toUpperCase())}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile }),
      },
    );
  }
  async resume(code: string, token: string) {
    this.emit({ type: "connection", status: "restoring" });
    try { return await this.bootstrap(`/api/rooms/${encodeURIComponent(code)}/resume`, {
      headers: { authorization: `Bearer ${token}` },
    }); } catch (error) {
      if (error instanceof RoomClientError && ["unauthorized", "not-found"].includes(error.code)) {
        const saved = loadRoomSession();
        const playerId = saved?.code === code && saved.resumeToken === token ? saved.playerId : undefined;
        await this.expireSession(code, playerId, error.code === "not-found");
        throw new RoomClientError("session-ended", "Room session ended");
      }
      throw error;
    }
  }
  updateSettings(settings: RoomSettings) {
    return this.command("room:settings", settings);
  }
  movePlayer(playerId: string, teamId: string) {
    return this.command("room:move", { playerId, teamId });
  }
  selectTeam(teamId: string) {
    return this.command("room:select-team", { teamId });
  }
  start() {
    return this.command("room:start");
  }
  async getInterruptedSketch(canvasId: string, generation: number): Promise<InterruptedSketch> {
    if (!this.session) throw new RoomClientError("connection", "No room session to restore.");
    const response = await this.fetcher(`${this.options.apiUrl ?? ""}/api/rooms/${encodeURIComponent(this.session.snapshot.code)}/interrupted/${encodeURIComponent(canvasId)}/${generation}`, { headers: { authorization: `Bearer ${this.session.resumeToken}` } });
    if (!response.ok) throw new RoomClientError("restore", "Could not load the saved drawing.", true);
    return response.json() as Promise<InterruptedSketch>;
  }
  choosePrompt(id: string) { return this.command("room:choose-prompt", { id }); }
  retryInterrupted() { return this.command("room:retry-interrupted"); }
  returnToLobby() { return this.command("room:return-to-lobby"); }
  async leave() {
    await this.command("room:leave");
    this.dispose();
    this.session = null;
  }
  sendChat(text: string) {
    return this.command("room:chat", { text });
  }
  submitGuess(text: string) {
    return this.command("room:guess", { text });
  }
  private resetDrawingAccounting() {
    this.sessionEpoch++;
    this.expiringSession = null;
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = undefined;
    // A predecessor's scan cannot own this session's recovery barrier or dirty
    // flag. Its completion remains observed, but cannot schedule new work.
    this.pruneInProgress = undefined;
    this.pruneDirty = false;
    this.drawingMetadata.clear();
    this.resyncInProgress = undefined;
    this.lastQueueCount = undefined;
    this.durableWatermarks.clear();
  }
  private rememberDrawingEnvelope(envelope: DrawingEnvelope) {
    this.drawingMetadata.set(envelope.requestId, { playerId: envelope.playerId, roomCode: envelope.payload.roomCode, canvasId: envelope.payload.canvasId, generation: envelope.generation, acceptedSequence: envelope.acceptedSequence });
  }
  private reportDrawingQueue() {
    const session = this.session;
    const game = session?.snapshot.game;
    const pending = [...this.drawingMetadata.values()].filter(item => item.playerId === session?.playerId && item.roomCode === session?.snapshot.code && item.canvasId === game?.canvasId && item.generation === game?.generation && item.acceptedSequence === undefined).length;
    if (pending !== this.lastQueueCount) {
      this.lastQueueCount = pending;
      this.emit({ type: "drawing-queue", pending });
    }
  }
  private scheduleDurablePrune() {
    if (!this.session || !this.socket) return;
    if (this.pruneInProgress) { this.pruneDirty = true; return; }
    if (this.pruneTimer) return;
    const session = this.session;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined;
      const job = this.pruneDurableOutbox(session);
      this.pruneInProgress = job;
      void job.catch(() => {
        if (this.session !== session || !this.socket) return;
        this.drawingFailure ??= new RoomClientError("connection", "Could not save drawing changes on this device.", true);
        this.emit({ type: "connection", status: "disconnected", message: "Could not save drawing changes on this device." });
      }).finally(() => {
        if (this.pruneInProgress !== job) return;
        this.pruneInProgress = undefined;
        if (this.pruneDirty) { this.pruneDirty = false; this.scheduleDurablePrune(); }
      });
    }, 200);
  }
  private async sendSavedDrawing(envelope: DrawingEnvelope) {
    const session = this.session;
    const epoch = this.sessionEpoch;
    const socket = this.socket;
    const game = session?.snapshot.game;
    if (!game || envelope.playerId !== session?.playerId || game.canvasId !== envelope.payload.canvasId || game.generation !== envelope.generation || session.snapshot.code !== envelope.payload.roomCode) return;
    if (envelope.acceptedSequence !== undefined) return;
    let acceptedSequence: number | undefined;
    await this.command("room:drawing", envelope.payload, envelope, result => { acceptedSequence = result.sequence; });
    if (this.sessionEpoch !== epoch || this.session !== session || this.socket !== socket) return;
    if (acceptedSequence === undefined) throw new RoomClientError("malformed", "Drawing acknowledgement has no sequence.", true);
    envelope.acceptedSequence = acceptedSequence;
    const saved = saveDrawingEnvelope(envelope);
    this.drawingWrites.add(saved);
    try { await saved; } finally { this.drawingWrites.delete(saved); }
    if (this.sessionEpoch !== epoch || this.session !== session || this.socket !== socket) return;
    this.rememberDrawingEnvelope(envelope);
    this.reportDrawingQueue();
    this.scheduleDurablePrune();
  }
  private async pruneDurableOutbox(session: RoomSession) {
    const game = session.snapshot.game;
    if (!game?.sync) { if (this.session === session) this.reportDrawingQueue(); return; }
    const envelopes = await loadDrawingEnvelopes({ playerId: session.playerId, roomCode: session.snapshot.code });
    if (this.session !== session || !this.socket || session.snapshot.game !== game) return;
    let discarded = false;
    const ids: string[] = [];
    for (const envelope of envelopes) {
      if (envelope.generation !== undefined && envelope.generation < game.generation) {
        ids.push(envelope.requestId);
        const key = `${envelope.payload.roomCode}:${envelope.payload.canvasId}:${envelope.generation}`;
        if (envelope.acceptedSequence === undefined || envelope.acceptedSequence > (this.durableWatermarks.get(key) ?? 0)) discarded = true;
      } else if (envelope.payload.canvasId === game.canvasId && envelope.generation === game.generation && envelope.acceptedSequence !== undefined && envelope.acceptedSequence <= game.sync.durableSequence) ids.push(envelope.requestId);
    }
    await deleteDrawingEnvelopes(ids);
    if (this.session !== session || !this.socket) return;
    for (const id of ids) this.drawingMetadata.delete(id);
    if (discarded) this.emit({ type: "gameplay", name: "drawing-tail-discarded" });
    this.reportDrawingQueue();
  }
  private async handleDrawingFailure(error: unknown, envelope: DrawingEnvelope, retryLive = false) {
    if (!(error instanceof RoomClientError) || !["invalid-drawing", "drawing-paused", "drawing-limit", "expired", "stale-generation"].includes(error.code)) {
      if (retryLive) {
        this.emit({ type: "connection", status: "restoring" });
        void this.resync().catch((reason) => this.emit({ type: "connection", status: "disconnected", message: reason.message }));
      }
      throw error;
    }
    const pending = await loadDrawingEnvelopes({ playerId: envelope.playerId, roomCode: envelope.payload.roomCode });
    const ids = pending.filter(item => item.payload.canvasId === envelope.payload.canvasId && item.generation === envelope.generation && item.payload.streamId === envelope.payload.streamId && item.acceptedSequence === undefined).map(item => item.requestId);
    await deleteDrawingEnvelopes(ids);
    for (const id of ids) this.drawingMetadata.delete(id);
    this.emit({ type: "gameplay", name: "drawing-tail-discarded" });
    await this.reportDrawingQueue();
    this.emit({ type: "connection", status: "restoring" });
    void this.resync().catch((reason) => this.emit({ type: "connection", status: "disconnected", message: reason.message }));
    throw new RoomClientError("invalid-drawing", "Some drawing changes could not be saved after reconnection. Please continue with a new stroke.");
  }
  private restoreOutbox() {
    const originalSession = this.session;
    const originalSocket = this.socket;
    const recoveryAtStart = this.drawingFailureRecovery;
    const job = this.outboxChain.then(async () => {
      await Promise.allSettled([...this.drawingInFlight]);
      const recovery = this.drawingFailureRecovery;
      this.drawingFailureRecovery = null;
      if (recovery) {
        if (recovery === recoveryAtStart) await recovery.catch(() => {});
        else await recovery;
      }
      this.drawingFailure = null;
      const session = this.session;
      if (!session || session !== originalSession || this.socket !== originalSocket) return;
      if (this.pruneTimer) clearTimeout(this.pruneTimer);
      this.pruneTimer = undefined;
      if (this.pruneInProgress) await this.pruneInProgress;
      await this.pruneDurableOutbox(session);
      const envelopes = await loadDrawingEnvelopes({ playerId: session.playerId, roomCode: session.snapshot.code });
      if (this.session !== session || !this.socket) return;
      this.drawingMetadata.clear();
      for (const envelope of envelopes) this.rememberDrawingEnvelope(envelope);
      this.reportDrawingQueue();
      for (const envelope of envelopes.sort((a, b) => a.order - b.order)) {
        try { await this.sendSavedDrawing(envelope); }
        catch (error) { this.drawingFailure = error; await this.handleDrawingFailure(error, envelope); }
      }
    });
    this.outboxChain = job.catch(() => {});
    return job;
  }
  submitDrawing(batch: DrawingBatch) {
    // Expiry owns cleanup from its first await onwards; do not create new rows
    // that its already-started scan cannot see.
    if (this.session && this.expiringSession === this.session)
      return Promise.reject(new RoomClientError("session-ended", "Room session ended."));
    const originalSession = this.session;
    const originalSocket = this.socket;
    const originalEpoch = this.sessionEpoch;
    const envelope: DrawingEnvelope = { requestId: createUuid(), playerId: this.session?.playerId ?? "", order: ++this.outboxOrder, expectedRevision: this.session?.snapshot.revision, generation: batch.generation, payload: toDrawingPayload(batch) };
    const saved = saveDrawingEnvelope(envelope).then(() => {
      // Persisted batches waiting outside the send window are unaccepted work too.
      if (this.sessionEpoch === originalEpoch && this.session === originalSession && this.socket === originalSocket) {
        this.rememberDrawingEnvelope(envelope);
        this.reportDrawingQueue();
      }
    });
    this.drawingWrites.add(saved);
    void saved.then(() => this.drawingWrites.delete(saved), () => this.drawingWrites.delete(saved));
    // Serialize persistence and emission, but allow a bounded number of ACKs in flight.
    const launch = this.outboxChain.then(async () => {
      try { await saved; }
      catch (error) {
        this.drawingFailure ??= error;
        this.emit({ type: "connection", status: "disconnected", message: "Could not save drawing changes on this device." });
        throw error;
      }
      if (this.sessionEpoch !== originalEpoch || this.session !== originalSession || this.socket !== originalSocket || !originalSocket) throw new RoomClientError("connection", "Room session changed while saving drawing.", true);
      while (this.drawingInFlight.size >= MAX_DRAWING_IN_FLIGHT && !this.drawingFailure)
        await Promise.race([...this.drawingInFlight].map(task => task.catch(() => {})));
      if (this.sessionEpoch !== originalEpoch || this.session !== originalSession || this.socket !== originalSocket) throw new RoomClientError("connection", "Room session changed while saving drawing.", true);
      if (this.drawingFailure) throw this.drawingFailure;
      await this.reportDrawingQueue();
      if (this.drawingFailure) throw this.drawingFailure;
      const task = this.sendSavedDrawing(envelope);
      this.drawingInFlight.add(task);
      void task.then(() => this.drawingInFlight.delete(task), () => this.drawingInFlight.delete(task));
      return { task };
    });
    this.outboxChain = launch.then(() => {}, () => {});
    return launch.then(({ task }) => task.catch(async error => {
      if (this.sessionEpoch !== originalEpoch || this.session !== originalSession || this.socket !== originalSocket) throw error;
      if (!this.drawingFailure) {
        this.drawingFailure = error;
        this.emit({ type: "connection", status: "restoring" });
        this.drawingFailureRecovery = (async () => {
          await Promise.allSettled([...this.drawingInFlight, ...this.drawingWrites]);
          await this.handleDrawingFailure(error, envelope, true);
        })();
      }
      if (this.drawingFailureRecovery) await this.drawingFailureRecovery;
      throw error;
    }));
  }
  resync() {
    if (this.resyncInProgress) return this.resyncInProgress;
    const job = this.performResync();
    this.resyncInProgress = job;
    void job.finally(() => { if (this.resyncInProgress === job) this.resyncInProgress = undefined; }).catch(() => {});
    return job;
  }
  private async performResync() {
    const socket = this.socket;
    if (!socket)
      throw new RoomClientError(
        "connection",
        "No room session to restore.",
        true,
      );
    if (!socket.connected) {
      this.emit({ type: "connection", status: "restoring" });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off("connect", connected);
          socket.off("connect_error", failed);
          reject(
            new RoomClientError("connection", "Reconnect timed out.", true),
          );
        }, 10000);
        const connected = () => {
          clearTimeout(timer);
          socket.off("connect_error", failed);
          resolve();
        };
        const failed = () => {
          clearTimeout(timer);
          socket.off("connect", connected);
          reject(new RoomClientError("connection", "Reconnect failed.", true));
        };
        socket.once("connect", connected);
        socket.once("connect_error", failed);
        socket.connect();
      });
    }
    if (this.socket !== socket) throw new RoomClientError("connection", "Room session changed while restoring.", true);
    await this.command("room:resync");
  }
  getSession() {
    return this.session;
  }
  subscribe(fn: (event: RoomEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  dispose() {
    this.unbind?.();
    this.unbind = null;
    this.socket?.disconnect();
    this.socket = null;
    this.resetDrawingAccounting();
    this.listeners.clear();
  }
}
