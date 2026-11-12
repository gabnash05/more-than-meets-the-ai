import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import type { Socket } from "socket.io-client";
import type { CanvasOperation, DrawingBatch } from "@/contracts/drawing";
import { DEFAULT_ROOM_SETTINGS, type RoomEvent, type RoomSession } from "@/contracts/room";
import { DEFAULT_AVATAR } from "@/contracts/player";
import { LocalRoomClient } from "./local";
import { RemoteRoomClient } from "./remote";
import { seedReviewScenario } from "./review";
import { persistLocalRoomSession } from "./storage";

const profile = { name: "Tester", avatar: DEFAULT_AVATAR };
const session = (): RoomSession => ({
  playerId: "p", resumeToken: "token", demo: false, privateState: { role: "drawer", target: "cat" },
  snapshot: { code: "ABC123", revision: 1, settings: { ...DEFAULT_ROOM_SETTINGS }, players: [{ id: "p", profile, connected: true, joinedAt: 1 }], teams: [], hostId: "p", phase: "drawing", chat: [], game: { generation: 1, canvasId: "canvas", drawerId: "p", hint: "___", time: "--:--", scores: {} } },
});
const operation = (id: string): CanvasOperation => ({ type: "canvas.clear", opId: id, actionId: id, at: 1 });
const drawing = (sequence: number, ops: CanvasOperation[], reset = false, generation = 1): RoomEvent => ({ type: "drawing", canvasId: "canvas", generation, sequence, reset, caughtUp: reset, operations: ops });
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
class FakeSocket {
  connected = true;
  handlers = new Map<string, (...args: never[]) => void>();
  requests: { name: string; payload: { requestId: string }; ack: (error: Error | null, result?: { ok: boolean; code?: string; message?: string }) => void }[] = [];
  on(name: string, fn: (...args: never[]) => void) { this.handlers.set(name, fn); return this; }
  off(name: string) { this.handlers.delete(name); return this; }
  connect() { return this; }
  disconnect() { this.connected = false; return this; }
  timeout() { return this; }
  emit(name: string, payload: { requestId: string }, ack: (error: Error | null, result?: { ok: boolean; code?: string; message?: string }) => void) { this.requests.push({ name, payload, ack }); return this; }
  receive(name: string, event?: unknown) { this.handlers.get(name)?.(event as never); }
}
function remote(s = session()) {
  const socket = new FakeSocket();
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => structuredClone(s) } as Response));
  const client = new RemoteRoomClient({ fetch: fetcher as typeof fetch, socketFactory: () => socket as unknown as Socket });
  const events: RoomEvent[] = [];
  client.subscribe(e => events.push(e));
  return { client, socket, fetcher, events };
}

beforeEach(() => { vi.stubGlobal("localStorage", new MemoryStorage()); });

