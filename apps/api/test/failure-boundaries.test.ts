import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomEngine as ProductionRoomEngine } from "../src/game/engine";
class RoomEngine extends ProductionRoomEngine {
  constructor(options: ConstructorParameters<typeof ProductionRoomEngine>[0]) { super({ ...options, config: { ...options.config, startMs: 0 } }); }
}
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
async function setup(drawMs = 2000) {
 const store = new FailingStore(); const engine = new RoomEngine({ store, eventSink: () => {}, config: { chooseMs: 2000, drawMs, recapMs: 2000, graceMs: 30 } });
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
 const ctx = await setup(); try { const { game, word } = await begin(ctx); ctx.store.failFinalize = true; const first = await bounded(ctx.engine.command("other", "room:guess", { requestId: "solve", generation: game.generation, payload: { text: word } })); assert.equal(first.ok, false); assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.phase, "drawing"); assert.deepEqual((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.aiHistory, []); assert.equal(ctx.store.turns.size, 0); ctx.store.failFinalize = false; const retry = await bounded(ctx.engine.command("other", "room:guess", { requestId: "solve", generation: game.generation, payload: { text: word } })); assert.equal(retry.ok, true); assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.phase, "result"); assert.equal(ctx.store.turns.size, 1); assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.aiHistory?.length, 1); await ctx.engine.command("other", "room:guess", { requestId: "solve", generation: game.generation, payload: { text: word } }); assert.equal(ctx.store.turns.size, 1); } finally { ctx.store.failFinalize = false; await bounded(ctx.engine.shutdown()); }
});

test("failed timer save does not expose an uncommitted phase and retries after recovery", async () => {
 const store = new FailingStore(); const engine = new RoomEngine({ store, eventSink: () => {}, config: { chooseMs: 30, drawMs: 2000, recapMs: 2000, graceMs: 30 } });
 try { const host = await engine.create(profile); const other = await engine.join(host.snapshot.code, { ...profile, name: "Other" }); const code = host.snapshot.code; await engine.connect(code, host.resumeToken, "host"); await engine.connect(code, other.resumeToken, "other"); const state = await engine.resume(code, host.resumeToken); assert.equal((await engine.command("host", "room:start", { requestId: "start", expectedRevision: state.snapshot.revision })).ok, true); store.failSave = true; await wait(75); assert.equal((await engine.resume(code, host.resumeToken)).snapshot.phase, "choosing"); store.failSave = false; await wait(1100); assert.equal((await engine.resume(code, host.resumeToken)).snapshot.phase, "drawing"); } finally { store.failSave = false; await bounded(engine.shutdown()); }
});
test("host is recoverable when others left and the last remaining player reconnects", async () => {
 const ctx = await setup(); try { const third = await ctx.engine.join(ctx.code, { ...profile, name: "Third" }); await ctx.engine.connect(ctx.code, third.resumeToken, "third"); await begin(ctx); assert.equal((await ctx.engine.command("other", "room:leave", { requestId: "other-leaves" })).ok, true); await ctx.engine.disconnect("third"); assert.equal((await ctx.engine.command("host", "room:leave", { requestId: "host-leaves" })).ok, true); await ctx.engine.connect(ctx.code, third.resumeToken, "third-again"); await wait(70); const state = await ctx.engine.resume(ctx.code, third.resumeToken); assert.equal(state.snapshot.hostId, third.playerId); } finally { ctx.store.failSave = false; await bounded(ctx.engine.shutdown()); }
});

