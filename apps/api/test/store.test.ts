import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaGameStore } from "../src/store";

test("Postgres journal and turn finalization are durable and idempotent", async () => {
  assert.ok(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL is required");
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55437"); assert.equal(url.pathname, "/mtmai_test");
  const store = new PrismaGameStore(process.env.TEST_DATABASE_URL);
  const code = `test-${randomUUID()}`;
  try {
    await store.saveRoom({ code, state: { revision: 1 } });
    const drawing = { roomCode: code, canvasId: "canvas", generation: 1, sequence: 1, operations: [{ type: "test" }] };
    await store.appendDrawing(drawing); await store.appendDrawing(drawing);
    assert.deepEqual(await store.loadDrawing(code, "canvas", 1), [drawing]);
    await assert.rejects(store.appendDrawing({ ...drawing, operations: [{ type: "different" }] }), /Conflicting drawing journal payload/);
    assert.deepEqual(await store.loadDrawing(code, "canvas", 1), [drawing]);
    const result = { room: { code, state: { revision: 2 } }, turnId: code, generation: 1, results: { score: 10, details: { first: 1, second: 2 } } };
    await store.finalizeTurn(result);
    await store.finalizeTurn({ ...result, room: { code, state: { revision: 999 } }, results: { details: { second: 2, first: 1 }, score: 10 } });
    await assert.rejects(store.finalizeTurn({ ...result, results: { score: 11 } }), /Conflicting finalized turn payload/);
    await assert.rejects(store.finalizeTurn({ ...result, room: { code: `${code}-other`, state: {} } }), /Conflicting finalized turn payload/);
    assert.deepEqual((await store.loadRooms()).find(room => room.code === code)?.state, { revision: 2 });
    assert.equal(await store.db.turnResult.count({ where: { turnId: code } }), 1);
  } finally {
    await store.db.drawing.deleteMany({ where: { roomCode: code } });
    await store.db.turnResult.deleteMany({ where: { roomCode: code } });
    await store.db.room.deleteMany({ where: { code } });
    await store.close();
  }
});
