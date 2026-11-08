import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Inference, Job, Outcome } from "../ai/client";
import { MemoryGameStore } from "../store";
import { RoomEngine } from "./engine";
import { PROMPTS } from "./prompts";
import { DEFAULT_AVATAR } from "../../../../packages/game-contracts/src/player";

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (condition()) return;
    await delay(20);
  }
  assert.fail("Expected observation never settled");
}

async function fixture(submit: Inference["submit"], render: Inference["render"]) {
  let now = Date.now();
  const initial = now;
  const store = new MemoryGameStore();
  const engine = new RoomEngine({
    store,
    clock: () => now,
    eventSink: () => {},
    inference: {
      options: { firstGuessMs: 5000, guessCooldownMs: 8000, maxGuesses: 5, requestTimeoutMs: 250 },
      ready: role => role === "guesser" ? { modelId: "fixture", artifactRevision: "fixture-v1", labels: PROMPTS.slice() } : undefined,
      render,
      submit,
      close: async () => {},
    },
  });
  const host = await engine.create({ name: "Host", avatar: DEFAULT_AVATAR });
  const code = host.snapshot.code;
  const guest = await engine.join(code, { name: "Guest", avatar: DEFAULT_AVATAR });
  const resume = (token: string) => engine.resume(code, token);
  const send = async (connection: string, name: string, data: object) => {
    const ack = await engine.command(connection, name, { requestId: randomUUID(), ...data });
    assert.equal(ack.ok, true, ack.message);
  };
  await engine.connect(code, host.resumeToken, "host");
  await engine.connect(code, guest.resumeToken, "guest");
  const lobby = await resume(host.resumeToken);
  await send("host", "room:start", { expectedRevision: lobby.snapshot.revision });
  const choice = await resume(host.resumeToken);
  const game = choice.snapshot.game!;
  const target = choice.privateState!.promptOptions![0].label;
  const generation = game.generation;
  await send("host", "room:choose-prompt", { generation, payload: { id: choice.privateState!.promptOptions![0].id } });
  const ink = async (clear = false) => {
    const point = { x: 100, y: 100, time: 0 };
    const base = { opId: randomUUID(), actionId: randomUUID(), at: now, clientSeq: 1 };
    await send("host", "room:drawing", { generation, payload: {
      roomCode: code, canvasId: game.canvasId, generation, streamId: randomUUID(), clientSeq: clear ? [1, 1] : [1, 2],
      operations: clear ? [{ ...base, type: "canvas.clear" }] : [
        { ...base, type: "stroke.start", point, settings: { tool: "brush", color: "#181321", size: 12 } },
        { ...base, opId: randomUUID(), clientSeq: 2, type: "stroke.end", point },
      ],
    } });
  };
  return {
    engine, target, ink,
    advance: (ms: number) => { now = initial + ms; },
    finish: async () => {
      await send("guest", "room:guess", { generation, payload: { text: target } });
      return (await resume(guest.resumeToken)).snapshot.game!.result!;
    },
    guest: () => resume(guest.resumeToken),
  };
}

test("Guesser paces dispatch, caps five observations and reveals each accepted candidate once", async () => {
  const jobs: Job[] = [];
  let renders = 0;
  let wrongAnswer = "";
  const room = await fixture(async (_role, job) => {
    jobs.push(job);
    return { status: "answer", answer: wrongAnswer };
  }, async (_key, operations) => {
    renders++;
    // First prefix is blank, then two prefixes render the same visible pixels.
    if (operations.length === 2) return null;
    return Buffer.from(String(operations.length === 6 ? 4 : operations.length));
  });
  wrongAnswer = PROMPTS.find(word => word !== room.target)!;
  try {
    await room.ink();
    room.advance(4999);
    await delay(260);
    assert.equal(renders, 0);
    room.advance(5000);
    await waitFor(() => renders === 1);
    assert.equal(jobs.length, 0);
    await room.ink();
    await waitFor(() => jobs.length === 1);
    await delay(20);
    await room.ink();
    room.advance(12999);
    await delay(260);
    assert.equal(renders, 2);
    room.advance(13000);
    await waitFor(() => renders === 3);
    assert.equal(jobs.length, 1);
    for (let attempt = 2; attempt <= 5; attempt++) {
      room.advance(5000 + (attempt - 1) * 8000);
      await room.ink();
      await waitFor(() => jobs.length === attempt);
      await delay(20);
    }
    room.advance(45000);
    await room.ink();
    await delay(260);
    assert.equal(jobs.length, 5);
    assert.equal((await room.guest()).snapshot.game!.result, undefined);
    const result = await room.finish();
    assert.deepEqual(result.aiAnswers, [wrongAnswer]);
    assert.equal(result.aiBenchmark?.points, 0);
  } finally { await room.engine.shutdown(); }
});

test("Guesser drops cleared work and marks timed-out evaluation unscored", async () => {
  const jobs: Job[] = [];
  let complete: ((outcome: Outcome) => void) | undefined;
  const room = await fixture((_role, job, _png, signal) => {
    jobs.push(job);
    return new Promise<Outcome>((resolve, reject) => {
      if (jobs.length === 1) complete = resolve;
      else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  }, async (_key, operations) => Buffer.from(String(operations.length)));
  try {
    await room.ink();
    room.advance(5000);
    await waitFor(() => jobs.length === 1);
    await room.ink(true);
    complete!({ status: "answer", answer: room.target });
    room.advance(14000);
    await room.ink();
    await waitFor(() => jobs.length === 2);
    await delay(320);
    const result = await room.finish();
    assert.deepEqual(result.aiAnswers, []);
    assert.equal(result.aiBenchmark?.points, null);
  } finally { await room.engine.shutdown(); }
});