test("archive drain wakes finalization without the one-second poll", async () => {
  const ctx = await setup();
  let releaseArchive!: () => void;
  const archiveGate = new Promise<void>(resolve => { releaseArchive = resolve; });
  let enteredFinalize!: () => void;
  const finalized = new Promise<void>(resolve => { enteredFinalize = resolve; });
  const append = ctx.store.appendDrawing.bind(ctx.store);
  const finalize = ctx.store.finalizeTurn.bind(ctx.store);
  ctx.store.appendDrawing = async record => {
    await archiveGate;
    await append(record);
  };
  ctx.store.finalizeTurn = async turn => {
    enteredFinalize();
    await finalize(turn);
  };
  try {
    const { game, word } = await begin(ctx);
    const drawing = await ctx.engine.command("host", "room:drawing", {
      requestId: "drain-draw", generation: game.generation,
      payload: {
        roomCode: ctx.code, canvasId: game.canvasId,
        generation: game.generation, streamId: "drain-stream",
        clientSeq: [1, 1],
        operations: [{
          type: "canvas.clear", opId: "drain-op", actionId: "drain-action",
          at: 1, clientSeq: 1,
        }],
      },
    });
    assert.equal(drawing.ok, true);
    const solve = await ctx.engine.command("other", "room:guess", {
      requestId: "drain-solve", generation: game.generation,
      payload: { text: word },
    });
    assert.equal(solve.ok, true);
    assert.equal(ctx.store.turns.size, 0);
    const pending = (await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot;
    assert.equal(pending.phase, "drawing");
    assert.equal(pending.game?.closing, true);
    assert.equal((await ctx.engine.command("host", "room:chat", { requestId: "closing-general", payload: { text: "Good game" } })).ok, true);
    assert.equal((await ctx.engine.command("host", "room:chat", { requestId: "closing-secret", payload: { text: word } })).code, "secret");
    assert.equal(pending.game?.result, undefined);
    assert.ok(Object.values(pending.game!.scores).every(score => score === 0));
    releaseArchive();
    await bounded(finalized, 500);
    await bounded(ctx.engine.command("host", "room:resync", {
      requestId: "drain-sync",
    }));
    assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.phase, "result");
    assert.equal(ctx.store.turns.size, 1);
    await wait(30);
    assert.equal(ctx.store.turns.size, 1);
  } finally {
    releaseArchive();
    ctx.store.failSave = false;
    ctx.store.failArchive = false;
    ctx.store.failFinalize = false;
    await bounded(ctx.engine.shutdown());
  }
});

test("a stalled room save queues resync until the save settles", async () => {
  const ctx = await setup();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const save = ctx.store.saveRoom.bind(ctx.store);
  try {
    const { game } = await begin(ctx);
    ctx.store.saveRoom = async room => { entered(); await gate; await save(room); };
    const guess = ctx.engine.command("other", "room:guess", { requestId: "waiting-guess", generation: game.generation, payload: { text: "unlikely incorrect answer" } });
    await bounded(started);
    const sync = ctx.engine.command("host", "room:resync", { requestId: "waiting-sync" });
    await assert.rejects(bounded(sync, 50), /operation hung/);
    release();
    assert.equal((await bounded(guess)).ok, true);
    assert.equal((await bounded(sync)).ok, true);
  } finally { release(); await bounded(ctx.engine.shutdown()); }
});

test("drained archive finalization failure retains closing state and retries once", async () => {
  const ctx = await setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const append = ctx.store.appendDrawing.bind(ctx.store);
  ctx.store.appendDrawing = async record => { await gate; await append(record); };
  try {
    const { game, word } = await begin(ctx);
    assert.equal((await ctx.engine.command("host", "room:drawing", { requestId: "failure-draw", generation: game.generation, payload: {
      roomCode: ctx.code, canvasId: game.canvasId, generation: game.generation, streamId: "failure", clientSeq: [1, 1],
      operations: [{ type: "canvas.clear", opId: "failure-op", actionId: "failure-action", at: 1, clientSeq: 1 }],
    } })).ok, true);
    assert.equal((await ctx.engine.command("other", "room:guess", { requestId: "failure-solve", generation: game.generation, payload: { text: word } })).ok, true);
    ctx.store.failFinalize = true;
    release();
    await wait(50);
    const held = (await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot;
    assert.equal(held.phase, "drawing");
    assert.equal(held.game?.closing, true);
    assert.equal(held.game?.saving, "blocked");
    assert.equal(held.game?.result, undefined);
    assert.ok(Object.values(held.game!.scores).every(score => score === 0));
    ctx.store.failFinalize = false;
    await wait(1100);
    assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.phase, "result");
    assert.equal(ctx.store.turns.size, 1);
  } finally { release(); ctx.store.failFinalize = false; await bounded(ctx.engine.shutdown()); }
});

