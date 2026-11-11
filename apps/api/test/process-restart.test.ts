import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { io, type Socket } from "socket.io-client";
import { PrismaGameStore } from "../src/store";

const base = "http://127.0.0.1:3103";
const profile = { name: "Restart Host", avatar: { shape: "pebble", expression: "smile", color: "cyan" } };
const delay = (ms: number) => new Promise<void>(resolveDelay => setTimeout(resolveDelay, ms));
async function eventually<T>(action: () => Promise<T>, accept: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout; let last: T | undefined;
  while (Date.now() < deadline) { try { last = await action(); if (accept(last)) return last; } catch { /* Server may still be starting. */ } await delay(40); }
  throw new Error("Timed out waiting for the expected server state.");
}
function child(): ChildProcess {
  return spawn(process.execPath, [resolve("dist/apps/api/src/main.js")], { windowsHide: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL!, PORT: "3103", WEB_ORIGINS: "http://localhost:3100", GAME_CHOOSE_MS: "5000", GAME_DRAW_MS: "10000", GAME_RECAP_MS: "100", GAME_GRACE_MS: "2000" } });
}
async function stop(processHandle: ChildProcess) { if (processHandle.exitCode !== null || processHandle.signalCode !== null) return; const exited = new Promise<void>(resolveExit => processHandle.once("exit", () => resolveExit())); processHandle.kill("SIGKILL"); await exited; }
async function ready() { await eventually(() => fetch(`${base}/api/health`), response => response.ok); }
async function request(path: string, init?: RequestInit) { const response = await fetch(`${base}${path}`, init); assert.equal(response.ok, true, `HTTP ${response.status} on ${path}`); return response.json(); }
async function resume(code: string, token: string) { return request(`/api/rooms/${code}/resume`, { headers: { authorization: `Bearer ${token}` } }); }
async function socket(code: string, token: string): Promise<Socket> { const client = io(base, { auth: { code, token }, transports: ["websocket"], reconnection: false }); await new Promise<void>((resolveConnect, reject) => { client.once("connect", () => resolveConnect()); client.once("connect_error", reject); }); return client; }
async function command(client: Socket, name: string, envelope: object): Promise<{ ok: boolean; code?: string; sequence?: number }> { return new Promise((resolveAck, reject) => client.timeout(3000).emit(name, envelope, (error: Error | null, ack: { ok: boolean; code?: string; sequence?: number }) => error ? reject(error) : resolveAck(ack))); }

