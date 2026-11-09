import { readFileSync } from "node:fs";
import type { CanvasOperation } from "../../../../packages/game-contracts/src/drawing";
import { ChromiumRenderer } from "./renderer";

export type Role = "guesser" | "referee";
export interface ModelIdentity { modelId: string; artifactRevision: string }
export interface ReadyModel extends ModelIdentity { labels?: string[] }
export interface Job extends ModelIdentity {
  jobId: string;
  turnId: string;
  canvasId: string;
  generation: number;
  sequence: number;
  deadlineAt: number;
  hint?: string;
}
export type Outcome =
  | { status: "answer"; answer: string; confidence: number }
  | { status: "pass"; reason?: string }
  | { status: "evidence"; scores: [number, number] }
  | { status: "unavailable"; reason: string };
export interface InferenceOptions {
  firstGuessMs: number;
  guessCooldownMs: number;
  maxGuesses: number;
  requestTimeoutMs: number;
}
export interface Inference {
  readonly options: InferenceOptions;
  ready(role: Role): ReadyModel | undefined;
  render(key: string, operations: CanvasOperation[]): Promise<Buffer | null>;
  submit(role: Role, job: Job, png: Buffer, signal: AbortSignal): Promise<Outcome>;
  close(): Promise<void>;
}
type RoleIds = Partial<Record<Role, string>>;

export class InferenceClient implements Inference {
  private models: Partial<Record<Role, ReadyModel>> = {};
  private refreshedAt = 0;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshing = false;

  constructor(
    private url: URL,
    private token: string,
    private ids: RoleIds,
    private renderer: ChromiumRenderer,
    readonly options: InferenceOptions,
  ) {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), 2500);
    this.refreshTimer.unref();
  }

  ready(role: Role) {
    return Date.now() - this.refreshedAt < 7500 ? this.models[role] : undefined;
  }

  private async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    const models: Partial<Record<Role, ReadyModel>> = {};
    try {
      const response = await fetch(new URL("/health/ready", this.url), {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        redirect: "error",
      });
      if (!response.ok) throw new Error("readiness unavailable");
      const data = await response.json() as Partial<Record<Role, Record<string, unknown>>>;
      for (const role of ["guesser", "referee"] as const) {
        const item = data?.[role];
        const id = this.ids[role];
        if (!id || item?.status !== "ready" || item.modelId !== id || typeof item.artifactRevision !== "string" || !item.artifactRevision || item.artifactRevision.length > 128) continue;
        const labels: unknown = item.labels;
        if (role === "guesser" && (!Array.isArray(labels) || labels.length !== 345 || !labels.every(label => typeof label === "string" && label.trim().length > 0 && label.length <= 100))) continue;
        models[role] = { modelId: id, artifactRevision: item.artifactRevision, ...(role === "guesser" ? { labels: labels as string[] } : {}) };
      }
      if (models.guesser || models.referee) void this.renderer.warm().catch(() => {});
    } catch {
      // Capability selection uses the next successful readiness check.
    } finally {
      this.models = models;
      this.refreshedAt = Date.now();
      this.refreshing = false;
    }
  }

  render(key: string, operations: CanvasOperation[]) {
    return this.renderer.render(key, operations);
  }

  async submit(role: Role, job: Job, png: Buffer, signal: AbortSignal): Promise<Outcome> {
    const form = new FormData();
    form.set("metadata", JSON.stringify(job));
    form.set("image", new Blob([Uint8Array.from(png)], { type: "image/png" }), "canvas.png");
    const response = await fetch(new URL(role === "guesser" ? "/v1/guess" : "/v1/referee", this.url), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      body: form,
      signal,
      redirect: "error",
    });
    if (!response.ok) return { status: "unavailable", reason: "service-error" };
    const result = await response.json() as Record<string, unknown>;
    if (!result || Object.entries(job).some(([key, value]) => key !== "hint" && result[key] !== value)) {
      return { status: "unavailable", reason: "invalid-result-binding" };
    }
    if (result.status === "unavailable") return { status: "unavailable", reason: "provider-unavailable" };
    if (role === "guesser" && result.status === "pass") return { status: "pass", reason: result.reason === "no-evidence" ? "no-evidence" : undefined };
    if (role === "guesser" && result.status === "answer" && typeof result.answer === "string" && result.answer.length <= 100 && typeof result.confidence === "number" && Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1) {
      return { status: "answer", answer: result.answer, confidence: result.confidence };
    }
    if (role === "referee" && result.status === "evidence" && Array.isArray(result.scores) && result.scores.length === 2 && result.scores.every(score => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1)) {
      return { status: "evidence", scores: [result.scores[0], result.scores[1]] };
    }
    return { status: "unavailable", reason: "invalid-result" };
  }

  async close() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.renderer.close();
  }
}

function positiveSetting(name: string, fallback: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function configuredInference(): Inference | undefined {
  const ids: RoleIds = {};
  if (process.env.GUESSER_PROVIDER === "http" && (process.env.GUESSER_MODEL_ID !== "quickdraw-int8-smoke" || process.env.AI_SMOKE_TEST === "1")) ids.guesser = process.env.GUESSER_MODEL_ID;
  if (process.env.REFEREE_PROVIDER === "http" && process.env.AI_TEST_FIXTURES === "1") ids.referee = process.env.REFEREE_MODEL_ID;
  if (!ids.guesser && !ids.referee) return;
  const options = {
    firstGuessMs: positiveSetting("AI_FIRST_GUESS_MS", 1500, 60000),
    guessCooldownMs: positiveSetting("AI_GUESS_COOLDOWN_MS", 2000, 60000),
    maxGuesses: positiveSetting("AI_MAX_GUESSES_PER_TURN", 24, 24),
    requestTimeoutMs: positiveSetting("AI_REQUEST_TIMEOUT_MS", 2500, 2500),
  };
  positiveSetting("AI_MAX_CONCURRENT_JOBS", 1, 1);
  try {
    const url = new URL(process.env.AI_SERVICE_URL ?? "");
    const rendererUrl = new URL(process.env.AI_RENDERER_URL ?? "http://127.0.0.1:3100/review/canvas/");
    const token = readFileSync(process.env.AI_SECRET_FILE ?? "/run/mmtai-secrets/ai-token", "utf8").trim();
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !/^[\x21-\x7e]{16,256}$/.test(token)) throw new Error("invalid AI connection");
    if (url.protocol === "http:" && url.origin !== "http://ai:8000" && process.env.AI_PRIVATE_LINK !== "1") throw new Error("AI requires an encrypted link");
    if (!["http:", "https:"].includes(rendererUrl.protocol) || rendererUrl.username || rendererUrl.password) throw new Error("invalid renderer URL");
    return new InferenceClient(url, token, ids, new ChromiumRenderer(rendererUrl), options);
  } catch {
    console.warn("AI configuration unavailable");
    return;
  }
}