describe("room client contract", () => {
  it("local create persists and resumes, enforces start requirements and emits updates", async () => {
    const local = new LocalRoomClient(), events: RoomEvent[] = [];
    local.subscribe(e => events.push(e));
    const created = await local.create(profile);
    expect(created.demo).toBe(true);
    await expect(local.start()).rejects.toMatchObject({ code: "blocked" });
    await local.sendChat("hello");
    expect(events.some(e => e.type === "snapshot" && e.snapshot.chat[0]?.text === "hello")).toBe(true);
    const resumed = await new LocalRoomClient().resume(created.snapshot.code, created.resumeToken);
    expect(resumed.snapshot.chat[0].text).toBe("hello");
    await expect(new LocalRoomClient().resume(created.snapshot.code, "wrong")).rejects.toMatchObject({ code: "not-found" });
  });
  it("persists one three-second countdown before local demo word selection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const client = new LocalRoomClient();
    try {
      const seeded = await seedReviewScenario("lobby");
      await client.resume(seeded.snapshot.code, seeded.resumeToken);
      await client.start();
      expect(client.getSession()?.snapshot.phase).toBe("starting");
      expect(client.getSession()?.snapshot.startDeadlineAt).toBe(Date.now() + 3000);
      expect(client.getSession()?.privateState?.target).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2999);
      expect(client.getSession()?.snapshot.phase).toBe("starting");
      await vi.advanceTimersByTimeAsync(1);
      expect(client.getSession()?.snapshot.phase).toBe("choosing");
      await client.choosePrompt("cat");
      expect(client.getSession()?.snapshot.phase).toBe("drawing");
      expect(client.getSession()?.snapshot.startDeadlineAt).toBeUndefined();
      expect(client.getSession()?.privateState?.target).toBe("cat");
      await expect(client.start()).rejects.toMatchObject({ code: "in-progress" });
    } finally { client.dispose(); vi.useRealTimers(); }
  });
  it("allows generic closing chat while keeping the answer private until reveal", async () => {
    const seeded = await seedReviewScenario("drawer");
    seeded.snapshot.game!.closing = true;
    await persistLocalRoomSession(seeded);
    const client = new LocalRoomClient();
    await client.resume(seeded.snapshot.code, seeded.resumeToken);
    await expect(client.sendChat("It is a CAT")).rejects.toMatchObject({ code: "secret" });
    await client.sendChat("good round everyone");
    expect(client.getSession()?.snapshot.chat.at(-1)?.text).toBe("good round everyone");
    const result = await seedReviewScenario("result-missed");
    const revealed = new LocalRoomClient();
    await revealed.resume(result.snapshot.code, result.resumeToken);
    await expect(revealed.sendChat("It was cat")).resolves.toBeUndefined();
  });
  it("local journal deduplicates and replays submitted batches in order on resume", async () => {
    const seeded = await seedReviewScenario("drawer"), local = new LocalRoomClient();
    await persistLocalRoomSession(seeded);
    await local.resume(seeded.snapshot.code, seeded.resumeToken);
    const batch = (id: string, seq: number): DrawingBatch => ({
      transport: "room-client", batchId: id, roomCode: seeded.snapshot.code, canvasId: seeded.snapshot.game!.canvasId, generation: seeded.snapshot.game!.generation,
      clientSeq: [seq, seq], flushReason: "command", targetIntervalMs: 33, elapsedMs: 0,
      operationCount: 1, pointCount: 0, byteCount: 0, operations: [{ ...operation(id), clientSeq: seq }],
    });
    const suffix = crypto.randomUUID();
    await Promise.all([local.submitDrawing(batch(`first-${suffix}`, 1)), local.submitDrawing(batch(`second-${suffix}`, 2))]);
    await local.submitDrawing(batch(`first-${suffix}`, 1));
    const resumed = new LocalRoomClient(), events: RoomEvent[] = [];
    resumed.subscribe(event => events.push(event));
    await resumed.resume(seeded.snapshot.code, seeded.resumeToken); await resumed.resync();
    const reset = events.find(event => event.type === "drawing" && event.reset);
    expect(reset?.type).toBe("drawing");
    if (reset?.type === "drawing") {
      expect(reset.caughtUp).toBe(true);
      expect(reset.operations.slice(-2).map(op => op.opId)).toEqual([`first-${suffix}`, `second-${suffix}`]);
      expect(reset.operations.filter(op => op.opId === `first-${suffix}`)).toHaveLength(1);
    }
  });
  it("rejects reducing eight individual players to four team seats without changing the roster", async () => {
    const seeded = await seedReviewScenario("lobby");
    seeded.snapshot.settings.seats = 8;
    seeded.snapshot.players = Array.from({ length: 8 }, (_, i) => ({ id: i ? `p${i}` : seeded.playerId, profile, connected: true, joinedAt: i }));
    await persistLocalRoomSession(seeded);
    const client = new LocalRoomClient(); await client.resume(seeded.snapshot.code, seeded.resumeToken);
    await expect(client.updateSettings({ ...seeded.snapshot.settings, mode: "team", teamCount: 2, seatsPerTeam: 2 })).rejects.toMatchObject({ code: "capacity" });
    expect(client.getSession()!.snapshot.players).toHaveLength(8);
    expect(client.getSession()!.snapshot.settings.mode).toBe("individual");
  });
  it("merges team players into an adequate individual capacity", async () => {
    const seeded = await seedReviewScenario("lobby");
    seeded.snapshot.settings = { ...seeded.snapshot.settings, mode: "team", seats: 2, teamCount: 2, seatsPerTeam: 2 };
    seeded.snapshot.teams = [{ id: "team-1", name: "One" }, { id: "team-2", name: "Two" }];
    seeded.snapshot.players = Array.from({ length: 4 }, (_, i) => ({ id: i ? `p${i}` : seeded.playerId, profile, connected: true, joinedAt: i, teamId: i < 2 ? "team-1" : "team-2" }));
    await persistLocalRoomSession(seeded);
    const client = new LocalRoomClient(); await client.resume(seeded.snapshot.code, seeded.resumeToken);
    await client.updateSettings({ ...seeded.snapshot.settings, mode: "individual", seats: 4 });
    expect(client.getSession()!.snapshot.players).toHaveLength(4);
    expect(client.getSession()!.snapshot.players.every(p => !p.teamId)).toBe(true);
    expect(client.getSession()!.snapshot.settings.seats).toBeGreaterThanOrEqual(4);
  });
  it("does not change room settings or start again during a drawing", async () => {
    const seeded = await seedReviewScenario("drawer"), client = new LocalRoomClient();
    await client.resume(seeded.snapshot.code, seeded.resumeToken);
    await expect(client.updateSettings(seeded.snapshot.settings)).rejects.toMatchObject({ code: "in-progress" });
    await expect(client.start()).rejects.toMatchObject({ code: "in-progress" });
    await expect(client.selectTeam("team-1")).rejects.toMatchObject({ code: "in-progress" });
  });
  it("retains the host credential after a second local viewer joins", async () => {
    const host = new LocalRoomClient(), room = await host.create(profile);
    const guest = await new LocalRoomClient().join(room.snapshot.code, { ...profile, name: "Guest" });
    expect(guest.playerId).not.toBe(room.playerId);
    const resumed = await new LocalRoomClient().resume(room.snapshot.code, room.resumeToken);
    expect(resumed.playerId).toBe(room.playerId);
    expect(resumed.snapshot.players).toHaveLength(2);
  });
  it("accepts current drawing batches and rejects stale generations or result-phase edits", async () => {
    const seeded = await seedReviewScenario("drawer");
    const client = new LocalRoomClient();
    await client.resume(seeded.snapshot.code, seeded.resumeToken);
    const batch: DrawingBatch = {
      transport: "room-client", batchId: crypto.randomUUID(), roomCode: seeded.snapshot.code,
      canvasId: seeded.snapshot.game!.canvasId, generation: seeded.snapshot.game!.generation,
      clientSeq: [1, 1], flushReason: "command", targetIntervalMs: 33, elapsedMs: 0,
      operationCount: 1, pointCount: 0, byteCount: 0,
      operations: [{ ...operation(crypto.randomUUID()), clientSeq: 1 }],
    };
    await expect(client.submitDrawing(batch)).resolves.toBeUndefined();
    await expect(client.submitDrawing({ ...batch, generation: batch.generation! + 1 })).rejects.toMatchObject({ code: "forbidden" });
    const result = await seedReviewScenario("result-correct"), resultClient = new LocalRoomClient();
    await resultClient.resume(result.snapshot.code, result.resumeToken);
    await expect(resultClient.submitDrawing(batch)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("resumes a remote session during countdown before a canvas exists", async () => {
    const starting = session();
    starting.snapshot.phase = "starting";
    starting.snapshot.startDeadlineAt = Date.now() + 3000;
    delete starting.snapshot.game;
    starting.privateState = {};
    const { client } = remote(starting);
    try {
      const resumed = await client.resume("ABC123", "token");
      expect(resumed.snapshot.phase).toBe("starting");
      expect(resumed.snapshot.startDeadlineAt).toBe(starting.snapshot.startDeadlineAt);
      expect(resumed.snapshot.game).toBeUndefined();
    } finally { client.dispose(); }
  });
  it("remote bootstraps with injected fetch and reports typed failures", async () => {
    const { client, fetcher } = remote();
    await client.resume("ABC123", "token");
    expect(fetcher).toHaveBeenCalledWith("/api/rooms/ABC123/resume", expect.objectContaining({ headers: { authorization: "Bearer token" } }));
    expect(client.getSession()?.playerId).toBe("p");
    const broken = new RemoteRoomClient({ fetch: vi.fn().mockRejectedValue(new Error("offline")) as typeof fetch });
    await expect(broken.create(profile)).rejects.toMatchObject({ code: "connection", retryable: true });
  });
  it("reuses a request ID after timeout and surfaces rejected acknowledgements", async () => {
    const { client, socket } = remote(); await client.resume("ABC123", "token");
    const first = client.sendChat("hello"); socket.requests.at(-1)!.ack(new Error("timeout"));
    await expect(first).rejects.toMatchObject({ code: "connection", retryable: true });
    const retry = client.sendChat("hello"), request = socket.requests.at(-1)!;
    expect(request.payload.requestId).toBe(socket.requests.at(-2)!.payload.requestId);
    request.ack(null, { ok: true }); await retry;
    const rejected = client.start(); socket.requests.at(-1)!.ack(null, { ok: false, code: "blocked", message: "Need players" });
    await expect(rejected).rejects.toMatchObject({ code: "blocked", message: "Need players" });
  });
  it("filters stale, duplicate and gapped drawing; reconnect requests reset and signals caught-up", async () => {
    const { client, socket, events } = remote(); await client.resume("ABC123", "token");
    socket.receive("connect");
    expect(socket.requests.at(-1)?.name).toBe("room:resync");
    socket.requests.at(-1)!.ack(null, { ok: true });
    socket.receive("room:event", drawing(1, [operation("a")], true));
    socket.receive("room:event", drawing(1, [operation("a")]));
    socket.receive("room:event", drawing(0, [], true));
    socket.receive("room:event", drawing(2, [operation("old")], false, 0));
    socket.receive("room:event", drawing(3, [operation("gap")]));
    expect(events.filter(e => e.type === "drawing")).toHaveLength(1);
    await vi.waitFor(() => expect(events.some(e => e.type === "connection" && e.status === "connected")).toBe(true));
    expect(socket.requests.at(-1)?.name).toBe("room:resync");
    socket.requests.at(-1)!.ack(null, { ok: true });
    const next = session().snapshot;
    next.revision = 2; next.game = { ...next.game!, generation: 2 };
    socket.receive("room:event", { type: "snapshot", snapshot: next, privateState: { role: "drawer", target: "cat" } });
    socket.receive("room:event", drawing(0, [], true, 2));
    expect(events.filter(e => e.type === "drawing")).toHaveLength(2);
    socket.receive("disconnect");
    expect(events.at(-1)).toMatchObject({ type: "connection", status: "disconnected" });
  });
});
