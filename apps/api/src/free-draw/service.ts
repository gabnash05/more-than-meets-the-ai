import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  FreeDrawCapabilities,
  FreeDrawObservation,
  FreeDrawOutcome,
  FreeDrawResult,
  FreeDrawSession,
} from "../../../../packages/game-contracts/src/free-draw";
import { isGuessAlternativesV1, isGuessHeatmapV1 } from "../../../../packages/game-contracts/src/ai-inference";
import type { Inference, Job, Role } from "../ai/client";

const MAX_SESSIONS = 256;
const IDLE_MS = 15 * 60_000;
const MAX_HISTORY = 128;
const MAX_BODY = 4 * 1024 * 1024;
const GUESSER_MIN_INTERVAL = 500;
const REFEREE_MIN_INTERVAL = 1000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ANCILLARY_CHUNKS = new Set(["sRGB", "gAMA", "pHYs"]);

interface SessionState {
  id: string;
  token: string;
  lastUsed: number;
  lastAdmission: Partial<Record<Role, number>>;
  activeRoles: Set<Role>;
  requests: Set<string>;
  active: Set<AbortController>;
}

export class FreeDrawError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfter?: number) {
    super(code);
  }
}

export function validateCanonicalPng(png: Buffer): boolean {
  if (png.length < 45 || png.length > MAX_BODY || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return false;

  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  const ancillary = new Set<string>();

  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (length > MAX_BODY || offset + 12 + length > png.length) return false;

    if (type === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) return false;
      if (png.readUInt32BE(offset + 8) !== 1024 || png.readUInt32BE(offset + 12) !== 768) return false;
      const depth = png[offset + 16];
      const color = png[offset + 17];
      if (![8, 16].includes(depth) || ![2, 6].includes(color)) return false;
      if (png[offset + 18] !== 0 || png[offset + 19] !== 0 || png[offset + 20] !== 0) return false;
      sawHeader = true;
    } else if (ANCILLARY_CHUNKS.has(type)) {
      if (!sawHeader || sawData || ancillary.has(type)) return false;
      if ((type === "sRGB" && length !== 1) || (type === "gAMA" && length !== 4) || (type === "pHYs" && length !== 9)) return false;
      ancillary.add(type);
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd) return false;
      sawData = true;
    } else if (type === "IEND") {
      if (!sawData || length !== 0 || sawEnd) return false;
      sawEnd = true;
      offset += 12;
      break;
    } else {
      return false;
    }
    offset += 12 + length;
  }
  return sawHeader && sawData && sawEnd && offset === png.length;
}

export class FreeDrawService {
  private readonly sessions = new Map<string, SessionState>();
  private activeJobs = 0;
  private closed = false;

  constructor(private readonly inference?: Inference, private readonly now = () => Date.now()) {}

  private cleanup(): void {
    const time = this.now();
    for (const [token, session] of this.sessions) {
      if (!session.active.size && time - session.lastUsed >= IDLE_MS) this.sessions.delete(token);
    }
  }

  capabilities(): FreeDrawCapabilities {
    const guesser = this.inference?.ready("guesser");
    const referee = this.inference?.ready("referee");
    const labels = guesser?.labels?.length ? [...guesser.labels] : [];
    return {
      guesser: { available: labels.length > 0, labels },
      referee: { available: !!referee },
      minIntervalMs: GUESSER_MIN_INTERVAL,
      refereeMinIntervalMs: REFEREE_MIN_INTERVAL,
    };
  }

