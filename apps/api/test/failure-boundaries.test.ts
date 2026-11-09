import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomEngine } from "../src/game/engine";
import type { GameStore, PersistedRoom, DrawingRecord, FinalizedTurn } from "../src/game/ports";

class FailingStore implements GameStore {
  rooms = new Map<string, PersistedRoom>(); drawings: DrawingRecord[] = []; turns = new Map<string, FinalizedTurn>();
  failSave = false; failArchive = false; failFinalize = false;
  async loadRooms() { return structuredClone([...this.rooms.values()]); }
  async saveRoom(room: PersistedRoom) { if (this.failSave) throw new Error("database offline"); this.rooms.set(room.code, structuredClone(room)); }
  async appendDrawing(record: DrawingRecord) { if (this.failArchive) throw new Error("database offline"); this.drawings.push(structuredClone(record)); }
  async loadDrawing(code: string, canvas: string, generation: number) { return structuredClone(this.drawings.filter(row => row.roomCode === code && row.canvasId === canvas && row.generation === generation)); }
  async finalizeTurn(turn: FinalizedTurn) { if (this.failFinalize) throw new Error("database offline"); const id = `${turn.turnId}:${turn.generation}`; if (!this.turns.has(id)) { this.turns.set(id, structuredClone(turn)); this.rooms.set(turn.room.code, structuredClone(turn.room)); } }
}
const profile = { name: "Host", avatar: { shape: "pebble", expression: "smile", color: "cyan" } } as const;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function bounded<T>(promise: Promise<T>, ms = 500): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("operation hung")), ms); })]); } finally { if (timer) clearTimeout(timer); } }
async function setup() {
 const store = new FailingStore(); const engine = new RoomEngine({ store, eventSink: () => {}, config: { chooseMs: 2000, drawMs: 2000, recapMs: 2000, graceMs: 30 } });
 const host = await engine.create(profile); const other = await engine.join(host.snapshot.code, { ...profile, name: "Other" });
 await engine.connect(host.snapshot.code, host.resumeToken, "host"); await engine.connect(host.snapshot.code, other.resumeToken, "other");
 return { store, engine, host, other, code: host.snapshot.code };
}
async function begin(ctx: Awaited<ReturnType<typeof setup>>) {
 const state = await ctx.engine.resume(ctx.code, ctx.host.resumeToken);
 assert.equal((await ctx.engine.command("host", "room:start", { requestId: "start", expectedRevision: state.snapshot.revision })).ok, true);
 const choosing = await ctx.engine.resume(ctx.code, ctx.host.resumeToken); const game = choosing.snapshot.game!; const word = choosing.privateState!.promptOptions![0].id;
 assert.equal((await ctx.engine.command("host", "room:choose-prompt", { requestId: "choose", generation: game.generation, payload: { id: word } })).ok, true);
 return { game, word };
}
test("failed join does not consume a seat", async () => {
 const ctx = await setup(); try { ctx.store.failSave = true; await assert.rejects(ctx.engine.join(ctx.code, { ...profile, name: "Failure" })); ctx.store.failSave = false; const state = await ctx.engine.resume(ctx.code, ctx.host.resumeToken); assert.equal(state.snapshot.players.length, 2); const joined = await ctx.engine.join(ctx.code, { ...profile, name: "Success" }); assert.equal(joined.snapshot.players.length, 3); } finally { ctx.store.failSave = false; await bounded(ctx.engine.shutdown()); }
});
test("failed socket connect leaves no ghost lease and preserves existing lease", async () => {
 const ctx = await setup(); try { ctx.store.failSave = true; await assert.rejects(ctx.engine.connect(ctx.code, ctx.host.resumeToken, "replacement")); ctx.store.failSave = false; const old = await ctx.engine.command("host", "room:resync", { requestId: "old" }); const replacement = await ctx.engine.command("replacement", "room:resync", { requestId: "new" }); assert.equal(old.ok, true); assert.equal(replacement.code, "unauthorized"); } finally { ctx.store.failSave = false; await bounded(ctx.engine.shutdown()); }
});
test("failed active leave preserves connection until it can commit", async () => {
 const ctx = await setup(); try { await begin(ctx); ctx.store.failSave = true; const left = await ctx.engine.command("host", "room:leave", { requestId: "leave" }); assert.equal(left.ok, false); ctx.store.failSave = false; const check = await ctx.engine.command("host", "room:resync", { requestId: "check" }); assert.equal(check.ok, true); assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.hostId, ctx.host.playerId); } finally { ctx.store.failSave = false; await bounded(ctx.engine.shutdown()); }
});
test("disconnect during failed save still pauses and recovers after database returns", async () => {
 const ctx = await setup(); try { await begin(ctx); ctx.store.failSave = true; await ctx.engine.disconnect("host").catch(() => {}); ctx.store.failSave = false; await wait(60); const state = await ctx.engine.resume(ctx.code, ctx.other.resumeToken); assert.notEqual(state.snapshot.hostId, ctx.host.playerId); assert.notEqual(state.snapshot.phase, "drawing"); } finally { ctx.store.failSave = false; await bounded(ctx.engine.shutdown()); }
});
test("archive outage never blocks resync or shutdown", async () => {
 const ctx = await setup(); try { const { game, word } = await begin(ctx); ctx.store.failArchive = true; const draw = await ctx.engine.command("host", "room:drawing", { requestId: "draw", generation: game.generation, payload: { roomCode: ctx.code, canvasId: game.canvasId, generation: game.generation, streamId: "s", clientSeq: [1, 1], operations: [{ type: "stroke.start", opId: "op", actionId: "a", at: 1, settings: { tool: "brush", color: "#123456", size: 12 }, point: { x: 1, y: 1, time: 1 }, clientSeq: 1 }] } }); assert.equal(draw.ok, true); const guess = ctx.engine.command("other", "room:guess", { requestId: "guess", generation: game.generation, payload: { text: word } }); await wait(20); const sync = await bounded(ctx.engine.command("host", "room:resync", { requestId: "sync" })); assert.equal(sync.ok, true); await bounded(ctx.engine.shutdown()); await bounded(guess); } finally { ctx.store.failArchive = false; await bounded(ctx.engine.shutdown()); }
});
test("finalization failure holds round and commits score exactly once after recovery", async () => {
 const ctx = await setup(); try { const { game, word } = await begin(ctx); ctx.store.failFinalize = true; const first = await bounded(ctx.engine.command("other", "room:guess", { requestId: "solve", generation: game.generation, payload: { text: word } })); assert.equal(first.ok, false); assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.phase, "drawing"); assert.equal(ctx.store.turns.size, 0); ctx.store.failFinalize = false; const retry = await bounded(ctx.engine.command("other", "room:guess", { requestId: "solve", generation: game.generation, payload: { text: word } })); assert.equal(retry.ok, true); assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.phase, "result"); assert.equal(ctx.store.turns.size, 1); await ctx.engine.command("other", "room:guess", { requestId: "solve", generation: game.generation, payload: { text: word } }); assert.equal(ctx.store.turns.size, 1); } finally { ctx.store.failFinalize = false; await bounded(ctx.engine.shutdown()); }
});