test("actual server restart restores durable interrupted sketch and committed scores", { timeout: 25000 }, async () => {
  assert.ok(process.env.TEST_DATABASE_URL); const dbUrl = new URL(process.env.TEST_DATABASE_URL); assert.equal(dbUrl.hostname, "127.0.0.1"); assert.equal(dbUrl.port, "55437"); assert.equal(dbUrl.pathname, "/mtmai_test");
  const probe = createServer();
  await new Promise<void>((resolveProbe, reject) => { probe.once("error", reject); probe.listen(3103, "127.0.0.1", () => probe.close(() => resolveProbe())); });
  const store = new PrismaGameStore(process.env.TEST_DATABASE_URL); let current: ChildProcess | undefined; let code: string | undefined; const clients: Socket[] = [];
  try {
    current = child(); await ready();
    const host = await request("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile }) }); code = host.snapshot.code;
    const other = await request(`/api/rooms/${code}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: { ...profile, name: "Restart Other" } }) });
    const a = await socket(code!, host.resumeToken); const b = await socket(code!, other.resumeToken); clients.push(a, b);
    let state = await resume(code!, host.resumeToken);
    assert.equal((await command(a, "room:start", { requestId: "start", expectedRevision: state.snapshot.revision })).ok, true);
    state = await eventually(() => resume(code!, host.resumeToken), s => s.snapshot.phase === "choosing"); assert.equal(state.snapshot.phase, "choosing"); assert.equal(state.privateState.promptOptions.length, 3);
    let generation = state.snapshot.game.generation; let word = state.privateState.promptOptions[0].id;
    assert.equal((await command(a, "room:choose-prompt", { requestId: "choose1", generation, payload: { id: word } })).ok, true);
    assert.equal((await command(b, "room:guess", { requestId: "solve1", generation, payload: { text: word } })).ok, true);
    const choosing2 = await eventually(() => resume(code!, other.resumeToken), s => s.snapshot.phase === "choosing" && s.snapshot.game.position.round === 2);
    assert.equal(choosing2.privateState.promptOptions.length, 3); generation = choosing2.snapshot.game.generation; word = choosing2.privateState.promptOptions[0].id;
    const scores = choosing2.snapshot.game.scores;
    const history = choosing2.snapshot.aiHistory;
    assert.equal(history.length, 1);
    assert.equal(await store.db.turnResult.count({ where: { roomCode: code } }), 1);
    assert.ok(Object.values(scores).some(value => typeof value === "number" && value > 0));
    assert.equal((await command(b, "room:choose-prompt", { requestId: "choose2", generation, payload: { id: word } })).ok, true);
    const game = (await resume(code!, other.resumeToken)).snapshot.game;
    const operation = { type: "stroke.start", opId: "restart-op", actionId: "restart-action", at: 1, settings: { tool: "brush", color: "#123456", size: 12 }, point: { x: 11, y: 12, time: 1 }, clientSeq: 1 };
    const accepted = await command(b, "room:drawing", { requestId: "draw", generation, payload: { roomCode: code, canvasId: game.canvasId, generation, streamId: "restart-stream", clientSeq: [1, 1], operations: [operation] } }); assert.equal(accepted.ok, true); assert.equal(accepted.sequence, 1);
    await eventually(() => resume(code!, other.resumeToken), s => s.snapshot.game.sync.durableSequence >= 1);
    await stop(current); current = undefined; clients.forEach(client => client.close()); clients.length = 0;
    current = child(); await ready();
    const restoredHost = await resume(code!, host.resumeToken); const restoredOther = await resume(code!, other.resumeToken);
    assert.equal(await store.db.turnResult.count({ where: { roomCode: code } }), 1);
    assert.deepEqual(restoredHost.snapshot.aiHistory, history);
    assert.equal(restoredHost.snapshot.phase, "interrupted"); assert.equal(restoredOther.snapshot.game.position.round, 2); assert.equal(restoredOther.snapshot.game.drawerId, other.playerId); assert.deepEqual(restoredOther.snapshot.game.scores, scores);
    const saved = await request(`/api/rooms/${code}/interrupted/${game.canvasId}/${generation}`, { headers: { authorization: `Bearer ${other.resumeToken}` } }); assert.equal(saved.sequence, 1); assert.deepEqual(saved.operations, [operation]);
    const forbidden = await fetch(`${base}/api/rooms/${code}/interrupted/${game.canvasId}/${generation}`, { headers: { authorization: "Bearer invalid" } }); assert.equal(forbidden.status, 401);
    const a2 = await socket(code!, host.resumeToken); const b2 = await socket(code!, other.resumeToken); clients.push(a2, b2);
    state = await resume(code!, host.resumeToken); assert.equal((await command(a2, "room:retry-interrupted", { requestId: "retry", expectedRevision: state.snapshot.revision })).ok, true);
    const retry = await resume(code!, other.resumeToken); assert.equal(retry.snapshot.game.position.round, 2); assert.equal(retry.snapshot.game.drawerId, other.playerId); assert.notEqual(retry.snapshot.game.generation, generation); assert.equal(retry.privateState.promptOptions.length, 3); assert.ok(retry.privateState.promptOptions.every((option: { id: string }) => option.id !== word)); assert.deepEqual(retry.snapshot.game.scores, scores);
    const stale = await command(b2, "room:choose-prompt", { requestId: "old-generation", generation, payload: { id: word } }); assert.equal(stale.code, "stale-generation");
    assert.equal(await store.db.turnResult.count({ where: { roomCode: code } }), 1);
    const savedAgain = await request(`/api/rooms/${code}/interrupted/${game.canvasId}/${generation}`, { headers: { authorization: `Bearer ${other.resumeToken}` } }); assert.deepEqual(savedAgain.operations, [operation]);
  } finally {
    clients.forEach(client => client.close()); if (current) await stop(current);
    if (code) { await store.db.drawing.deleteMany({ where: { roomCode: code } }); await store.db.turnResult.deleteMany({ where: { roomCode: code } }); await store.db.room.deleteMany({ where: { code } }); } await store.close();
  }
});