test("failed closing solve does not archive a stroke end before retry", async () => {
  const ctx = await setup();
  try {
    const { game, word } = await begin(ctx);
    const batch = (sequence: number, operation: object) => ({ roomCode: ctx.code, canvasId: game.canvasId, generation: game.generation, streamId: "rollback", clientSeq: [sequence, sequence], operations: [operation] });
    const start = { type: "stroke.start", opId: "rollback-start", actionId: "rollback-action", at: 1, clientSeq: 1, point: { x: 1, y: 1, time: 1 }, settings: { tool: "brush", color: "#123456", size: 2 } };
    assert.equal((await ctx.engine.command("host", "room:drawing", { requestId: "rollback-draw", generation: game.generation, payload: batch(1, start) })).ok, true);
    ctx.store.failSave = true;
    assert.equal((await ctx.engine.command("other", "room:guess", { requestId: "rollback-solve", generation: game.generation, payload: { text: word } })).ok, false);
    assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.game?.closing, false);
    assert.deepEqual(ctx.store.drawings.flatMap(row => row.operations).map(op => op.type), ["stroke.start"]);
    ctx.store.failSave = false;
    assert.equal((await ctx.engine.command("other", "room:guess", { requestId: "rollback-solve", generation: game.generation, payload: { text: word } })).ok, true);
    await wait(30);
    assert.deepEqual(ctx.store.drawings.flatMap(row => row.operations).map(op => op.type), ["stroke.start", "stroke.end"]);
    assert.equal(ctx.store.turns.size, 1);
  } finally { ctx.store.failSave = false; await bounded(ctx.engine.shutdown()); }
});

test("archive draining during closing save still wakes finalization", async () => {
  const ctx = await setup();
  let releaseArchive!: () => void;
  let releaseSave!: () => void;
  let enteredSave!: () => void;
  const archiveGate = new Promise<void>(resolve => { releaseArchive = resolve; });
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  const saveEntered = new Promise<void>(resolve => { enteredSave = resolve; });
  const append = ctx.store.appendDrawing.bind(ctx.store);
  const save = ctx.store.saveRoom.bind(ctx.store);
  ctx.store.appendDrawing = async record => { await archiveGate; await append(record); };
  try {
    const { game, word } = await begin(ctx);
    assert.equal((await ctx.engine.command("host", "room:drawing", { requestId: "save-race-draw", generation: game.generation, payload: {
      roomCode: ctx.code, canvasId: game.canvasId, generation: game.generation, streamId: "save-race", clientSeq: [1, 1],
      operations: [{ type: "canvas.clear", opId: "save-race-op", actionId: "save-race-action", at: 1, clientSeq: 1 }],
    } })).ok, true);
    ctx.store.saveRoom = async room => { enteredSave(); await saveGate; await save(room); };
    const solve = ctx.engine.command("other", "room:guess", { requestId: "save-race-solve", generation: game.generation, payload: { text: word } });
    await bounded(saveEntered);
    releaseArchive();
    await wait(20);
    assert.equal(ctx.store.turns.size, 0);
    releaseSave();
    assert.equal((await bounded(solve)).ok, true);
    for (let n = 0; n < 50 && !ctx.store.turns.size; n++) await wait(5);
    assert.equal(ctx.store.turns.size, 1);
    assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.phase, "result");
  } finally { releaseArchive(); releaseSave(); await bounded(ctx.engine.shutdown()); }
});

