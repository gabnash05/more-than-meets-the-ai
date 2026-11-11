import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createClient } from "redis";
import { guessResultBinding, parseGuessJobV1 } from "../../../packages/game-contracts/src/ai-inference";
import { configuredInference, type Job } from "../src/ai/client";
import {
  GUESS_CANCEL_PREFIX,
  GUESS_JOBS_STREAM,
  GUESS_RESULTS_STREAM,
  GUESS_WORKER_GROUP,
  GUESS_WORKER_PREFIX,
  GuesserQueue,
  type QueueConnection,
  type QueueEntry,
} from "../src/ai/redis-queue";
import { RedisQueueConnection } from "../src/ai/redis-connection";

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail("Expected queue condition never settled");
}

class FakeConnection implements QueueConnection {
  values = new Map<string, { value: string | Buffer; ttl: number }>();
  jobs: { stream: string; field: string; value: string }[] = [];
  events: string[] = [];
  groups: string[] = [];
  entries: QueueEntry[] = [];
  acknowledged: string[] = [];
  closed = false;
  failScan = false;

  async setValue(key: string, value: string | Buffer, ttl: number) {
    this.events.push(`set:${key}`);
    this.values.set(key, { value, ttl });
  }
  async readText(key: string) {
    const entry = this.values.get(key);
    return entry ? entry.value.toString() : null;
  }
  async deleteKey(key: string) {
    this.values.delete(key);
  }
  async append(stream: string, field: string, value: string) {
    this.events.push(`append:${stream}`);
    this.jobs.push({ stream, field, value });
    return `${this.jobs.length}-0`;
  }
  async ensureGroup(stream: string, group: string) {
    this.groups.push(`${stream}:${group}`);
  }
  async readGroup(): Promise<QueueEntry[]> {
    await delay(10);
    return this.entries.splice(0);
  }
  async acknowledge(_stream: string, _group: string, id: string) {
    this.acknowledged.push(id);
  }
  async deleteEntry() {}
  async scanKeys(pattern: string) {
    if (this.failScan) throw new Error("redis-down");
    const prefix = pattern.replace(/\*$/, "");
    return [...this.values.keys()].filter(key => key.startsWith(prefix));
  }
  async close() {
    this.closed = true;
  }
}

const labels = Array.from({ length: 345 }, (_, index) => `label-${index}`);
const clock = { value: 1_000_000 };
const now = () => clock.value;
const signal = () => new AbortController().signal;

function job(overrides: Partial<Job> = {}): Job {
  return {
    jobId: "job-1",
    turnId: "turn-1",
    canvasId: "canvas-1",
    generation: 1,
    sequence: 2,
    deadlineAt: now() + 5000,
    modelId: "guesser-vit-a-v1",
    artifactRevision: "vit-a-20261110",
    hint: "_ _ _",
    ...overrides,
  };
}

function queueFixture(modelId = "guesser-vit-a-v1") {
  const connection = new FakeConnection();
  const queue = new GuesserQueue({ modelId, connection, consumerId: "api-test", now });
  return { connection, queue };
}

function registration(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    modelId: "guesser-vit-a-v1",
    artifactRevision: "vit-a-20261110",
    labels,
    heartbeatAt: now(),
    ...overrides,
  });
}

function answerFor(value: Job) {
  return {
    version: 1,
    role: "guesser",
    jobId: value.jobId,
    turnId: value.turnId,
    canvasId: value.canvasId,
    generation: value.generation,
    sequence: value.sequence,
    deadlineAt: value.deadlineAt,
    modelId: value.modelId,
    artifactRevision: value.artifactRevision,
    status: "answer",
    answer: "zigzag",
    confidence: 0.8,
  };
}

function evidenceFor(value: Job) {
  return {
    version: 1,
    role: "referee",
    jobId: value.jobId,
    turnId: value.turnId,
    canvasId: value.canvasId,
    generation: value.generation,
    sequence: value.sequence,
    deadlineAt: value.deadlineAt,
    modelId: value.modelId,
    artifactRevision: value.artifactRevision,
    status: "evidence",
    scores: [0.82, 0.21],
  };
}

test("submit writes the payload before appending and resolves its bound result", async () => {
  const { connection, queue } = queueFixture();
  try {
    connection.values.set(`${GUESS_WORKER_PREFIX}w1`, { value: registration(), ttl: 15000 });
    await queue.start();
    assert.deepEqual(connection.groups, ["mmtai:ai:guess:results:v1:api-results-v1"]);
    assert.equal(queue.ready()?.artifactRevision, "vit-a-20261110");
    assert.equal(queue.ready()?.labels?.length, 345);

    const value = job();
    const pending = queue.submit("guesser", value, Buffer.from("png"), signal());
    await waitFor(() => connection.jobs.length === 1);
    assert.deepEqual(connection.events.slice(-2), ["set:mmtai:ai:payload:job-1", `append:${GUESS_JOBS_STREAM}`]);
    const envelope = JSON.parse(connection.jobs[0].value) as Record<string, unknown>;
    assert.equal(envelope.version, 1);
    assert.equal(envelope.role, "guesser");
    assert.equal(envelope.payloadKey, "mmtai:ai:payload:job-1");

    const result = answerFor(value);
    assert.equal(queue.acceptResult(result), true);
    assert.deepEqual(await pending, { status: "answer", answer: "zigzag", confidence: 0.8 });
    assert.equal(queue.acceptResult(result), false);
  } finally {
    await queue.close();
  }
});

