import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Inference, Job, Outcome } from "../ai/client";
import { MemoryGameStore } from "../store";
import { RoomEngine as ProductionRoomEngine } from "./engine";
class RoomEngine extends ProductionRoomEngine {
  constructor(options: ConstructorParameters<typeof ProductionRoomEngine>[0]) { super({ ...options, config: { ...options.config, startMs: 0 } }); }
}
import { PROMPTS } from "./prompts";
import { DEFAULT_AVATAR } from "../../../../packages/game-contracts/src/player";
import type { RoomEvent, RoomSettings } from "../../../../packages/game-contracts/src/room";

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (condition()) return;
    await delay(20);
  }
  assert.fail("Expected observation never settled");
}

function inferenceFixture(
  submit: Inference["submit"],
  render: Inference["render"],
  referee = false,
  requestTimeoutMs = 250,
) {
  const events: RoomEvent[] = [];
  let now = Date.now();
  const initial = now;
  const store = new MemoryGameStore();
  const engine = new RoomEngine({
    store,
    config: { drawMs: 100000 },
    clock: () => now,
    eventSink: (_id, event) => { events.push(event); },
    inference: {
      options: { firstGuessMs: 1500, guessCooldownMs: 2000, maxGuesses: 24, requestTimeoutMs },
      ready: role => role === "guesser" ? { modelId: "fixture", artifactRevision: "fixture-v1", labels: PROMPTS.slice() } : referee ? { modelId: "referee", artifactRevision: "fixture-v1" } : undefined,
      render,
      submit,
      close: async () => {},
    },
  });
  return { engine, events, advance: (ms: number) => { now = initial + ms; } };
}

async function startRoom(
  engine: RoomEngine,
  key: string,
  switches?: Pick<RoomSettings, "aiGuesserEnabled" | "aiRefereeEnabled">,
) {
  const hostConnection = `${key}:host`;
  const guestConnection = `${key}:guest`;
  const host = await engine.create({ name: `Host ${key}`, avatar: DEFAULT_AVATAR });
  const code = host.snapshot.code;
  const guest = await engine.join(code, { name: `Guest ${key}`, avatar: DEFAULT_AVATAR });
  const resume = (token: string) => engine.resume(code, token);
  const send = async (connection: string, name: string, data: object) => {
    const ack = await engine.command(connection, name, { requestId: randomUUID(), ...data });
    assert.equal(ack.ok, true, ack.message);
  };
  await engine.connect(code, host.resumeToken, hostConnection);
  await engine.connect(code, guest.resumeToken, guestConnection);
  let lobby = await resume(host.resumeToken);
  assert.equal(lobby.snapshot.settings.aiGuesserEnabled, true);
  assert.equal(lobby.snapshot.settings.aiRefereeEnabled, true);
  if (switches) {
    const { mode, seats, teamCount, seatsPerTeam, rounds } = lobby.snapshot.settings;
    const legacySettings = { mode, seats, teamCount, seatsPerTeam, rounds };
    const settings = { ...legacySettings, ...switches };
    const denied = await engine.command(guestConnection, "room:settings", {
      requestId: randomUUID(), expectedRevision: lobby.snapshot.revision, payload: settings,
    });
    assert.equal(denied.code, "forbidden");
    await send(hostConnection, "room:settings", { expectedRevision: lobby.snapshot.revision, payload: settings });
    lobby = await resume(host.resumeToken);
    await send(hostConnection, "room:settings", { expectedRevision: lobby.snapshot.revision, payload: legacySettings });
    lobby = await resume(host.resumeToken);
    assert.equal(lobby.snapshot.settings.aiGuesserEnabled, switches.aiGuesserEnabled);
    assert.equal(lobby.snapshot.settings.aiRefereeEnabled, switches.aiRefereeEnabled);
  }
  await send(hostConnection, "room:start", { expectedRevision: lobby.snapshot.revision });
  const choice = await resume(host.resumeToken);
  const game = choice.snapshot.game!;
  const target = choice.privateState!.promptOptions![0].label;
  const generation = game.generation;
  await send(hostConnection, "room:choose-prompt", { generation, payload: { id: choice.privateState!.promptOptions![0].id } });
  const ink = async (clear = false) => {
    const point = { x: 100, y: 100, time: 0 };
    const base = { opId: randomUUID(), actionId: randomUUID(), at: Date.now(), clientSeq: 1 };
    await send(hostConnection, "room:drawing", { generation, payload: {
      roomCode: code, canvasId: game.canvasId, generation, streamId: randomUUID(), clientSeq: clear ? [1, 1] : [1, 2],
      operations: clear ? [{ ...base, type: "canvas.clear" }] : [
        { ...base, type: "stroke.start", point, settings: { tool: "brush", color: "#181321", size: 12 } },
        { ...base, opId: randomUUID(), clientSeq: 2, type: "stroke.end", point },
      ],
    } });
  };
  return {
    engine, code, target, ink, generation, canvasId: game.canvasId,
    finish: async () => {
      await send(guestConnection, "room:guess", { generation, payload: { text: target } });
      return (await resume(guest.resumeToken)).snapshot.game!.result!;
    },
    guest: () => resume(guest.resumeToken),
  };
}

