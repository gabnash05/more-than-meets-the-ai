import type { Job, Outcome, ReadyModel, Role } from "./client";
import {
  GUESS_JOB_VERSION,
  GUESS_PAYLOAD_PREFIX,
  parseInferenceResultV1,
  type InferenceJobV1,
  type InferenceResultV1,
} from "../../../../packages/game-contracts/src/ai-inference";

export const GUESS_JOBS_STREAM = "mmtai:ai:guess:jobs:v1";
export const GUESS_RESULTS_STREAM = "mmtai:ai:guess:results:v1";
export const GUESS_WORKER_GROUP = "guesser-workers-v1";
export const GUESS_RESULT_GROUP = "api-results-v1";
export const GUESS_WORKER_PREFIX = "mmtai:ai:workers:";
export const GUESS_CANCEL_PREFIX = "mmtai:ai:cancel:";

const WORKER_TTL_MS = 15000;
const READY_CACHE_MS = 7500;
const PAYLOAD_GRACE_MS = 30000;

export interface QueueEntry {
  id: string;
  fields: Record<string, string>;
}

/**
 * Minimal Redis Streams operations used by the shared inference queue.
 *
 * Keeping this boundary narrow lets the queue logic run against a fake in
 * tests and against node-redis in production without importing either one.
 */
export interface QueueConnection {
  setValue(key: string, value: string | Buffer, ttlMs: number): Promise<void>;
  readText(key: string): Promise<string | null>;
  deleteKey(key: string): Promise<void>;
  append(stream: string, field: string, value: string): Promise<string>;
  ensureGroup(stream: string, group: string): Promise<void>;
  readGroup(stream: string, group: string, consumer: string, blockMs: number): Promise<QueueEntry[]>;
  acknowledge(stream: string, group: string, id: string): Promise<void>;
  deleteEntry(stream: string, id: string): Promise<void>;
  scanKeys(pattern: string): Promise<string[]>;
  close(): Promise<void>;
}

interface Options {
  /** Legacy single-model option; equivalent to modelIds.guesser. */
  modelId?: string;
  modelIds?: Partial<Record<Role, string>>;
  connection: QueueConnection;
  consumerId: string;
  /** Latest accepted future timestamp in milliseconds; used for readiness cache age. */
  now?: () => number;
}

interface Waiter {
  job: InferenceJobV1;
  resolve: (outcome: Outcome) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
  signal: AbortSignal;
}

interface WorkerRegistration {
  role?: Role;
  modelId: string;
  artifactRevision: string;
  labels?: string[];
  heartbeatAt: number;
}

/**
 * Client side of the shared Redis Streams inference queue.
 *
 * A submit writes the canvas payload, appends a role-tagged versioned job, and
 * waits for a worker result bound to the same identity. Readiness is a cache of
 * short-lived worker registrations, so a missing or stale worker makes that
 * role unavailable instead of hanging a room. Adding AI replicas adds both
 * Guesser and Referee capacity without changing the room process.
 */
export class InferenceQueue {
  private waiters = new Map<string, Waiter>();
  private models: Partial<Record<Role, ReadyModel>> = {};
  private modelIds: Partial<Record<Role, string>>;
  private refreshedAt = 0;
  private refreshing = false;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private started: Promise<void> | undefined;
  private now: () => number;

  constructor(private options: Options) {
    this.modelIds = { ...(options.modelId ? { guesser: options.modelId } : {}), ...options.modelIds };
    this.now = options.now ?? Date.now;
  }

  /** Create the result consumer group and start readiness/result loops. */
  start(): Promise<void> {
    this.started ??= this.startLoops();
    return this.started;
  }

