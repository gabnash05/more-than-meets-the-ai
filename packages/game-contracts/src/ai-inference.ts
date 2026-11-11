/**
 * Versioned wire contract for inference jobs dispatched through Redis Streams.
 *
 * The game API owns this contract. A job carries only public drawing state and
 * bounded identity fields; the secret target and accepted human answers never
 * cross this boundary. Results echo the job identity so a late or duplicated
 * delivery can be rejected before it affects a room.
 *
 * The queue is shared by the Guesser and Referee roles. Each role has its own
 * result shape: the Guesser returns an answer or pass, while the Referee returns
 * two evidence scores.
 */

export const GUESS_JOB_VERSION = 1 as const;
export const GUESS_PAYLOAD_PREFIX = "mmtai:ai:payload:";

export type InferenceRole = "guesser" | "referee";

export interface InferenceBindingV1 {
  version: 1;
  role: InferenceRole;
  jobId: string;
  turnId: string;
  canvasId: string;
  generation: number;
  sequence: number;
  /** Unix epoch milliseconds. The API sets it before publishing. */
  deadlineAt: number;
  modelId: string;
  artifactRevision: string;
}

export interface GuessJobV1 extends InferenceBindingV1 {
  role: "guesser";
  payloadKey: string;
  /** Official word-length/letter hint only; never the target. */
  hint?: string;
}

export interface RefereeJobV1 extends InferenceBindingV1 {
  role: "referee";
  payloadKey: string;
}

export type InferenceJobV1 = GuessJobV1 | RefereeJobV1;

export interface GuessAnswerResultV1 extends InferenceBindingV1 {
  role: "guesser";
  status: "answer";
  answer: string;
  confidence: number;
}

export interface GuessPassResultV1 extends InferenceBindingV1 {
  role: "guesser";
  status: "pass";
  reason?: string;
}

export interface RefereeEvidenceResultV1 extends InferenceBindingV1 {
  role: "referee";
  status: "evidence";
  scores: [number, number];
}

export interface UnavailableResultV1 extends InferenceBindingV1 {
  status: "unavailable";
  reason: string;
}

export type GuessResultV1 = GuessAnswerResultV1 | GuessPassResultV1 | UnavailableResultV1;
export type RefereeResultV1 = RefereeEvidenceResultV1 | UnavailableResultV1;
export type InferenceResultV1 = GuessAnswerResultV1 | GuessPassResultV1 | RefereeEvidenceResultV1 | UnavailableResultV1;

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

function hasPayloadKey(value: Record<string, unknown>): boolean {
  return hasText(value.payloadKey, 1, 200) && value.payloadKey === `${GUESS_PAYLOAD_PREFIX}${value.jobId}`;
}

function hasBinding(value: Record<string, unknown>): boolean {
  return (
    value.version === GUESS_JOB_VERSION &&
    (value.role === "guesser" || value.role === "referee") &&
    hasText(value.jobId, 1, 128) &&
    hasText(value.turnId, 1, 128) &&
    hasText(value.canvasId, 1, 128) &&
    hasInteger(value.generation, 0) &&
    hasInteger(value.sequence, 1) &&
    hasInteger(value.deadlineAt, 1) &&
    hasText(value.modelId, 1, 64) &&
    hasText(value.artifactRevision, 1, 128)
  );
}

/** Return true only for a structurally valid Guesser job envelope. */
export function isGuessJobV1(value: unknown): value is GuessJobV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, JOB_KEYS) || !hasBinding(value)) return false;
  return value.role === "guesser" && hasPayloadKey(value) && (value.hint === undefined || hasText(value.hint, 0, 128));
}

/** Return true only for a structurally valid Referee job envelope. */
export function isRefereeJobV1(value: unknown): value is RefereeJobV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, JOB_KEYS) || !hasBinding(value)) return false;
  return value.role === "referee" && hasPayloadKey(value) && value.hint === undefined;
}

/** Return true for either role's job envelope. */
export function isInferenceJobV1(value: unknown): value is InferenceJobV1 {
  return isGuessJobV1(value) || isRefereeJobV1(value);
}

/** Parse a Guesser job envelope, throwing a stable reason for invalid input. */
export function parseGuessJobV1(value: unknown): GuessJobV1 {
  if (!isGuessJobV1(value)) throw new Error("invalid-guess-job");
  return value;
}

/** Parse a Referee job envelope, throwing a stable reason for invalid input. */
export function parseRefereeJobV1(value: unknown): RefereeJobV1 {
  if (!isRefereeJobV1(value)) throw new Error("invalid-referee-job");
  return value;
}

/** Parse either role's job envelope, throwing a stable reason for invalid input. */
export function parseInferenceJobV1(value: unknown): InferenceJobV1 {
  if (!isInferenceJobV1(value)) throw new Error("invalid-inference-job");
  return value;
}

function hasResultBinding(value: Record<string, unknown>, job: InferenceJobV1): boolean {
  for (const key of BINDING_KEYS) if (value[key] !== job[key]) return false;
  return true;
}

/**
 * Parse a worker result and verify that every identity field matches `job`.
 *
 * A worker cannot redirect a result to another turn or canvas by changing the
 * envelope. Status-specific fields are validated so a malformed answer or
 * confidence cannot reach the scoring path.
 */
export function parseGuessResultV1(value: unknown, job: GuessJobV1): GuessResultV1 {
  if (!isRecord(value) || !hasResultBinding(value, job)) throw new Error("invalid-guess-result");
  const allowed = new Set<string>([...BINDING_KEYS, "status", "answer", "confidence", "reason"]);
  if (!hasOnlyKeys(value, allowed)) throw new Error("invalid-guess-result");
  if (value.role !== "guesser") throw new Error("invalid-result-binding");
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

/** Parse a Referee evidence result bound to the submitted job. */
export function parseRefereeResultV1(value: unknown, job: RefereeJobV1): RefereeResultV1 {
  if (!isRecord(value) || !hasResultBinding(value, job)) throw new Error("invalid-referee-result");
  const allowed = new Set<string>([...BINDING_KEYS, "status", "scores", "reason"]);
  if (!hasOnlyKeys(value, allowed)) throw new Error("invalid-referee-result");
  if (value.role !== "referee") throw new Error("invalid-result-binding");
  if (value.status === "evidence") {
    if (
      !Array.isArray(value.scores) ||
      value.scores.length !== 2 ||
      !value.scores.every(score => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1)
    ) {
      throw new Error("invalid-evidence-result");
    }
    return { ...value, scores: [value.scores[0], value.scores[1]] } as unknown as RefereeEvidenceResultV1;
  }
  if (value.status === "unavailable") {
    if (!hasText(value.reason, 1, 128)) throw new Error("invalid-unavailable-result");
    return value as unknown as RefereeResultV1;
  }
  throw new Error("invalid-result-status");
}

/** Parse a result for either role, dispatching on the submitted job's role. */
export function parseInferenceResultV1(value: unknown, job: InferenceJobV1): InferenceResultV1 {
  return job.role === "guesser" ? parseGuessResultV1(value, job) : parseRefereeResultV1(value, job);
}

/** Copy the immutable identity fields a worker must echo in its result. */
export function inferenceResultBinding(job: InferenceJobV1): Omit<InferenceJobV1, "payloadKey" | "hint"> {
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

/** Backwards-compatible alias for the Guesser-only helper. */
export function guessResultBinding(job: GuessJobV1): Omit<GuessJobV1, "payloadKey" | "hint"> {
  return inferenceResultBinding(job) as Omit<GuessJobV1, "payloadKey" | "hint">;
}