async function fixture(
  submit: Inference["submit"],
  render: Inference["render"],
  referee = false,
  switches?: Pick<RoomSettings, "aiGuesserEnabled" | "aiRefereeEnabled">,
) {
  const context = inferenceFixture(submit, render, referee);
  const room = await startRoom(context.engine, "solo", switches);
  return { ...context, ...room };
}

test("independent rooms dispatch Guesser observations concurrently", async () => {
  const submitted: Job[] = [];
  const pending: ((outcome: Outcome) => void)[] = [];
  const context = inferenceFixture((_role, job) => {
    submitted.push(job);
    return new Promise<Outcome>(resolve => { pending.push(resolve); });
  }, async () => Buffer.from("pixels"));
  try {
    const first = await startRoom(context.engine, "first");
    const second = await startRoom(context.engine, "second");
    await first.ink();
    await second.ink();
    context.advance(5000);
    await waitFor(() => pending.length === 2);
    assert.equal(submitted.length, 2);
    assert.equal(new Set(submitted.map(job => job.canvasId)).size, 2);
    const counts = new Map<string, number>();
    for (const job of submitted) counts.set(job.canvasId, (counts.get(job.canvasId) ?? 0) + 1);
    assert.deepEqual([...counts.values()], [1, 1]);
  } finally {
    for (const resolve of pending) resolve({ status: "pass" });
    await delay(30);
    await context.engine.shutdown();
  }
});

test("a pending room coalesces canvas updates and keeps status per room", async () => {
  const submitted: Job[] = [];
  const pending: { job: Job; resolve: (outcome: Outcome) => void }[] = [];
  const context = inferenceFixture((_role, job) => {
    submitted.push(job);
    return new Promise<Outcome>(resolve => { pending.push({ job, resolve }); });
  }, async (_key, operations) => Buffer.from(String(operations.length)), false, 10000);
  try {
    const first = await startRoom(context.engine, "coalesce-a");
    const second = await startRoom(context.engine, "coalesce-b");
    await first.ink();
    await second.ink();
    context.advance(5000);
    await waitFor(() => pending.length === 2);
    const firstJob = pending.find(entry => entry.job.canvasId === first.canvasId)!;
    const secondJob = pending.find(entry => entry.job.canvasId === second.canvasId)!;
    assert.ok(firstJob && secondJob);
    secondJob.resolve({ status: "pass" });
    await delay(30);

    await first.ink();
    const latest = (await first.guest()).snapshot.game!.sync!.sequence;
    context.advance(6500);
    await delay(300);
    assert.equal(submitted.filter(job => job.canvasId === first.canvasId).length, 1);

    firstJob.resolve({ status: "pass" });
    await delay(30);
    context.advance(9500);
    await waitFor(() => submitted.filter(job => job.canvasId === first.canvasId).length === 2);
    const retry = submitted.filter(job => job.canvasId === first.canvasId)[1];
    assert.equal(retry.sequence, latest);
    assert.equal((await first.guest()).snapshot.game!.aiStatus, "guessing");
    assert.equal((await second.guest()).snapshot.game!.aiStatus, "waiting");
    pending.find(entry => entry.job === retry)!.resolve({ status: "pass" });
    await delay(30);
  } finally {
    for (const entry of pending) entry.resolve({ status: "pass" });
    await delay(30);
    await context.engine.shutdown();
  }
});

