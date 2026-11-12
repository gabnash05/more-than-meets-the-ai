import { createUuid as id } from "@/lib/uuid";
import type {
  RoomClient,
  RoomEvent,
  RoomSession,
  RoomSettings,
  RoomSnapshot,
} from "@/contracts/room";
import { DEFAULT_ROOM_SETTINGS, RoomClientError } from "@/contracts/room";
import type { PlayerProfile } from "@/contracts/player";
import type { DrawingBatch } from "@/contracts/drawing";
import { openDrawingJournal } from "@/features/canvas/journal";
import { closeInterruptedStroke } from "./recovery";
import {
  persistLocalRoomSession,
  loadLocalRoomSession,
  loadLocalCredential,
} from "./storage";
export { persistLocalRoomSession, deleteLocalRoomSession } from "./storage";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export class LocalRoomClient implements RoomClient {
  private session: RoomSession | null = null;
  private recovering = false;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleStart() {
    if (this.startTimer) clearTimeout(this.startTimer);
    const snapshot = this.session?.snapshot;
    if (snapshot?.phase !== "starting" || snapshot.startDeadlineAt === undefined) return;
    this.startTimer = setTimeout(() => {
      if (this.session?.snapshot !== snapshot || snapshot.phase !== "starting") return;
      const eligible = snapshot.settings.mode === "individual"
        ? snapshot.players.filter(player => player.connected).length >= 2
        : snapshot.teams.every(team => snapshot.players.filter(player => player.connected && player.teamId === team.id).length >= 2);
      if (!eligible) {
        this.change(s => { s.phase = "lobby"; delete s.startDeadlineAt; delete s.game; });
        void this.roomWrites.catch(error => this.emit({ type: "connection", status: "disconnected", message: error instanceof Error ? error.message : "Could not save the countdown." }));
        return;
      }
      this.change(s => {
        s.phase = "choosing";
        delete s.startDeadlineAt;
        if (s.game?.drawerId === this.current().playerId) this.current().privateState = { role: "drawer", promptOptions: [{ id: "cat", label: "cat (local demo)" }] };
      });
      void this.roomWrites.catch(error => this.emit({ type: "connection", status: "disconnected", message: error instanceof Error ? error.message : "Could not save word selection." }));
    }, Math.max(0, snapshot.startDeadlineAt - Date.now()));
  }
  private writes: Promise<void> = Promise.resolve();
  private roomWrites: Promise<void> = Promise.resolve();
  private listeners = new Set<(event: RoomEvent) => void>();
  private emit(event: RoomEvent) {
    this.listeners.forEach((fn) => fn(event));
  }
  private save(expectedRevision: number | null) {
    if (!this.session) return;
    const snapshot = this.session.snapshot;
    snapshot.chat = snapshot.chat.slice(-100);
    snapshot.startBlockers =
      snapshot.settings.mode === "individual"
        ? snapshot.players.filter((player) => player.connected).length < 2
          ? ["At least two connected players are needed."]
          : []
        : snapshot.teams
            .filter(
              (team) =>
                snapshot.players.filter(
                  (player) => player.connected && player.teamId === team.id,
                ).length < 2,
            )
            .map(
              (team) => `${team.name} needs at least two connected players.`,
            );
    const saved = clone(this.session);
    this.roomWrites = this.roomWrites
      .catch(() => {})
      .then(async () => {
        try {
          await persistLocalRoomSession(saved, expectedRevision);
        } catch (error) {
          if (this.session?.snapshot.code === saved.snapshot.code) {
            const latest = await loadLocalRoomSession(saved.snapshot.code);
            if (latest) this.session.snapshot = latest.snapshot;
          }
          throw error;
        }
        this.emit({
          type: "snapshot",
          snapshot: clone(saved.snapshot),
          privateState: saved.privateState,
        });
      });
  }
  private current(): RoomSession {
    if (!this.session)
      throw new RoomClientError("connection", "Join a room first.");
    return this.session;
  }
  private host() {
    const s = this.current();
    if (s.snapshot.phase !== "lobby")
      throw new RoomClientError(
        "in-progress",
        "Settings are available in the lobby.",
      );
    if (s.snapshot.hostId !== s.playerId)
      throw new RoomClientError("forbidden", "Only the host can do that.");
    return s;
  }
  private change(fn: (snapshot: RoomSnapshot) => void) {
    const s = this.current();
    const revision = s.snapshot.revision;
    fn(s.snapshot);
    s.snapshot.revision++;
    this.save(revision);
  }
  async create(profile: PlayerProfile) {
    const playerId = id();
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    this.session = {
      playerId,
      resumeToken: id(),
      demo: true,
      snapshot: {
        code,
        revision: 1,
        settings: clone(DEFAULT_ROOM_SETTINGS),
        players: [
          { id: playerId, profile, connected: true, joinedAt: Date.now() },
        ],
        teams: [],
        hostId: playerId,
        phase: "lobby",
        chat: [],
      },
    };
    this.save(null);
    await this.roomWrites;
    return clone(this.session);
  }
  async join(code: string, profile: PlayerProfile) {
    await this.roomWrites;
    const normalizedCode = code.trim().toUpperCase();
    const s = await loadLocalRoomSession(normalizedCode);
    if (!/^[A-Z0-9]{6}$/.test(normalizedCode))
      throw new RoomClientError("invalid", "Enter a valid room code.");
    if (!s || s.snapshot.code !== normalizedCode)
      throw new RoomClientError("not-found", "Room not found.");
    if (s.snapshot.phase !== "lobby")
      throw new RoomClientError("in-progress", "This match is in progress.");
    const playerId = id();
    const settings = s.snapshot.settings;
    const team =
      settings.mode === "team"
        ? s.snapshot.teams
            .map((t) => ({
              id: t.id,
              count: s.snapshot.players.filter((p) => p.teamId === t.id).length,
            }))
            .sort((a, b) => a.count - b.count)
            .find((t) => t.count < settings.seatsPerTeam)
        : undefined;
    if (
      settings.mode === "individual"
        ? s.snapshot.players.length >= settings.seats
        : !team
    )
      throw new RoomClientError("full", "This room is full.");
    s.playerId = playerId;
    s.resumeToken = id();
    s.snapshot.players.push({
      id: playerId,
      profile,
      connected: true,
      joinedAt: Date.now(),
      ...(team ? { teamId: team.id } : {}),
    });
    this.session = s;
    this.change(() => {});
    await this.roomWrites;
    return clone(s);
  }
  async resume(code: string, token: string) {
    await this.roomWrites;
    const s = await loadLocalRoomSession(code.trim().toUpperCase());
    const credential = await loadLocalCredential(token);
    if (
      !s ||
      s.snapshot.code !== code ||
      !credential ||
      !s.snapshot.players.some((p) => p.id === credential.playerId)
    )
      throw new RoomClientError("not-found", "Room session not found.");
    Object.assign(s, credential);
    this.session = s;
    this.recovering = true;
    this.scheduleStart();
    this.emit({ type: "connection", status: "restoring" });
    return clone(s);
  }
  async updateSettings(settings: RoomSettings) {
    const s = this.host();
    if (
      (settings.aiGuesserEnabled !== undefined && typeof settings.aiGuesserEnabled !== "boolean") ||
      (settings.aiRefereeEnabled !== undefined && typeof settings.aiRefereeEnabled !== "boolean") ||
      ![settings.seats, settings.teamCount, settings.seatsPerTeam].every(
        Number.isInteger,
      ) ||
      !Number.isInteger(settings.rounds) ||
      settings.rounds < 1 ||
      settings.rounds > 20 ||
      settings.seats < 2 ||
      settings.seats > 8 ||
      settings.teamCount < 2 ||
      settings.teamCount > 4 ||
      settings.seatsPerTeam < 2 ||
      settings.seatsPerTeam > 8
    )
      throw new RoomClientError(
        "invalid-settings",
        "Settings are outside allowed limits.",
      );
    if (
      settings.mode === "individual" &&
      s.snapshot.players.length > settings.seats
    )
      throw new RoomClientError(
        "capacity",
        "Move or remove players before reducing capacity.",
      );
    if (
      settings.mode === "team" &&
      s.snapshot.players.length > settings.teamCount * settings.seatsPerTeam
    )
      throw new RoomClientError(
        "capacity",
        "There are more players than team seats.",
      );
    const teams = Array.from({ length: settings.teamCount }, (_, i) => ({
      id: `team-${i + 1}`,
      name: `Team ${i + 1}`,
      capacity: settings.seatsPerTeam,
    }));
    if (
      settings.mode === "team" &&
      s.snapshot.players.some(
        (p) => p.teamId && !teams.some((t) => t.id === p.teamId),
      )
    )
      throw new RoomClientError(
        "capacity",
        "Move players from removed teams first.",
      );
    if (
      settings.mode === "team" &&
      teams.some(
        (t) =>
          s.snapshot.players.filter((p) => p.teamId === t.id).length >
          settings.seatsPerTeam,
      )
    )
      throw new RoomClientError(
        "capacity",
        "Move players before reducing team capacity.",
      );
    this.change((snapshot) => {
      snapshot.settings = { ...DEFAULT_ROOM_SETTINGS, ...snapshot.settings, ...settings };
      snapshot.teams = settings.mode === "team" ? teams : [];
      if (settings.mode === "individual")
        snapshot.players.forEach((p) => {
          delete p.teamId;
        });
      else
        snapshot.players
          .filter((p) => !p.teamId)
          .forEach((p) => {
            const t = teams
              .map((team) => ({
                team,
                count: snapshot.players.filter((x) => x.teamId === team.id)
                  .length,
              }))
              .sort((a, b) => a.count - b.count)[0];
            p.teamId = t.team.id;
          });
    });
    await this.roomWrites;
  }
  async movePlayer(playerId: string, teamId: string) {
    this.host();
    this.move(playerId, teamId);
    await this.roomWrites;
  }
  async selectTeam(teamId: string) {
    this.move(this.current().playerId, teamId);
    await this.roomWrites;
  }
  private move(playerId: string, teamId: string) {
    const s = this.current().snapshot;
    if (s.phase !== "lobby")
      throw new RoomClientError(
        "in-progress",
        "Teams can only change in the lobby.",
      );
    const player = s.players.find((p) => p.id === playerId);
    if (
      s.settings.mode !== "team" ||
      !player ||
      !s.teams.some((t) => t.id === teamId)
    )
      throw new RoomClientError("invalid-team", "Team unavailable.");
    if (
      s.players.filter((p) => p.teamId === teamId && p.id !== playerId)
        .length >= s.settings.seatsPerTeam
    )
      throw new RoomClientError("full", "Team is full.");
    this.change(() => {
      player.teamId = teamId;
    });
  }
  async start() {
    const s = this.host().snapshot;
    const counts =
      s.settings.mode === "individual"
        ? [s.players.filter((p) => p.connected).length]
        : s.teams.map(
            (t) =>
              s.players.filter((p) => p.connected && p.teamId === t.id).length,
          );
    if (counts.some((n) => n < 2))
      throw new RoomClientError(
        "blocked",
        "At least two connected players are needed in each group.",
      );
    this.change((snapshot) => {
      snapshot.phase = "starting";
      snapshot.startDeadlineAt = Date.now() + 3000;
      snapshot.game = {
        generation: 1,
        canvasId: id(),
        drawerId: snapshot.players[0].id,
        hint: "_ _ _",
        time: "--:--",
        scores: {},
      };
      this.current().privateState =
        snapshot.game.drawerId === this.current().playerId
          ? { role: "drawer" }
          : { role: "guesser" };
    });
    await this.roomWrites;
    this.scheduleStart();
  }
  async getInterruptedSketch(): Promise<never> { throw new RoomClientError("unsupported", "Saved interrupted drawings are unavailable in the local demo."); }
  async choosePrompt(optionId: string) {
    const session = this.current();
    if (session.snapshot.phase !== "choosing" || session.snapshot.game?.drawerId !== session.playerId || optionId !== "cat") throw new RoomClientError("forbidden", "Prompt selection is unavailable.");
    this.change(snapshot => {
      snapshot.phase = "drawing";
      snapshot.game!.hint = "_ _ _";
      session.privateState = { role: "drawer", target: optionId };
    });
    await this.roomWrites;
  }
  async retryInterrupted() { throw new RoomClientError("unsupported", "Retry is unavailable in the local demo."); }
  async returnToLobby() { throw new RoomClientError("unsupported", "Return to lobby is unavailable in the local demo."); }
  async leave() {
    const session = this.current();
    this.change((s) => {
      s.players = s.players.filter((p) => p.id !== session.playerId);
      if (!s.players.length) s.phase = "closed";
      else if (s.hostId === session.playerId)
        s.hostId =
          s.players
            .filter((p) => p.connected)
            .sort((a, b) => a.joinedAt - b.joinedAt)[0]?.id ?? s.hostId;
    });
    await this.roomWrites;
    this.session = null;
  }
  async sendChat(text: string) {
    const session = this.current();
    if (session.snapshot.phase === "drawing" && !session.snapshot.game?.closing && (session.snapshot.game?.drawerId === session.playerId || session.snapshot.players.find(player => player.id === session.playerId)?.solved)) throw new RoomClientError("forbidden", "Chat is unavailable during this drawing turn.");
    const clean = text.trim();
    const target = session.privateState?.target ?? "cat"; // The local demo uses one preset target.
    const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
    if (session.snapshot.phase === "drawing" && normalize(clean).includes(normalize(target))) throw new RoomClientError("secret", "That message contains the answer.");
    if (clean)
      this.change((s) =>
        s.chat.push({
          id: id(),
          playerId: this.current().playerId,
          text: clean,
          at: Date.now(),
        }),
      );
    await this.roomWrites;
  }
  async submitGuess(text: string) {
    const session = this.current();
    const game = session.snapshot.game;
    const player = session.snapshot.players.find(
      (p) => p.id === session.playerId,
    );
    if (
      !game ||
      session.snapshot.phase !== "drawing" ||
      game.drawerId === session.playerId ||
      !player ||
      player.solved
    )
      throw new RoomClientError("forbidden", "Guessing is unavailable.");
    const clean = text.trim();
    if (!clean) return;
    if (clean.toLowerCase() === (session.privateState?.target ?? "cat")) {
      this.change((snapshot) => {
        const solver = snapshot.players.find((p) => p.id === session.playerId)!;
        solver.solved = true;
        snapshot.chat.push({
          id: id(),
          playerId: session.playerId,
          text: "Guessed correctly!",
          at: Date.now(),
          kind: "correct",
        });
      });
      this.emit({ type: "gameplay", name: "correct" });
    } else {
      this.change((snapshot) =>
        snapshot.chat.push({
          id: id(),
          playerId: session.playerId,
          text: clean,
          at: Date.now(),
          kind: "chat",
        }),
      );
      this.emit({ type: "gameplay", name: "wrong" });
    }
    await this.roomWrites;
  }
  async submitDrawing(batch: DrawingBatch) {
    const session = this.current();
    const game = session.snapshot.game;
    if (
      !game ||
      session.snapshot.phase !== "drawing" ||
      session.privateState?.role !== "drawer" ||
      game.drawerId !== session.playerId ||
      batch.roomCode !== session.snapshot.code ||
      batch.canvasId !== game.canvasId ||
      batch.generation !== game.generation
    )
      throw new RoomClientError("forbidden", "Drawing is unavailable.");
    const latest = await loadLocalRoomSession(session.snapshot.code);
    if (
      !latest ||
      latest.snapshot.revision !== session.snapshot.revision ||
      latest.snapshot.phase !== "drawing" ||
      latest.snapshot.game?.generation !== game.generation ||
      latest.snapshot.game.canvasId !== game.canvasId
    ) {
      throw new RoomClientError("stale", "Room changed. Restore before drawing.", true);
    }
    const namespace = [
      session.snapshot.code,
      game.canvasId,
      game.generation,
    ].join(":");
    const write = this.writes.then(() =>
      openDrawingJournal(namespace).append(batch.operations),
    );
    this.writes = write.catch(() => {});
    await write;
    this.emit({ type: "ack", batchId: batch.batchId, accepted: true });
  }
  async resync() {
    const s = this.current();
    this.emit({
      type: "snapshot",
      snapshot: clone(s.snapshot),
      privateState: s.privateState,
    });
    const game = s.snapshot.game;
    if (game) {
      await this.writes;
      const journal = openDrawingJournal(
        [s.snapshot.code, game.canvasId, game.generation].join(":"),
      );
      const operations = await journal.load();
      const recovered = this.recovering
        ? closeInterruptedStroke(operations)
        : [];
      this.recovering = false;
      if (recovered.length) {
        await journal.append(recovered);
        operations.push(...recovered);
      }
      if (
        this.session !== s ||
        s.snapshot.game?.canvasId !== game.canvasId ||
        s.snapshot.game?.generation !== game.generation
      )
        return;
      this.emit({
        type: "drawing",
        canvasId: game.canvasId,
        generation: game.generation,
        sequence: operations.length,
        reset: true,
        caughtUp: true,
        operations,
      });
      this.emit({ type: "connection", status: "connected" });
    } else {
      this.recovering = false;
      this.emit({ type: "connection", status: "connected" });
    }
  }
  getSession() {
    return this.session ? clone(this.session) : null;
  }
  subscribe(fn: (event: RoomEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  dispose() {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.listeners.clear();
  }
}
