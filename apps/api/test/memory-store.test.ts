import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryGameStore } from "../src/store";
import { RoomEngine } from "../src/game/engine";

const profile = { name: "Player", avatar: { shape: "pebble", expression: "smile", color: "cyan" } } as const;
test("memory journal enforces contiguous idempotent batches and atomic results", async () => {
  const store = new MemoryGameStore();
  const first = { roomCode: "ROOM", canvasId: "c", generation: 1, sequence: 1, operations: [{ type: "first" }] };
  await store.appendDrawing(first); await store.appendDrawing(first);
  await assert.rejects(store.appendDrawing({ ...first, sequence: 3 }), /Noncontiguous/);
  await assert.rejects(store.appendDrawing({ ...first, operations: [{ type: "other" }] }), /Conflicting/);
  assert.deepEqual(await store.loadDrawing("ROOM", "c", 1), [first]);
  const result = { room: { code: "ROOM", state: { revision: 2 } }, turnId: "t", generation: 1, results: { score: 1 } };
  await store.finalizeTurn(result); await store.finalizeTurn({ ...result, room: { code: "ROOM", state: { revision: 9 } } });
  await assert.rejects(store.finalizeTurn({ ...result, results: { score: 2 } }), /Conflicting/);
  assert.deepEqual((await store.loadRooms())[0].state, { revision: 2 });
  store.deleteRoom("ROOM");
  assert.deepEqual(await store.loadRooms(), []);
  assert.deepEqual(await store.loadDrawing("ROOM", "c", 1), []);
});
test("memory rooms have a capacity and idle rooms expire without evicting leases", async () => {
  let now = 0;
  const store = new MemoryGameStore();
  const engine = new RoomEngine({ store, clock: () => now, eventSink: () => {} });
  try {
    const rooms = await Promise.all(Array.from({ length: 32 }, () => engine.create(profile)));
    await assert.rejects(engine.create(profile), /capacity/);
    await engine.connect(rooms[0].snapshot.code, rooms[0].resumeToken, "active");
    now = 30 * 60 * 1000;
    await engine.create(profile);
    assert.equal((await store.loadRooms()).length, 2);
    await assert.rejects(engine.resume(rooms[1].snapshot.code, rooms[1].resumeToken), /not found/i);
    assert.equal((await engine.resume(rooms[0].snapshot.code, rooms[0].resumeToken)).playerId, rooms[0].playerId);
  } finally { await engine.shutdown(); }
});

test("memory canvas limit rejects the tail without interrupting human scoring", async () => {
  const store = new MemoryGameStore();
  const engine = new RoomEngine({ store, eventSink: () => {} });
  try {
    const host = await engine.create(profile);
    const code = host.snapshot.code;
    const guest = await engine.join(code, { ...profile, name: "Guesser" });
    await engine.connect(code, host.resumeToken, "drawer");
    await engine.connect(code, guest.resumeToken, "guesser");
    let state = await engine.resume(code, host.resumeToken);
    assert.equal((await engine.command("drawer", "room:start", { requestId: "start", expectedRevision: state.snapshot.revision })).ok, true);
    state = await engine.resume(code, host.resumeToken);
    const game = state.snapshot.game!;
    const target = state.privateState!.promptOptions![0].id;
    assert.equal((await engine.command("drawer", "room:choose-prompt", { requestId: "choose", generation: game.generation, payload: { id: target } })).ok, true);
    const point = { x: 100, y: 100, time: 1 };
    let sequence = 1;
    const start = { type: "stroke.start", opId: "op-1", actionId: "stroke", at: 1, clientSeq: sequence, point, settings: { tool: "brush", color: "#123456", size: 12 } };
    const send = (operation: object, seq: number) => engine.command("drawer", "room:drawing", {
      requestId: `draw-${seq}`, generation: game.generation,
      payload: { roomCode: code, canvasId: game.canvasId, generation: game.generation, streamId: "stream", clientSeq: [seq, seq], operations: [operation] },
    });
    assert.equal((await send(start, sequence)).ok, true);
    let rejected = false;
    for (let seq = 2; seq <= 200; seq++) {
      const append = { type: "stroke.append", opId: `op-${seq}`, actionId: "stroke", at: seq, clientSeq: seq, points: Array.from({ length: 512 }, () => point) };
      const ack = await send(append, seq);
      if (!ack.ok) { assert.equal(ack.code, "drawing-limit"); rejected = true; break; }
      assert.equal(ack.sequence, seq);
      sequence = seq;
    }
    assert.equal(rejected, true, "expected the 1 MiB canvas limit to reject a batch");
    const before = await store.loadDrawing(code, game.canvasId, game.generation);
    assert.deepEqual(before.map(record => record.sequence), Array.from({ length: sequence }, (_, index) => index + 1));
    const after = (await engine.resume(code, host.resumeToken)).snapshot.game!;
    assert.equal(after.sync!.sequence, sequence);
    assert.equal((await engine.command("guesser", "room:guess", { requestId: "solve", generation: game.generation, payload: { text: target } })).ok, true);
    const result = await engine.resume(code, host.resumeToken);
    assert.equal(result.snapshot.phase, "result");
    assert.ok((result.snapshot.game!.scores[guest.playerId] ?? 0) > 0);
    assert.deepEqual(await store.loadDrawing(code, game.canvasId, game.generation), before);
  } finally { await engine.shutdown(); }
});
