import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client } from "pg";
import { PrismaGameStore } from "../src/store";

/** A real row lock must cancel on the database before it consumes a socket ACK budget. */
test("Postgres cancels a blocked room write and permits a safe retry", { timeout: 15000 }, async () => {
  assert.ok(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL is required");
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55437");
  assert.equal(url.pathname, "/mtmai_test");
  const store = new PrismaGameStore(process.env.TEST_DATABASE_URL);
  const locker = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const code = `timeout-${randomUUID()}`;
  let release: Promise<unknown> | undefined;
  try {
    await store.saveRoom({ code, state: { revision: 1 } });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query('UPDATE "Room" SET state = state WHERE code = $1', [code]);
    // Release eventually even against the old unbounded implementation, so RED is a
    // missing cancellation assertion rather than a test runner hanging forever.
    release = new Promise<void>(resolve => setTimeout(resolve, 3000)).then(() => locker.query("ROLLBACK"));
    const start = performance.now();
    await assert.rejects(store.saveRoom({ code, state: { revision: 2 } }));
    assert.ok(performance.now() - start < 2500, "blocked write exceeded the cancellation budget");
    await release;
    assert.deepEqual((await store.loadRooms()).find(room => room.code === code)?.state, { revision: 1 });
    await store.saveRoom({ code, state: { revision: 2 } });
    assert.deepEqual((await store.loadRooms()).find(room => room.code === code)?.state, { revision: 2 });
  } finally {
    if (release) await release;
    await locker.end();
    await store.db.room.deleteMany({ where: { code } });
    await store.close();
  }
});