  private async startLoops(): Promise<void> {
    while (!this.closed) {
      try {
        await this.options.connection.ensureGroup(GUESS_RESULTS_STREAM, GUESS_RESULT_GROUP);
        await this.refresh();
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    if (this.closed) return;
    this.timer = setInterval(() => void this.refresh(), 2500);
    this.timer.unref();
    void this.readResults();
  }

  /** Return the freshest compatible worker registration for one role. */
  ready(role: Role = "guesser"): ReadyModel | undefined {
    return this.now() - this.refreshedAt < READY_CACHE_MS ? this.models[role] : undefined;
  }

  /** Re-read worker registrations from Redis; exposed for deterministic tests. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const found: Partial<Record<Role, ReadyModel>> = {};
      for (const key of await this.options.connection.scanKeys(`${GUESS_WORKER_PREFIX}*`)) {
        const raw = await this.options.connection.readText(key);
        if (!raw) continue;
        let value: Partial<WorkerRegistration>;
        try {
          value = JSON.parse(raw) as Partial<WorkerRegistration>;
        } catch {
          continue;
        }
        const role: Role = value.role === "referee" ? "referee" : "guesser";
        const expected = this.modelIds[role];
        if (!expected || value.modelId !== expected || typeof value.artifactRevision !== "string" || !value.artifactRevision || value.artifactRevision.length > 128) continue;
        if (role === "guesser" && (!Array.isArray(value.labels) || value.labels.length !== 345 || !value.labels.every(label => typeof label === "string" && label.trim().length > 0 && label.length <= 100))) continue;
        if (typeof value.heartbeatAt !== "number" || this.now() - value.heartbeatAt > WORKER_TTL_MS) continue;
        found[role] = {
          modelId: value.modelId,
          artifactRevision: value.artifactRevision,
          ...(role === "guesser" ? { labels: value.labels as string[] } : {}),
        };
      }
      this.models = found;
    } catch {
      // A transient Redis failure makes the affected roles unavailable until the next refresh.
      this.models = {};
    } finally {
      this.refreshedAt = this.now();
      this.refreshing = false;
    }
  }

  /**
   * Publish one role-tagged job and wait for its result.
   *
   * The waiter is registered before the request is appended so a fast worker
   * cannot publish a result that the API misses. Queue wait is bounded by the
   * job deadline: a late job is cancelled and reported unavailable rather than
   * delivering a stale result to the room.
   */
  async submit(role: Role, job: Job, png: Buffer, signal: AbortSignal): Promise<Outcome> {
    if (this.closed) throw new Error("queue-closed");
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    const envelope = {
      version: GUESS_JOB_VERSION,
      role,
      jobId: job.jobId,
      turnId: job.turnId,
      canvasId: job.canvasId,
      generation: job.generation,
      sequence: job.sequence,
      deadlineAt: job.deadlineAt,
      modelId: job.modelId,
      artifactRevision: job.artifactRevision,
      payloadKey: `${GUESS_PAYLOAD_PREFIX}${job.jobId}`,
      ...(role === "guesser" && job.hint !== undefined ? { hint: job.hint } : {}),
    } as InferenceJobV1;
    const remaining = Math.max(1, job.deadlineAt - this.now());
    const ttl = remaining + PAYLOAD_GRACE_MS;
    const cancelKey = `${GUESS_CANCEL_PREFIX}${job.jobId}`;
    const outcome = new Promise<Outcome>((resolve, reject) => {
      const onAbort = () => {
        if (!this.waiters.delete(job.jobId)) return;
        clearTimeout(timer);
        void this.options.connection.setValue(cancelKey, "1", ttl).catch(() => undefined);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      const timer = setTimeout(() => {
        if (!this.waiters.delete(job.jobId)) return;
        signal.removeEventListener("abort", onAbort);
        void this.options.connection.setValue(cancelKey, "1", ttl).catch(() => undefined);
        resolve({ status: "unavailable", reason: "request-timeout" });
      }, remaining);
      timer.unref();
      this.waiters.set(job.jobId, { job: envelope, resolve, reject, timer, onAbort, signal });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // The abort listener above can reject `outcome` while the payload write and the
    // stream append below are still in flight, and nothing awaits `outcome` until the
    // return at the end of this method. A rejection in that window has no handler, so
    // Node's default throw policy turns a routine job cancellation into an unhandled
    // rejection that kills the process — and every live room reloads as interrupted.
    // Attaching a handler now marks it as handled; the awaited return below still
    // throws the same error to the caller.
    void outcome.catch(() => undefined);
    try {
      await this.options.connection.setValue(envelope.payloadKey, png, ttl);
      await this.options.connection.append(GUESS_JOBS_STREAM, "job", JSON.stringify(envelope));
      return await outcome;
    } catch (error) {
      const waiter = this.waiters.get(job.jobId);
      if (waiter) {
        this.waiters.delete(job.jobId);
        clearTimeout(waiter.timer);
        signal.removeEventListener("abort", waiter.onAbort);
      }
      throw error;
    }
  }

  /**
   * Accept one parsed or raw result. Returns false when no live waiter owns it.
   *
   * The identity check makes duplicate delivery and cross-room results inert:
   * the first valid result resolves and removes the waiter, and every later
   * copy is discarded.
   */
  acceptResult(value: unknown): boolean {
    const jobId = typeof value === "object" && value !== null && "jobId" in value ? (value as { jobId?: unknown }).jobId : undefined;
    if (typeof jobId !== "string") return false;
    const waiter = this.waiters.get(jobId);
    if (!waiter) return false;
    let result: InferenceResultV1;
    try {
      result = parseInferenceResultV1(value, waiter.job);
    } catch {
      return false;
    }
    this.waiters.delete(jobId);
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(toOutcome(result));
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const [jobId, waiter] of this.waiters) {
      this.waiters.delete(jobId);
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("queue-closed"));
    }
    await this.options.connection.close();
  }

  private async readResults(): Promise<void> {
    while (!this.closed) {
      try {
        const entries = await this.options.connection.readGroup(GUESS_RESULTS_STREAM, GUESS_RESULT_GROUP, this.options.consumerId, 1000);
        for (const entry of entries) {
          const raw = entry.fields.result;
          if (raw) {
            try {
              this.acceptResult(JSON.parse(raw));
            } catch {
              // Malformed payloads are acknowledged and dropped; the waiter times out.
            }
          }
          await this.options.connection.acknowledge(GUESS_RESULTS_STREAM, GUESS_RESULT_GROUP, entry.id);
          await this.options.connection.deleteEntry(GUESS_RESULTS_STREAM, entry.id);
        }
      } catch {
        if (this.closed) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
}

/** Backwards-compatible name for the Guesser-only queue tests and imports. */
export { InferenceQueue as GuesserQueue };

function toOutcome(result: InferenceResultV1): Outcome {
  if (result.status === "answer") {
    return {
      status: "answer",
      answer: result.answer,
      confidence: result.confidence,
      ...(result.heatmap ? { heatmap: result.heatmap } : {}),
      ...(result.alternatives ? { alternatives: result.alternatives } : {}),
    };
  }
  if (result.status === "pass") return { status: "pass", reason: result.reason === "no-evidence" ? "no-evidence" : undefined };
  if (result.status === "evidence") return { status: "evidence", scores: result.scores };
  return { status: "unavailable", reason: result.reason };
}