test("Guesser paces dispatch, caps at 24 attempts and reveals repeated guesses", async () => {
  const jobs: Job[] = [];
  let renders = 0;
  let wrongAnswer = "";
  const room = await fixture(async (_role, job) => {
    jobs.push(job);
    return { status: "answer", answer: wrongAnswer, confidence: 0.8 };
  }, async (_key, operations) => {
    renders++;
    // First prefix is blank, then two prefixes render the same visible pixels.
    if (operations.length === 2) return null;
    return Buffer.from(String(operations.length === 6 ? 4 : operations.length));
  });
  wrongAnswer = PROMPTS.find(word => word !== room.target)!;
  try {
    await room.ink();
    room.advance(2999);
    await delay(260);
    assert.equal(renders, 0);
    room.advance(3000);
    await waitFor(() => renders === 1);
    assert.equal(jobs.length, 0);
    await room.ink();
    await waitFor(() => jobs.length === 1);
    await delay(20);
    await room.ink();
    room.advance(5999);
    await delay(260);
    assert.equal(renders, 2);
    room.advance(6000);
    await waitFor(() => renders === 3);
    assert.equal(jobs.length, 1);
    for (let attempt = 2; attempt <= 24; attempt++) {
      room.advance(3000 + (attempt - 1) * 3000);
      await room.ink();
      await waitFor(() => jobs.length === attempt);
      await delay(20);
    }
    room.advance(75000);
    await room.ink();
    await delay(260);
    assert.equal(jobs.length, 24);
    assert.equal((await room.guest()).snapshot.game!.result, undefined);
    const result = await room.finish();
    assert.deepEqual(result.aiAnswers, Array(24).fill(wrongAnswer));
    assert.deepEqual(result.aiGuesses?.map(({ answer, confidence, submitted }) => ({ answer, confidence, submitted })), Array(24).fill({ answer: wrongAnswer, confidence: 0.8, submitted: true }));
    const pulseJobs = room.events.filter(event => event.type === "ai-guess").map(event => event.jobId);
    assert.equal(pulseJobs.length, 48);
    assert.equal(new Set(pulseJobs).size, 24);
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
    complete!({ status: "answer", answer: room.target, confidence: 0.8 });
    room.advance(14000);
    await room.ink();
    await waitFor(() => jobs.length === 2);
    await delay(320);
    const result = await room.finish();
    assert.deepEqual(result.aiAnswers, []);
    assert.equal(result.aiBenchmark?.points, null);
  } finally { await room.engine.shutdown(); }
});

test("live Guesser status hides answers and retains an accepted answer after a later failure", async () => {
  let settle: ((outcome: Outcome) => void) | undefined;
  let calls = 0;
  let answer = "";
  const room = await fixture(async () => {
    calls++;
    if (calls === 1) return new Promise<Outcome>(resolve => { settle = resolve; });
    return { status: "unavailable", reason: "provider-unavailable" };
  }, async (_key, operations) => Buffer.from(String(operations.length)));
  answer = PROMPTS.find(word => word !== room.target)!;
  try {
    await room.ink();
    room.advance(5000);
    await waitFor(() => calls === 1);
    const during = (await room.guest()).snapshot.game!;
    assert.equal(during.aiStatus, "guessing");
    assert.equal(during.result, undefined);
    assert.equal(JSON.stringify(during).includes(answer), false);
    settle!({ status: "answer", answer, confidence: 0.8 });
    await waitFor(() => calls === 1 && settle !== undefined);
    await delay(30);
    assert.equal((await room.guest()).snapshot.game!.aiStatus, "waiting");
    room.advance(13000);
    await room.ink();
    await waitFor(() => calls === 2);
    await delay(30);
    assert.equal((await room.guest()).snapshot.game!.aiStatus, "unavailable");
    const result = await room.finish();
    assert.deepEqual(result.aiAnswers, [answer]);
    assert.equal(result.aiBenchmark?.points, null);
  } finally { await room.engine.shutdown(); }
});


test("co-due roles share one prefix and referee continues after the Guesser solves", async () => {
  const jobs: { role: string; job: Job; png: Buffer }[] = [];
  let renders = 0;
  let answer = "";
  const room = await fixture(async (role, job, png) => {
    jobs.push({ role, job, png });
    return role === "guesser" ? { status: "answer", answer, confidence: 0.6 } : { status: "evidence", scores: [0.8, 0.1] };
  }, async () => { renders++; return Buffer.from("pixels"); }, true);
  answer = room.target;
  try {
    await room.ink();
    room.advance(5000);
    await waitFor(() => jobs.length === 2);
    assert.equal(renders, 1);
    assert.equal(jobs[0].job.sequence, jobs[1].job.sequence);
    assert.strictEqual(jobs[0].png, jobs[1].png);
    await waitFor(() => room.events.some(value => value.type === "ai-guess"));
    const event = room.events.find(value => value.type === "ai-guess");
    assert.ok(event);
    assert.equal(JSON.stringify(event).includes(answer), false);
    assert.equal(event.correct, true);
    await room.ink();
    room.advance(7000);
    await waitFor(() => jobs.length >= 3);
    assert.deepEqual(jobs.map(entry => entry.role).sort(), ["guesser", "referee", "referee"]);
  } finally { await room.engine.shutdown(); }
});