  create(): FreeDrawSession {
    this.cleanup();
    if (this.closed) throw new FreeDrawError("unavailable", 503);
    if (this.sessions.size >= MAX_SESSIONS) throw new FreeDrawError("capacity", 503);
    const sessionId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, {
      id: sessionId,
      token,
      lastUsed: this.now(),
      lastAdmission: {},
      activeRoles: new Set(),
      requests: new Set(),
      active: new Set(),
    });
    return { sessionId, token, capabilities: this.capabilities() };
  }

  authenticate(token?: string): SessionState {
    this.cleanup();
    const session = token ? this.sessions.get(token) : undefined;
    if (this.closed || !session) throw new FreeDrawError("unauthorized", 401);
    session.lastUsed = this.now();
    return session;
  }

  dispose(token?: string): void {
    const session = this.authenticate(token);
    for (const controller of session.active) controller.abort("disposed");
    this.sessions.delete(session.token);
  }

  async infer(
    token: string | undefined,
    observation: FreeDrawObservation,
    png: Buffer,
    signal?: AbortSignal,
  ): Promise<FreeDrawResult> {
    const session = this.authenticate(token);
    if (!validateObservation(observation)) throw new FreeDrawError("invalid-observation", 400);
    if (!validateCanonicalPng(png)) throw new FreeDrawError("invalid-png", 400);
    if (session.requests.has(observation.requestId)) throw new FreeDrawError("duplicate-request", 409);

    const now = this.now();
    for (const role of observation.roles) {
      const limit = role === "guesser" ? GUESSER_MIN_INTERVAL : REFEREE_MIN_INTERVAL;
      if (session.activeRoles.has(role)) throw new FreeDrawError("busy", 429, 1);
      const elapsed = now - (session.lastAdmission[role] ?? 0);
      if (session.lastAdmission[role] !== undefined && elapsed < limit)
        throw new FreeDrawError("cooldown", 429, Math.max(1, Math.ceil((limit - elapsed) / 1000)));
    }
    if (this.activeJobs + observation.roles.length > 2) throw new FreeDrawError("busy", 429, 1);

    session.lastUsed = now;
    for (const role of observation.roles) {
      session.activeRoles.add(role);
      session.lastAdmission[role] = now;
    }
    session.requests.add(observation.requestId);
    if (session.requests.size > MAX_HISTORY) session.requests.delete(session.requests.values().next().value!);

    try {
      const outcomes: Partial<Record<Role, FreeDrawOutcome>> = {};
      await Promise.all(observation.roles.map(async role => {
        outcomes[role] = await this.inferRole(session, observation, png, role, signal, now);
      }));
      return { ...observation, sessionId: session.id, outcomes };
    } finally {
      for (const role of observation.roles) session.activeRoles.delete(role);
      session.lastUsed = this.now();
    }
  }

  private async inferRole(
    session: SessionState,
    observation: FreeDrawObservation,
    png: Buffer,
    role: Role,
    externalSignal: AbortSignal | undefined,
    admittedAt: number,
  ): Promise<FreeDrawOutcome> {
    const model = this.inference?.ready(role);
    if (!model || (role === "guesser" && !model.labels?.length)) {
      return { status: "unavailable", reason: "model-unavailable" };
    }
    if (externalSignal?.aborted) return { status: "unavailable", reason: "cancelled" };

    const controller = new AbortController();
    session.active.add(controller);
    this.activeJobs += 1;
    const abort = () => controller.abort("client-disconnected");
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();

    const timeoutMs = this.inference!.options.requestTimeoutMs;
    const timeout = setTimeout(() => controller.abort("deadline"), timeoutMs);
    const jobId = createHash("sha256")
      .update(session.id)
      .update("\0")
      .update(observation.requestId)
      .update("\0")
      .update(role)
      .digest("hex")
      .slice(0, 32);
    const job: Job = {
      jobId,
      turnId: observation.runId,
      canvasId: observation.runId,
      generation: observation.revision,
      sequence: 1,
      deadlineAt: admittedAt + timeoutMs,
      modelId: model.modelId,
      artifactRevision: model.artifactRevision,
    };

    let settleAbort!: (outcome: FreeDrawOutcome) => void;
    const aborted = new Promise<FreeDrawOutcome>(resolve => { settleAbort = resolve; });
    const onAbort = () => settleAbort({
      status: "unavailable",
      reason: controller.signal.reason === "deadline" ? "deadline" : "cancelled",
    });
    controller.signal.addEventListener("abort", onAbort, { once: true });

    if (controller.signal.aborted) onAbort();
    let providerPromise: Promise<FreeDrawOutcome>;
    if (controller.signal.aborted) {
      providerPromise = Promise.resolve({ status: "unavailable", reason: "cancelled" });
    } else {
      providerPromise = Promise.resolve()
        .then(() => this.inference!.submit(role, job, png, controller.signal))
        .then(result => controller.signal.aborted
          ? { status: "unavailable", reason: controller.signal.reason === "deadline" ? "deadline" : "cancelled" } as FreeDrawOutcome
          : sanitizeOutcome(role, result, model.labels))
        .catch(() => ({
          status: "unavailable",
          reason: controller.signal.aborted ? "cancelled" : "provider-error",
        } as FreeDrawOutcome));
    }

    void providerPromise.finally(() => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
      session.active.delete(controller);
      this.activeJobs -= 1;
    });
    return Promise.race([providerPromise, aborted]);
  }

  close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) {
      for (const controller of session.active) controller.abort("shutdown");
    }
    this.sessions.clear();
  }
}

function validateObservation(value: unknown): value is FreeDrawObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(",") === "requestId,revision,roles,runId"
    && [item.runId, item.requestId].every(v => typeof v === "string" && v.length > 0 && v.length <= 128)
    && Number.isSafeInteger(item.revision)
    && (item.revision as number) >= 0
    && Array.isArray(item.roles)
    && item.roles.length > 0
    && item.roles.length <= 2
    && item.roles.every(v => v === "guesser" || v === "referee")
    && new Set(item.roles).size === item.roles.length;
}

function sanitizeOutcome(role: Role, value: FreeDrawOutcome, labels?: string[]): FreeDrawOutcome {
  if (!value || typeof value !== "object") return { status: "unavailable", reason: "invalid-result" };
  if (value.status === "answer" && role === "guesser") {
    if (typeof value.answer !== "string" || value.answer.length > 100 || !labels?.includes(value.answer)
      || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
      return { status: "unavailable", reason: "invalid-result" };
    }
    return {
      status: "answer",
      answer: value.answer,
      confidence: value.confidence,
      ...(isGuessHeatmapV1(value.heatmap) ? { heatmap: value.heatmap } : {}),
      ...(isGuessAlternativesV1(value.alternatives) ? { alternatives: value.alternatives } : {}),
    };
  }
  if (value.status === "pass" && role === "guesser") {
    return { status: "pass", ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 128) } : {}) };
  }
  if (value.status === "evidence" && role === "referee"
    && Array.isArray(value.scores) && value.scores.length === 2
    && value.scores.every(score => Number.isFinite(score) && score >= 0 && score <= 1)) {
    return { status: "evidence", scores: [value.scores[0], value.scores[1]] };
  }
  if (value.status === "unavailable") {
    return { status: "unavailable", reason: typeof value.reason === "string" ? value.reason.slice(0, 128) : "provider-unavailable" };
  }
  return { status: "unavailable", reason: "invalid-result" };
}