test("failed timer save does not expose an uncommitted phase and retries after recovery", async () => {
 const store = new FailingStore(); const engine = new RoomEngine({ store, eventSink: () => {}, config: { chooseMs: 30, drawMs: 2000, recapMs: 2000, graceMs: 30 } });
 try { const host = await engine.create(profile); const other = await engine.join(host.snapshot.code, { ...profile, name: "Other" }); const code = host.snapshot.code; await engine.connect(code, host.resumeToken, "host"); await engine.connect(code, other.resumeToken, "other"); const state = await engine.resume(code, host.resumeToken); assert.equal((await engine.command("host", "room:start", { requestId: "start", expectedRevision: state.snapshot.revision })).ok, true); store.failSave = true; await wait(75); assert.equal((await engine.resume(code, host.resumeToken)).snapshot.phase, "choosing"); store.failSave = false; await wait(1100); assert.equal((await engine.resume(code, host.resumeToken)).snapshot.phase, "drawing"); } finally { store.failSave = false; await bounded(engine.shutdown()); }
});
test("host is recoverable when others left and the last remaining player reconnects", async () => {
 const ctx = await setup(); try { const third = await ctx.engine.join(ctx.code, { ...profile, name: "Third" }); await ctx.engine.connect(ctx.code, third.resumeToken, "third"); await begin(ctx); assert.equal((await ctx.engine.command("other", "room:leave", { requestId: "other-leaves" })).ok, true); await ctx.engine.disconnect("third"); assert.equal((await ctx.engine.command("host", "room:leave", { requestId: "host-leaves" })).ok, true); await ctx.engine.connect(ctx.code, third.resumeToken, "third-again"); await wait(70); const state = await ctx.engine.resume(ctx.code, third.resumeToken); assert.equal(state.snapshot.hostId, third.playerId); } finally { ctx.store.failSave = false; await bounded(ctx.engine.shutdown()); }
});