test("referee registrations and evidence results resolve independently", async () => {
  const connection = new FakeConnection();
  const queue = new GuesserQueue({
    modelIds: { guesser: "guesser-vit-a-v1", referee: "referee-vit-a-v1" },
    connection,
    consumerId: "api-test",
    now,
  });
  try {
    connection.values.set(`${GUESS_WORKER_PREFIX}w1`, { value: registration(), ttl: 15000 });
    connection.values.set(`${GUESS_WORKER_PREFIX}w1:referee`, {
      value: JSON.stringify({
        role: "referee",
        modelId: "referee-vit-a-v1",
        artifactRevision: "e6236a3b",
        heartbeatAt: now(),
      }),
      ttl: 15000,
    });
    await queue.refresh();
    assert.equal(queue.ready("guesser")?.labels?.length, 345);
    assert.equal(queue.ready("referee")?.modelId, "referee-vit-a-v1");

    const value = job({ jobId: "job-referee", modelId: "referee-vit-a-v1", artifactRevision: "e6236a3b" });
    const pending = queue.submit("referee", value, Buffer.from("png"), signal());
    await waitFor(() => connection.jobs.length === 1);
    const envelope = JSON.parse(connection.jobs[0].value) as Record<string, unknown>;
    assert.equal(envelope.role, "referee");
    assert.equal("hint" in envelope, false);

    assert.equal(queue.acceptResult(evidenceFor(value)), true);
    assert.deepEqual(await pending, { status: "evidence", scores: [0.82, 0.21] });
  } finally {
    await queue.close();
  }
});

test("readiness ignores stale, foreign and malformed worker registrations", async () => {
  const { connection, queue } = queueFixture();
  try {
    connection.values.set(`${GUESS_WORKER_PREFIX}stale`, { value: registration({ heartbeatAt: now() - 16000 }), ttl: 15000 });
    await queue.refresh();
    assert.equal(queue.ready(), undefined);

    connection.values.clear();
    connection.values.set(`${GUESS_WORKER_PREFIX}foreign`, { value: registration({ modelId: "other" }), ttl: 15000 });
    await queue.refresh();
    assert.equal(queue.ready(), undefined);

    connection.values.clear();
    connection.values.set(`${GUESS_WORKER_PREFIX}short-labels`, { value: registration({ labels: ["one"] }), ttl: 15000 });
    await queue.refresh();
    assert.equal(queue.ready(), undefined);

    connection.values.clear();
    connection.values.set(`${GUESS_WORKER_PREFIX}broken`, { value: "not-json", ttl: 15000 });
    connection.values.set(`${GUESS_WORKER_PREFIX}fresh`, { value: registration(), ttl: 15000 });
    connection.failScan = true;
    await queue.refresh();
    assert.equal(queue.ready(), undefined);
    connection.failScan = false;
    await queue.refresh();
    assert.equal(queue.ready()?.modelId, "guesser-vit-a-v1");
  } finally {
    await queue.close();
  }
});

test("a job past its deadline becomes unavailable and leaves a cancel marker", async () => {
  const { connection, queue } = queueFixture();
  try {
    const value = job({ jobId: "job-timeout", deadlineAt: now() + 25 });
    const outcome = await queue.submit("guesser", value, Buffer.from("png"), signal());
    assert.deepEqual(outcome, { status: "unavailable", reason: "request-timeout" });
    assert.ok(connection.values.has(`${GUESS_CANCEL_PREFIX}job-timeout`));
  } finally {
    await queue.close();
  }
});

test("aborting a submit rejects it and writes a cancel marker", async () => {
  const { connection, queue } = queueFixture();
  try {
    const controller = new AbortController();
    const pending = queue.submit("guesser", job({ jobId: "job-abort" }), Buffer.from("png"), controller.signal);
    await waitFor(() => connection.jobs.length === 1);
    controller.abort(new Error("invalidated"));
    await assert.rejects(pending, /invalidated/);
    assert.ok(connection.values.has(`${GUESS_CANCEL_PREFIX}job-abort`));
  } finally {
    await queue.close();
  }
});

