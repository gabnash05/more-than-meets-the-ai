import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Inference, Role } from "../src/ai/client";
import { createApplication } from "../src/app";
import { FreeDrawError, FreeDrawService, validateCanonicalPng } from "../src/free-draw/service";
import type { FreeDrawObservation, FreeDrawOutcome } from "../../../packages/game-contracts/src/free-draw";

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function png(includeSrgb = false): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1024, 0);
  header.writeUInt32BE(768, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(768 * (1024 * 4 + 1));
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
  if (includeSrgb) parts.push(chunk("sRGB", Buffer.from([0])));
  parts.push(chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const observation: FreeDrawObservation = {
  runId: "run-a",
  revision: 0,
  requestId: "request-a",
  roles: ["guesser", "referee"],
};

function fakeInference(
  submit: Inference["submit"] = async role => role === "guesser"
    ? { status: "answer", answer: "cat", confidence: 0.9 }
    : { status: "evidence", scores: [0.1, 0.2] },
  timeoutMs = 200,
): Inference {
  return {
    options: { firstGuessMs: 1, guessCooldownMs: 3000, maxGuesses: 1, requestTimeoutMs: timeoutMs },
    ready: (role: Role) => ({
      modelId: `${role}-model`,
      artifactRevision: "test-revision",
      ...(role === "guesser" ? { labels: ["cat", "dog"] } : {}),
    }),
    render: async () => null,
    submit,
    close: async () => undefined,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function expectFreeDrawError(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof FreeDrawError && error.code === code);
}

test("accepts canonical PNG and the allowed color profile chunk", () => {
  assert.equal(validateCanonicalPng(png()), true);
  assert.equal(validateCanonicalPng(png(true)), true);
});

test("authenticates and returns validated, role-specific outcomes", async () => {
  const service = new FreeDrawService(fakeInference());
  const session = service.create();
  const result = await service.infer(session.token, observation, png());
  assert.equal(result.sessionId, session.sessionId);
  assert.deepEqual(result.outcomes.guesser, { status: "answer", answer: "cat", confidence: 0.9 });
  assert.deepEqual(result.outcomes.referee, { status: "evidence", scores: [0.1, 0.2] });
  await expectFreeDrawError(service.infer("wrong", observation, png()), "unauthorized");
  service.close();
});

test("rejects malformed metadata, dimensions, images, duplicate requests, labels and result values", async () => {
  const service = new FreeDrawService(fakeInference(async () => ({ status: "answer", answer: "outside", confidence: 0.9 })));
  const session = service.create();
  await expectFreeDrawError(service.infer(session.token, { ...observation, extra: true } as never, png()), "invalid-observation");
  const badAncillary = Buffer.concat([png().subarray(0, -12), chunk("tEXt", Buffer.from("key\0value")), png().subarray(-12)]);
  await expectFreeDrawError(service.infer(session.token, observation, badAncillary), "invalid-png");
  const wrongDimensions = png();
  wrongDimensions.writeUInt32BE(512, 16);
  await expectFreeDrawError(service.infer(session.token, { ...observation, requestId: "wrong-size" }, wrongDimensions), "invalid-png");
  await expectFreeDrawError(service.infer(session.token, { ...observation, requestId: "too-large" }, Buffer.alloc(4 * 1024 * 1024 + 1)), "invalid-png");
  const invalid = await service.infer(session.token, observation, png());
  assert.deepEqual(invalid.outcomes.guesser, { status: "unavailable", reason: "invalid-result" });
  await expectFreeDrawError(service.infer(session.token, observation, png()), "duplicate-request");
  service.close();

  const badConfidenceService = new FreeDrawService(fakeInference(async () => ({ status: "answer", answer: "cat", confidence: 2 })));
  const badConfidenceSession = badConfidenceService.create();
  const badConfidence = await badConfidenceService.infer(badConfidenceSession.token, observation, png());
  assert.deepEqual(badConfidence.outcomes.guesser, { status: "unavailable", reason: "invalid-result" });
  badConfidenceService.close();
});

test("cooldown and active-observation admission are independent", async () => {
  let now = 10_000;
  const gate = deferred<FreeDrawOutcome>();
  const service = new FreeDrawService(fakeInference(async () => gate.promise, 5000), () => now);
  const session = service.create();
  const first = service.infer(session.token, { ...observation, roles: ["guesser"] }, png());
  await expectFreeDrawError(service.infer(session.token, { ...observation, requestId: "active", roles: ["referee"] }, png()), "cooldown");
  now += 3001;
  await expectFreeDrawError(service.infer(session.token, { ...observation, requestId: "active-2", roles: ["referee"] }, png()), "busy");
  gate.resolve({ status: "pass" });
  await first;
  service.close();
});

test("deadline returns promptly while ignored provider work retains global capacity", async () => {
  const service = new FreeDrawService(fakeInference(() => new Promise(() => undefined), 10));
  const first = service.create();
  const second = service.create();
  const result = await service.infer(first.token, { ...observation, roles: ["guesser"] }, png());
  assert.deepEqual(result.outcomes.guesser, { status: "unavailable", reason: "deadline" });
  await expectFreeDrawError(service.infer(second.token, { ...observation, requestId: "second", roles: ["guesser", "referee"] }, png()), "busy");
  service.close();
});

test("pre-aborted clients do not start providers and disposal aborts provider signals", async () => {
  let submits = 0;
  let observedAbort = false;
  const service = new FreeDrawService(fakeInference((_role, _job, _png, signal) => {
    submits += 1;
    return new Promise(resolve => signal.addEventListener("abort", () => { observedAbort = true; resolve({ status: "unavailable", reason: "cancelled" }); }));
  }, 500));
  const first = service.create();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const result = await service.infer(first.token, { ...observation, roles: ["guesser"] }, png(), alreadyAborted.signal);
  assert.deepEqual(result.outcomes.guesser, { status: "unavailable", reason: "cancelled" });
  assert.equal(submits, 0);

  const second = service.create();
  const active = service.infer(second.token, { ...observation, requestId: "dispose", roles: ["guesser"] }, png());
  await new Promise(resolve => setImmediate(resolve));
  service.dispose(second.token);
  const cancelled = await active;
  assert.deepEqual(cancelled.outcomes.guesser, { status: "unavailable", reason: "cancelled" });
  assert.equal(observedAbort, true);
  service.close();
});

test("rejects provider outcomes that do not match their role", async () => {
  const service = new FreeDrawService(fakeInference(async () => ({ status: "pass" })));
  const session = service.create();
  const result = await service.infer(session.token, observation, png());
  assert.deepEqual(result.outcomes.guesser, { status: "pass" });
  assert.deepEqual(result.outcomes.referee, { status: "unavailable", reason: "invalid-result" });
  await expectFreeDrawError(service.infer(session.token, { ...observation, roles: ["guesser", "guesser"] } as never, png()), "invalid-observation");
  service.close();
});

test("session limit is hard and lazy cleanup expires idle sessions", () => {
  let now = 10_000;
  const service = new FreeDrawService(fakeInference(), () => now);
  for (let i = 0; i < 256; i += 1) service.create();
  assert.throws(() => service.create(), (error: unknown) => error instanceof FreeDrawError && error.code === "capacity");
  now += 15 * 60_000;
  assert.ok(service.create().token);
  service.close();
});

test("HTTP API creates sessions, authorizes capabilities and inference, throttles, and disposes", async () => {
  const service = await createApplication({ inference: fakeInference(), storeMode: "memory", origins: ["http://allowed.example"] });
  await service.app.listen(0, "127.0.0.1");
  const address = service.app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { origin: "http://allowed.example" };
  try {
    const created = await fetch(`${base}/api/free-draw/sessions`, { method: "POST", headers });
    assert.equal(created.status, 201);
    const session = await created.json() as { sessionId: string; token: string };
    const auth = { ...headers, authorization: `Bearer ${session.token}` };
    assert.equal((await fetch(`${base}/api/free-draw/capabilities`, { headers: auth })).status, 200);

    const post = (requestId: string) => fetch(`${base}/api/free-draw/infer`, {
      method: "POST",
      headers: { ...auth, "content-type": "image/png", "x-free-draw-observation": JSON.stringify({ ...observation, requestId, roles: ["guesser"] }) },
      body: png(),
    });
    const inferred = await post("http-1");
    assert.equal(inferred.status, 201);
    assert.equal((await inferred.json() as { outcomes: { guesser: { answer: string } } }).outcomes.guesser.answer, "cat");
    const throttled = await post("http-2");
    assert.equal(throttled.status, 429);
    assert.ok(Number(throttled.headers.get("retry-after")) >= 1);

    const missingAuth = await fetch(`${base}/api/free-draw/infer`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: png() });
    assert.equal(missingAuth.status, 401);
    const badOrigin = await fetch(`${base}/api/free-draw/capabilities`, { headers: { authorization: `Bearer ${session.token}`, origin: "http://evil.example" } });
    assert.equal(badOrigin.status, 403);
    const oversized = await fetch(`${base}/api/free-draw/infer`, {
      method: "POST",
      headers: { ...auth, "content-type": "image/png", "x-free-draw-observation": JSON.stringify({ ...observation, requestId: "oversize", roles: ["guesser"] }) },
      body: Buffer.alloc(4 * 1024 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await fetch(`${base}/api/free-draw/sessions/current`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/free-draw/capabilities`, { headers: auth })).status, 401);
  } finally {
    await service.close();
  }
});

test("HTTP response disconnect aborts active provider work", async () => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const inference = fakeInference((_role, _job, _png, signal) => {
    started.resolve();
    return new Promise(resolve => signal.addEventListener("abort", () => {
      aborted.resolve();
      resolve({ status: "unavailable", reason: "cancelled" });
    }, { once: true }));
  }, 5000);
  const service = await createApplication({ inference, storeMode: "memory", origins: ["http://allowed.example"] });
  await service.app.listen(0, "127.0.0.1");
  const address = service.app.getHttpServer().address() as AddressInfo;
  const controller = new AbortController();
  try {
    const created = await fetch(`http://127.0.0.1:${address.port}/api/free-draw/sessions`, { method: "POST" });
    const session = await created.json() as { token: string };
    const response = fetch(`http://127.0.0.1:${address.port}/api/free-draw/infer`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "image/png",
        "x-free-draw-observation": JSON.stringify({ ...observation, roles: ["guesser"] }),
      },
      body: png(),
    }).catch(() => undefined);
    await started.promise;
    controller.abort();
    await aborted.promise;
    await response;
  } finally {
    await service.close();
  }
});