test("referee warning opens on the first text score at 0.4 and clears on clear", async () => {
  let refereeCalls = 0;
  const room = await fixture(async role => {
    if (role === "referee") { refereeCalls++; return { status: "evidence", scores: [0.4, 0.9] }; }
    return { status: "pass" };
  }, async () => Buffer.from("pixels"), true);
  try {
    await room.ink();
    room.advance(1000);
    await waitFor(() => refereeCalls === 1);
    await waitFor(() => room.events.some(event => event.type === "snapshot" && !!event.snapshot.game?.refereeWarning));
    const warning = (await room.guest()).snapshot.game!.refereeWarning;
    assert.equal(warning?.confidence, 0.4);
    await room.ink(true);
    assert.equal((await room.guest()).snapshot.game!.refereeWarning, undefined);
  } finally { await room.engine.shutdown(); }
});

test("a below-threshold frame does not delay the next qualifying referee warning", async () => {
  let refereeCalls = 0;
  const room = await fixture(async role => {
    if (role === "referee") {
      refereeCalls++;
      return { status: "evidence", scores: [refereeCalls === 1 ? 0.39 : 0.4, 0.1] };
    }
    return { status: "pass" };
  }, async () => Buffer.from("pixels"), true);
  try {
    await room.ink();
    room.advance(1000);
    await waitFor(() => refereeCalls === 1);
    assert.equal((await room.guest()).snapshot.game!.refereeWarning, undefined);
    room.advance(2000);
    await waitFor(() => refereeCalls === 2);
    await waitFor(() => room.events.some(event => event.type === "snapshot" && !!event.snapshot.game?.refereeWarning));
    assert.equal((await room.guest()).snapshot.game!.refereeWarning?.confidence, 0.4);
  } finally { await room.engine.shutdown(); }
});

test("host settings independently gate each ready role and survive legacy updates", async () => {
  for (const [aiGuesserEnabled, aiRefereeEnabled] of [[true, true], [true, false], [false, true], [false, false]]) {
    const submitted: string[] = [];
    const room = await fixture(async role => {
      submitted.push(role);
      return role === "guesser" ? { status: "pass" } : { status: "evidence", scores: [0.1, 0.9] };
    }, async () => Buffer.from("pixels"), true, { aiGuesserEnabled, aiRefereeEnabled });
    try {
      await room.ink();
      room.advance(3000);
      if (!aiGuesserEnabled) await assert.rejects(room.engine.reserveGuesserObservation(room.code), /AI observation is unavailable/);
      const expected = [...(aiGuesserEnabled ? ["guesser"] : []), ...(aiRefereeEnabled ? ["referee"] : [])];
      if (expected.length) await waitFor(() => submitted.length >= expected.length);
      await delay(260);
      assert.deepEqual(submitted.sort(), expected);
      assert.equal((await room.guest()).snapshot.game!.refereeWarning, undefined);
    } finally { await room.engine.shutdown(); }
  }
});


test("only confidence above one half submits a canonical inference", async () => {
  const confidences = [0.5, 0.49, Number.NaN, 1.1, 0.51];
  let target = "";
  let calls = 0;
  const room = await fixture(async () => ({ status: "answer", answer: target, confidence: confidences[calls++] }), async (_key, operations) => Buffer.from(String(operations.length)));
  target = room.target;
  try {
    for (let i = 0; i < confidences.length; i++) {
      await room.ink();
      room.advance(3000 + i * 3000);
      await waitFor(() => calls === i + 1);
      await delay(30);
      if (i < 4) assert.equal(room.events.filter(event => event.type === "ai-guess").length, 0);
    }
    const result = await room.finish();
    assert.deepEqual(result.aiGuesses?.map(guess => guess.submitted), [false, false, true]);
    assert.equal(result.aiBenchmark?.status, "solved");
    assert.equal(room.events.filter(event => event.type === "ai-guess").length, 2);
  } finally { await room.engine.shutdown(); }
});