test("results with drifted identity are ignored and do not resolve the waiter", async () => {
  const { connection, queue } = queueFixture();
  try {
    const value = job({ jobId: "job-binding" });
    const pending = queue.submit("guesser", value, Buffer.from("png"), signal());
    await waitFor(() => connection.jobs.length === 1);
    assert.equal(queue.acceptResult({ ...answerFor(value), canvasId: "other-canvas" }), false);
    assert.equal(queue.acceptResult({ ...answerFor(value), jobId: "job-elsewhere" }), false);
    assert.equal(queue.acceptResult(answerFor(value)), true);
    assert.deepEqual(await pending, { status: "answer", answer: "zigzag", confidence: 0.8 });
  } finally {
    await queue.close();
  }
});

test("close rejects live waiters and refuses further submissions", async () => {
  const { connection, queue } = queueFixture();
  const pending = queue.submit("guesser", job({ jobId: "job-close" }), Buffer.from("png"), signal());
  await waitFor(() => connection.jobs.length === 1);
  await queue.close();
  await assert.rejects(pending, /queue-closed/);
  assert.equal(connection.closed, true);
  await assert.rejects(queue.submit("guesser", job({ jobId: "job-after-close" }), Buffer.from("png"), signal()), /queue-closed/);
});

test("invalid queue configuration keeps the game human-playable", () => {
  const keys = ["GUESSER_PROVIDER", "GUESSER_MODEL_ID", "AI_QUEUE_REDIS_URL", "REDIS_URL", "AI_QUEUE_REDIS_PASSWORD_FILE"];
  const before = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.GUESSER_PROVIDER = "queue";
    process.env.GUESSER_MODEL_ID = "guesser-vit-a-v1";
    process.env.AI_QUEUE_REDIS_URL = "http://127.0.0.1:6379/15";
    delete process.env.AI_QUEUE_REDIS_PASSWORD_FILE;
    assert.equal(configuredInference(), undefined);

    process.env.AI_QUEUE_REDIS_URL = "redis://127.0.0.1:6379/15";
    process.env.AI_QUEUE_REDIS_PASSWORD_FILE = "/nonexistent/redis-password";
    assert.equal(configuredInference(), undefined);

    delete process.env.AI_QUEUE_REDIS_PASSWORD_FILE;
    process.env.GUESSER_MODEL_ID = "bad model id";
    assert.equal(configuredInference(), undefined);
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("real Redis round-trip resolves a submitted job", { skip: !process.env.REDIS_URL }, async () => {
  const url = process.env.REDIS_URL!;
  const raw = createClient({ url });
  await raw.connect();
  const connection = new RedisQueueConnection({ url });
  const queue = new GuesserQueue({ modelId: "guesser-vit-a-v1", connection, consumerId: `api-int-${randomUUID()}` });
  const workerId = `worker-int-${randomUUID()}`;
  try {
    await raw.del([GUESS_JOBS_STREAM, GUESS_RESULTS_STREAM, `${GUESS_WORKER_PREFIX}${workerId}`]);
    await queue.start();
    await raw.xGroupCreate(GUESS_JOBS_STREAM, GUESS_WORKER_GROUP, "0", { MKSTREAM: true }).catch(error => {
      if (!String(error).includes("BUSYGROUP")) throw error;
    });
    await raw.set(`${GUESS_WORKER_PREFIX}${workerId}`, JSON.stringify({
      modelId: "guesser-vit-a-v1", artifactRevision: "vit-a-20261110", labels, heartbeatAt: Date.now(),
    }), { expiration: { type: "PX", value: 15000 } });
    await queue.refresh();
    assert.equal(queue.ready()?.labels?.length, 345);

    const value = job({ jobId: `job-int-${randomUUID()}`, deadlineAt: Date.now() + 5000 });
    const pending = queue.submit("guesser", value, Buffer.from("png"), signal());
    let received: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20 && !received; attempt++) {
      const reply = await raw.xReadGroup(GUESS_WORKER_GROUP, workerId, [{ key: GUESS_JOBS_STREAM, id: ">" }], { COUNT: 10, BLOCK: 500 });
      for (const entry of reply ?? []) {
        for (const message of entry.messages) {
          const parsed = JSON.parse(String(message.message.job)) as Record<string, unknown>;
          if (parsed.jobId === value.jobId) received = parsed;
        }
      }
    }
    assert.ok(received, "worker never received the queued job");
    await raw.xAdd(GUESS_RESULTS_STREAM, "*", {
      result: JSON.stringify({ ...guessResultBinding(parseGuessJobV1(received)), status: "answer", answer: "zigzag", confidence: 0.8 }),
    });
    assert.deepEqual(await pending, { status: "answer", answer: "zigzag", confidence: 0.8 });
  } finally {
    await queue.close();
    await raw.del([GUESS_JOBS_STREAM, GUESS_RESULTS_STREAM, `${GUESS_WORKER_PREFIX}${workerId}`]);
    await raw.quit();
  }
});
