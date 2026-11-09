import { test } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { createApplication } from "../src/app";
import { PrismaGameStore } from "../src/store";
import type { AddressInfo } from "node:net";

test("production HTTP and socket routes authenticate and enforce origins", async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const url = new URL(process.env.TEST_DATABASE_URL); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55437"); assert.equal(url.pathname, "/mtmai_test");
  const store = new PrismaGameStore(process.env.TEST_DATABASE_URL);
  const service = await createApplication({ store, origins: ["http://localhost:3100"] });
  let code: string | undefined;
  try {
    await service.app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${(service.app.getHttpServer().address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/rooms`, { method: "POST", headers: { origin: "http://bad.invalid", "content-type": "application/json" }, body: "{}" })).status, 403);
    const created = await fetch(`${base}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: { name: "Tester", avatar: { shape: "pebble", expression: "smile", color: "cyan" } } }) });
    assert.equal(created.status, 201); const session = await created.json(); code = session.snapshot.code;
    assert.equal((await fetch(`${base}/api/rooms/${code}/resume`)).status, 401);
    const badOrigin = io(base, { auth: { code, token: session.resumeToken }, transports: ["websocket"], extraHeaders: { Origin: "http://bad.invalid" }, reconnection: false });
    await new Promise<void>((resolve, reject) => { badOrigin.once("connect", () => reject(new Error("Forbidden origin connected"))); badOrigin.once("connect_error", () => resolve()); }); badOrigin.close();
    const invalid = io(base, { auth: { code, token: "invalid" }, transports: ["websocket"], reconnection: false });
    await new Promise<void>((resolve, reject) => { invalid.once("connect", () => reject(new Error("Invalid token connected"))); invalid.once("connect_error", () => resolve()); }); invalid.close();
    const socket = io(base, { auth: { code, token: session.resumeToken }, transports: ["websocket"] });
    try {
      await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("connect_error", reject); });
      const ack: { ok: boolean } = await new Promise((resolve, reject) => socket.timeout(3000).emit("room:resync", { requestId: "test-resync" }, (error: Error | null, result: { ok: boolean }) => error ? reject(error) : resolve(result)));
      assert.equal(ack.ok, true);
    } finally { socket.disconnect(); }
  } finally {
    await service.close();
    if (code) { await store.db.drawing.deleteMany({ where: { roomCode: code } }); await store.db.turnResult.deleteMany({ where: { roomCode: code } }); await store.db.room.deleteMany({ where: { code } }); }
    await store.close();
  }
});