for (const failure of ["none", "save", "finalize"] as const) {
  test(`deadline closes a held stroke safely through ${failure} failure`, async () => {
    const ctx = await setup(250);
    try {
      const { game } = await begin(ctx);
      assert.equal((await ctx.engine.command("host", "room:drawing", { requestId: "deadline-stroke", generation: game.generation, payload: {
        roomCode: ctx.code, canvasId: game.canvasId, generation: game.generation, streamId: "deadline", clientSeq: [1, 1],
        operations: [{ type: "stroke.start", opId: "deadline-op", actionId: "held", at: 1, clientSeq: 1, point: { x: 3, y: 4, time: 1 }, settings: { tool: "brush", color: "#123456", size: 2 } }],
      } })).ok, true);
      ctx.store.failSave = failure === "save";
      ctx.store.failFinalize = failure === "finalize";
      await wait(350);
      const view = (await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot;
      if (failure === "save") {
        assert.deepEqual(ctx.store.drawings.flatMap(row => row.operations).map(op => (op as { type: string }).type), ["stroke.start"]);
        assert.equal(view.game?.closing, false, "a failed closing save must roll back before archiving");
      } else {
        assert.deepEqual(ctx.store.drawings.flatMap(row => row.operations).map(op => (op as { type: string }).type), ["stroke.start", "stroke.end"]);
        if (failure === "finalize") {
          assert.equal(view.phase, "drawing");
          assert.equal(view.game?.closing, true, "finalization failure must retain the committed closing state");
        }
      }
      ctx.store.failSave = false;
      ctx.store.failFinalize = false;
      if (failure !== "none") await wait(1100);
      assert.equal((await ctx.engine.resume(ctx.code, ctx.host.resumeToken)).snapshot.phase, "result");
      assert.deepEqual(ctx.store.drawings.flatMap(row => row.operations).map(op => (op as { type: string }).type), ["stroke.start", "stroke.end"]);
      assert.equal(ctx.store.turns.size, 1);
    } finally { ctx.store.failSave = false; ctx.store.failFinalize = false; await bounded(ctx.engine.shutdown()); }
  });
}


test("failed leave during countdown preserves the start and lease atomically", async () => {
  const store = new FailingStore();
  const engine = new ProductionRoomEngine({ store, eventSink: () => {}, config: { startMs: 10000 } });
  try {
    const host = await engine.create(profile);
    const guest = await engine.join(host.snapshot.code, { ...profile, name: "Guest" });
    await engine.connect(host.snapshot.code, host.resumeToken, "countdown-host");
    await engine.connect(host.snapshot.code, guest.resumeToken, "countdown-guest");
    let lobby = await engine.resume(host.snapshot.code, host.resumeToken);
    assert.equal((await engine.command("countdown-host", "room:settings", { requestId: "settings", expectedRevision: lobby.snapshot.revision, payload: { ...lobby.snapshot.settings, seats: 2 } })).ok, true);
    lobby = await engine.resume(host.snapshot.code, host.resumeToken);
    assert.equal((await engine.command("countdown-host", "room:start", { requestId: "start", expectedRevision: lobby.snapshot.revision })).ok, true);
    store.failSave = true;
    assert.equal((await engine.command("countdown-guest", "room:leave", { requestId: "leave" })).ok, false);
    store.failSave = false;
    assert.equal((await engine.resume(host.snapshot.code, host.resumeToken)).snapshot.phase, "starting");
    assert.equal((await engine.command("countdown-guest", "room:resync", { requestId: "resync" })).ok, true);
    assert.equal((await engine.command("countdown-guest", "room:leave", { requestId: "leave" })).ok, true);
    assert.equal((await engine.resume(host.snapshot.code, host.resumeToken)).snapshot.phase, "lobby");
    const replacement = await engine.join(host.snapshot.code, { ...profile, name: "Replacement" });
    assert.equal(replacement.snapshot.players.length, 2);
  } finally { store.failSave = false; await engine.shutdown(); }
});
