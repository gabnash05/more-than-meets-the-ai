import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  guessResultBinding,
  isGuessJobV1,
  parseGuessJobV1,
  parseGuessResultV1,
} from "../../../packages/game-contracts/src/ai-inference";

const directory = resolve(process.cwd(), "../../packages/game-contracts/fixtures/ai-inference-v1");
const read = (name: string): unknown => JSON.parse(readFileSync(resolve(directory, name), "utf8"));
const record = (name: string): Record<string, unknown> => read(name) as Record<string, unknown>;

test("shared fixtures satisfy both job and result contracts", () => {
  const job = parseGuessJobV1(read("job.valid.json"));
  assert.equal(isGuessJobV1(job), true);
  assert.deepEqual(guessResultBinding(job), {
    version: 1,
    role: "guesser",
    jobId: "job-0001",
    turnId: "turn-0001",
    canvasId: "canvas-0001",
    generation: 2,
    sequence: 6,
    deadlineAt: 1762771200000,
    modelId: "guesser-vit-a-v1",
    artifactRevision: "vit-a-20261110",
  });
  for (const name of ["result.answer.valid.json", "result.pass.valid.json", "result.unavailable.valid.json"]) {
    const result = parseGuessResultV1(read(name), job);
    assert.equal(result.version, job.version);
    assert.equal(result.jobId, job.jobId);
    assert.equal(result.canvasId, job.canvasId);
    assert.equal(result.deadlineAt, job.deadlineAt);
  }
});

test("job validation rejects invalid version, role, payload key and extra fields", () => {
  const base = record("job.valid.json");
  const mutations: ((value: Record<string, unknown>) => void)[] = [
    value => { value.version = 2; },
    value => { value.role = "referee"; },
    value => { value.payloadKey = "mmtai:ai:payload:other"; },
    value => { delete value.jobId; },
    value => { value.generation = -1; },
    value => { value.sequence = 0; },
    value => { value.deadlineAt = 0; },
    value => { value.extra = true; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(base);
    mutate(value);
    assert.equal(isGuessJobV1(value), false);
    assert.throws(() => parseGuessJobV1(value), /invalid-guess-job/);
  }
});

test("result validation rejects bad confidence, long answers and binding drift", () => {
  const job = parseGuessJobV1(read("job.valid.json"));
  const answer = record("result.answer.valid.json");
  const unavailable = record("result.unavailable.valid.json");
  const mutations: [Record<string, unknown>, (value: Record<string, unknown>) => void][] = [
    [answer, value => { value.confidence = 1.5; }],
    [answer, value => { value.answer = "x".repeat(101); }],
    [answer, value => { value.jobId = "job-9999"; }],
    [answer, value => { value.deadlineAt = 1762771200001; }],
    [answer, value => { value.status = "evidence"; }],
    [answer, value => { value.extra = true; }],
    [unavailable, value => { delete value.reason; }],
  ];
  for (const [source, mutate] of mutations) {
    const value = structuredClone(source);
    mutate(value);
    assert.throws(() => parseGuessResultV1(value, job));
  }
});
