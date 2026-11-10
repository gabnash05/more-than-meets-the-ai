/**
 * Versioned wire contract for Guesser jobs dispatched through Redis Streams.
 *
 * The game API owns this contract. A job carries only public drawing state and
 * bounded identity fields; the secret target and accepted human answers never
 * cross this boundary. Results echo the job identity so a late or duplicated
 * delivery can be rejected before it affects a room.
 */

export const GUESS_JOB_VERSION = 1 as const;
export const GUESS_PAYLOAD_PREFIX = "mmtai:ai:payload:";

export interface GuessJobV1 {
  version: 1;
  role: "guesser";
  jobId: string;
  turnId: string;
  canvasId: string;
  generation: number;
  sequence: number;
  /** Unix epoch milliseconds. The API sets it before publishing. */
  deadlineAt: number;
  modelId: string;
  artifactRevision: string;
  payloadKey: string;
  /** Official word-length/letter hint only; never the target. */
  hint?: string;
}

export type GuessResultV1 = Omit<GuessJobV1, "payloadKey" | "hint"> &
  (
    | { status: "answer"; answer: string; confidence: number }
    | { status: "pass"; reason?: string }
    | { status: "unavailable"; reason: string }
  );

const BINDING_KEYS = [
  "version",
  "role",
  "jobId",
  "turnId",
  "canvasId",
  "generation",
  "sequence",
  "deadlineAt",
  "modelId",
  "artifactRevision",
] as const;

const JOB_KEYS = new Set<string>([...BINDING_KEYS, "payloadKey", "hint"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function hasInteger(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

/** Return true only for a structurally valid Guesser job envelope. */
export function isGuessJobV1(value: unknown): value is GuessJobV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, JOB_KEYS)) return false;
  return (
    value.version === GUESS_JOB_VERSION &&
    value.role === "guesser" &&
    hasText(value.jobId, 1, 128) &&
    hasText(value.turnId, 1, 128) &&
    hasText(value.canvasId, 1, 128) &&
    hasInteger(value.generation, 0) &&
    hasInteger(value.sequence, 1) &&
    hasInteger(value.deadlineAt, 1) &&
    hasText(value.modelId, 1, 64) &&
    hasText(value.artifactRevision, 1, 128) &&
    hasText(value.payloadKey, 1, 200) &&
    value.payloadKey === `${GUESS_PAYLOAD_PREFIX}${value.jobId}` &&
    (value.hint === undefined || hasText(value.hint, 0, 128))
  );
}

/** Parse a job envelope, throwing a stable reason for invalid input. */
export function parseGuessJobV1(value: unknown): GuessJobV1 {
  if (!isGuessJobV1(value)) throw new Error("invalid-guess-job");
  return value;
}

/**
 * Parse a worker result and verify that every identity field matches `job`.
 *
 * A worker cannot redirect a result to another turn or canvas by changing the
 * envelope. Status-specific fields are validated so a malformed answer or
 * confidence cannot reach the scoring path.
 */
export function parseGuessResultV1(value: unknown, job: GuessJobV1): GuessResultV1 {
  if (!isRecord(value)) throw new Error("invalid-guess-result");
  const allowed = new Set<string>([...BINDING_KEYS, "status", "answer", "confidence", "reason"]);
  if (!hasOnlyKeys(value, allowed)) throw new Error("invalid-guess-result");
  for (const key of BINDING_KEYS) if (value[key] !== job[key]) throw new Error("invalid-result-binding");
  if (value.status === "answer") {
    if (!hasText(value.answer, 1, 100)) throw new Error("invalid-answer-result");
    if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
      throw new Error("invalid-confidence");
    }
    return value as unknown as GuessResultV1;
  }
  if (value.status === "pass") {
    if (value.reason !== undefined && !hasText(value.reason, 1, 128)) throw new Error("invalid-pass-result");
    return value as unknown as GuessResultV1;
  }
  if (value.status === "unavailable") {
    if (!hasText(value.reason, 1, 128)) throw new Error("invalid-unavailable-result");
    return value as unknown as GuessResultV1;
  }
  throw new Error("invalid-result-status");
}

/** Copy the immutable identity fields a worker must echo in its result. */
export function guessResultBinding(job: GuessJobV1): Omit<GuessJobV1, "payloadKey" | "hint"> {
  return {
    version: job.version,
    role: job.role,
    jobId: job.jobId,
    turnId: job.turnId,
    canvasId: job.canvasId,
    generation: job.generation,
    sequence: job.sequence,
    deadlineAt: job.deadlineAt,
    modelId: job.modelId,
    artifactRevision: job.artifactRevision,
  };
}
