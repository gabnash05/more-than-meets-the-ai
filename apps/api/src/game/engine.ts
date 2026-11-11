import { MemoryGameStore } from "../store";
import { MAX_STROKE_APPEND_POINTS } from "../../../../packages/game-contracts/src/drawing";
import { PROMPTS } from "./prompts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PlayerProfile } from "../../../../packages/game-contracts/src/player";
import type {
  CanvasOperation,
  DrawingPayload,
} from "../../../../packages/game-contracts/src/drawing";
import type {
  RoomSession,
  RoomSettings,
  RoomSnapshot,
  PrivateRoomState,
  AiRoundResult,
  AiBenchmarkSummary,
  AiGuess,
  AiGuessEvent,
  AiRoundHistory,
  RefereeWarning,
} from "../../../../packages/game-contracts/src/room";
import { DEFAULT_ROOM_SETTINGS } from "../../../../packages/game-contracts/src/room";
import type {
  GameStore,
  EventSink,
  DisconnectSink,
  PersistedRoom,
  GuesserObservation,
  GuesserResult,
  GuesserProvider,
} from "./ports";
import { individualScores, speedPoints, teamScore, type HumanSolve } from "./scoring";

import type { Inference, Job, ModelIdentity, Outcome, Role } from "../ai/client";

type Phase = RoomSnapshot["phase"];
type Player = {
  id: string;
  profile: PlayerProfile;
  tokenHash: string;
  teamId?: string;
  joinedAt: number;
  connectedAt?: number;
  left?: boolean;
};
type Group = {
  id: string;
  drawerId: string;
  eligible: string[];
  canvasId: string;
  sequence: number;
  durableSequence: number;
  operations: CanvasOperation[];
  solves: HumanSolve[];
  closed: boolean;
  deadlineAt: number;
  pause?: {
    reason: "drawer-disconnected" | "guessers-disconnected";
    until: number;
    remainingMs: number;
  };
  openAction?: string;
  undo: string[];
  redo: string[];
  seenOps: string[];
  streams?: Record<string, number>;
};
type RoomResult = NonNullable<NonNullable<RoomSnapshot["game"]>["result"]>;
type Game = {
  generation: number;
  turnId: string;
  round: number;
  options: string[];
  target?: string;
  chooserId: string;
  groups: Group[];
  deadlineAt: number;
  result?: Omit<RoomResult, "aiAnswers"> & { aiAnswers?: string[] };
  interruptedTarget?: string;
  aiRound?: AiRoundResult;
  aiGuesses?: AiGuess[];
  refereeWarning?: RefereeWarning;
  guesserProgress?: { attempts: number; sequence?: number; hash?: string; settledAt?: number };
  refereeAt?: number;
  refereeStreak?: [number | null, number | null];
  refereeEvidence?: [boolean, boolean];
  aiJobs?: Record<string, { observation: GuesserObservation; completed: boolean }>;
};
type State = {
  code: string;
  revision: number;
  settings: RoomSettings;
  players: Player[];
  hostId: string;
  phase: Phase;
  chat: RoomSnapshot["chat"];
  scores: Record<string, number>;
  selectedPrompts?: string[];
  aiBenchmark?: AiBenchmarkSummary;
  aiHistory?: AiRoundHistory[];
  startDeadlineAt?: number;
  aiMatch?: { guesser?: ModelIdentity & { prompts: string[] }; referee?: ModelIdentity };
  round: number;
  generation: number;
  game?: Game;
  hostDisconnectedUntil?: number;
  requests: Record<string, { hash: string; ack: Ack }>;
  interrupted?: { canvasId: string; generation: number; playerIds: string[] }[];
};
type Envelope = {
  requestId: string;
  expectedRevision?: number;
  generation?: number;
  payload?: unknown;
};
type Ack = {
  ok: boolean;
  code?: string;
  message?: string;
  requestId?: string;
  revision?: number;
  sequence?: number;
  durableSequence?: number;
};
type Options = {
  store: GameStore;
  guesserProvider?: GuesserProvider;
  inference?: Inference;
  eventSink: EventSink;
  disconnectSink?: DisconnectSink;
  clock?: () => number;
  config?: {
    startMs?: number;
    chooseMs?: number;
    drawMs?: number;
    recapMs?: number;
    graceMs?: number;
  };
};
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const normalize = (value: string) =>
  value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
const clone = <T>(value: T): T => structuredClone(value);
class GameError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function requireThat(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new GameError(code, message);
}
function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}
function validSettings(value: unknown): value is RoomSettings {
  if (!value || typeof value !== "object") return false;
  const s = value as RoomSettings;
  return (
    (s.aiGuesserEnabled === undefined || typeof s.aiGuesserEnabled === "boolean") &&
    (s.aiRefereeEnabled === undefined || typeof s.aiRefereeEnabled === "boolean") &&
    (s.mode === "individual" || s.mode === "team") &&
    Number.isInteger(s.seats) &&
    s.seats >= 2 &&
    s.seats <= 8 &&
    Number.isInteger(s.teamCount) &&
    s.teamCount >= 2 &&
    s.teamCount <= 4 &&
    Number.isInteger(s.seatsPerTeam) &&
    s.seatsPerTeam >= 2 &&
    s.seatsPerTeam <= 8 &&
    Number.isInteger(s.rounds) &&
    s.rounds >= 1 &&
    s.rounds <= 20
  );
}
function validProfile(profile: PlayerProfile): boolean {
  return (
    !!profile &&
    boundedText(profile.name, 24) &&
    !!profile.avatar &&
    ["pebble", "droplet", "spark", "bean", "cloud"].includes(
      profile.avatar.shape,
    ) &&
    ["smile", "wink", "wow", "grin", "sleepy"].includes(
      profile.avatar.expression,
    ) &&
    [
      "red",
      "orange",
      "yellow",
      "green",
      "cyan",
      "blue",
      "purple",
      "pink",
    ].includes(profile.avatar.color)
  );
}
function validPoint(p: unknown): boolean {
  if (!p || typeof p !== "object") return false;
  const v = p as Record<string, unknown>;
  return (
    typeof v.x === "number" &&
    Number.isFinite(v.x) &&
    v.x >= 0 &&
    v.x <= 1024 &&
    typeof v.y === "number" &&
    Number.isFinite(v.y) &&
    v.y >= 0 &&
    v.y <= 768 &&
    typeof v.time === "number" &&
    Number.isFinite(v.time) &&
    (v.pressure === undefined ||
      (typeof v.pressure === "number" &&
        Number.isFinite(v.pressure) &&
        v.pressure >= 0 &&
        v.pressure <= 1))
  );
}
function validateOperations(group: Group, batch: DrawingPayload, seen: Set<string>, operationsJson: string): void {
  requireThat(
    Array.isArray(batch.operations) &&
      batch.operations.length > 0 &&
      batch.operations.length <= 256 &&
      operationsJson.length <= 128000,
    "invalid-drawing",
    "Drawing batch is too large or empty.",
  );
  requireThat(
    Array.isArray(batch.clientSeq) &&
      batch.clientSeq.length === 2 &&
      batch.clientSeq[1] - batch.clientSeq[0] + 1 === batch.operations.length,
    "invalid-drawing",
    "Invalid client sequence.",
  );
  let points = 0;
  const batchIds = new Set<string>();
  for (const [index, op] of batch.operations.entries()) {
    requireThat(
      boundedText(op.opId, 100) &&
        boundedText(op.actionId, 100) &&
        !seen.has(op.opId) && !batchIds.has(op.opId) &&
        Number.isFinite(op.at) &&
        op.clientSeq === batch.clientSeq[0] + index,
      "invalid-drawing",
      "Invalid or repeated drawing operation.",
    );
    if (op.type === "stroke.start") {
      requireThat(
        !group.openAction &&
          validPoint(op.point) &&
          !!op.settings &&
          ["brush", "eraser"].includes(op.settings.tool) &&
          /^#[0-9a-f]{6}$/i.test(op.settings.color) &&
          Number.isFinite(op.settings.size) &&
          op.settings.size > 0 &&
          op.settings.size <= 128,
        "invalid-drawing",
        "Invalid stroke start.",
      );
      group.openAction = op.actionId;
      points++;
    } else if (op.type === "stroke.append") {
      requireThat(
        group.openAction === op.actionId &&
          Array.isArray(op.points) &&
          op.points.length > 0 &&
          op.points.length <= MAX_STROKE_APPEND_POINTS &&
          op.points.every(validPoint),
        "invalid-drawing",
        "Invalid stroke continuation.",
      );
      points += op.points.length;
    } else if (op.type === "stroke.end") {
      requireThat(
        group.openAction === op.actionId && validPoint(op.point),
        "invalid-drawing",
        "Invalid stroke end.",
      );
      group.openAction = undefined;
      group.undo.push(op.actionId);
      group.redo = [];
      points++;
    } else if (op.type === "fill") {
      requireThat(
        !group.openAction &&
          validPoint(op.point) &&
          /^#[0-9a-f]{6}$/i.test(op.color) &&
          Number.isFinite(op.tolerance) &&
          op.tolerance >= 0 &&
          op.tolerance <= 255,
        "invalid-drawing",
        "Invalid fill.",
      );
      group.undo.push(op.actionId);
      group.redo = [];
      points++;
    } else if (op.type === "canvas.clear") {
      requireThat(
        !group.openAction,
        "invalid-drawing",
        "Cannot clear during a stroke.",
      );
      group.undo.push(op.actionId);
      group.redo = [];
    } else if (op.type === "history.undo") {
      requireThat(
        !group.openAction && group.undo.at(-1) === op.targetActionId,
        "invalid-drawing",
        "Invalid undo target.",
      );
      group.undo.pop();
      group.redo.push(op.targetActionId);
    } else if (op.type === "history.redo") {
      requireThat(
        !group.openAction && group.redo.at(-1) === op.targetActionId,
        "invalid-drawing",
        "Invalid redo target.",
      );
      group.redo.pop();
      group.undo.push(op.targetActionId);
    } else throw new GameError("invalid-drawing", "Unknown drawing operation.");
    batchIds.add(op.opId);
  }
  requireThat(points <= 2048, "invalid-drawing", "Too many drawing points.");
}

function emptyBenchmark(): AiBenchmarkSummary {
  return { totalPoints: null, scoredRounds: 0, solvedRounds: 0, completedRounds: 0 };
}
function unavailableRound(reason = "AI inference is unavailable"): AiRoundResult {
  return { scoringVersion: "ai-benchmark-v1", status: "unavailable", points: null, elapsedMs: null, reason };
}

export class RoomEngine {
  private rooms = new Map<string, State>();
  private creatingCodes = new Set<string>();
  private inferenceTimer?: ReturnType<typeof setInterval>;
  private inferenceCursor: Partial<Record<Role, string>> = {};
  private activeInference = new Map<string, { role: Role; code: string; controller: AbortController; guessing: boolean }>();
  private idleSince = new Map<string, number>();
  private canvasBytes = new Map<string, number>();
  private roomBytes = new Map<string, number>();
  private seenOperationIds = new WeakMap<Group, { length: number; ids: Set<string> }>();
  private evictionTimer?: ReturnType<typeof setInterval>;
  private connections = new Map<string, { code: string; playerId: string }>();
  private leases = new Map<string, string>();
  private queues = new Map<string, Promise<unknown>>();
  private archives = new Map<string, Promise<void>>();
  private archiveCounts = new Map<string, number>();
  private archiveErrors = new Set<string>();
  private resultSaveErrors = new Set<string>();
  private stopping = false;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingFinalizations = new Set<string>();
  private archivePublishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private now: () => number;
  private startMs: number;
  private chooseMs: number;
  private drawMs: number;
  private recapMs: number;
  private graceMs: number;
  constructor(private options: Options) {
    this.now = options.clock ?? Date.now;
    this.startMs = options.config?.startMs ?? 3000;
    this.chooseMs = options.config?.chooseMs ?? 15000;
    this.drawMs = options.config?.drawMs ?? 60000;
    this.recapMs = options.config?.recapMs ?? 8000;
    this.graceMs = options.config?.graceMs ?? 30000;
    if (options.inference) {
      this.inferenceTimer = setInterval(() => {
        this.scheduleObservations();
      }, 200);
      this.inferenceTimer.unref();
    }
    if (options.store instanceof MemoryGameStore) {
      this.evictionTimer = setInterval(() => { void this.evictIdle(); }, 60000);
      this.evictionTimer.unref();
    }
  }
  private async evictIdle(): Promise<void> {
    if (!(this.options.store instanceof MemoryGameStore)) return;
    for (const [code, since] of this.idleSince) {
      if (this.now() - since < 30 * 60 * 1000) continue;
      await this.serial(code, async () => {
        if ([...this.connections.values()].some(connection => connection.code === code) || this.now() - (this.idleSince.get(code) ?? this.now()) < 30 * 60 * 1000) return;
        this.cancelInference(code);
        await this.archives.get(code);
        const timer = this.timers.get(code); if (timer) clearTimeout(timer);
        this.timers.delete(code);
        const archiveTimer = this.archivePublishTimers.get(code); if (archiveTimer) clearTimeout(archiveTimer);
        this.archivePublishTimers.delete(code); this.rooms.delete(code); this.idleSince.delete(code);
        this.archives.delete(code); this.archiveCounts.delete(code); this.archiveErrors.delete(code); this.resultSaveErrors.delete(code);
        this.roomBytes.delete(code);
        for (const key of this.canvasBytes.keys()) if (key.startsWith(`${code}:`)) this.canvasBytes.delete(key);
        for (const key of this.leases.keys()) if (key.startsWith(`${code}:`)) this.leases.delete(key);
        (this.options.store as MemoryGameStore).deleteRoom(code);
      });
    }
  }
  private clearRefereeWarning(game: Game): boolean {
    const hadWarning = game.refereeWarning !== undefined;
    game.refereeStreak = undefined;
    game.refereeWarning = undefined;
    return hadWarning;
  }

  private inferenceKey(code: string, role: Role): string {
    return `${code}:${role}`;
  }

  private cancelInference(code: string): boolean {
    const game = this.rooms.get(code)?.game;
    const warningCleared = game ? this.clearRefereeWarning(game) : false;
    for (const active of this.activeInference.values()) {
      if (active.code === code) {
        active.guessing = false;
        active.controller.abort("invalidated");
      }
    }
    return warningCleared;
  }

  private liveObservation(code: string, job: Pick<Job, "turnId" | "canvasId" | "generation">) {
    const room = this.rooms.get(code);
    const game = room?.game;
    const group = game?.groups[0];
    if (!room || !game || !group || room.phase !== "drawing" || group.closed || group.pause || this.now() >= group.deadlineAt ||
        game.turnId !== job.turnId || game.generation !== job.generation || group.canvasId !== job.canvasId) return;
    return { room, game, group };
  }

  private recordGuess(game: Game, group: Group, outcome: Exclude<Outcome, { status: "evidence" | "answer" }> | ({ status: "answer" } & AiGuess)) {
    if (outcome.status === "unavailable") {
      game.aiRound = unavailableRound(outcome.reason);
      return;
    }
    if (outcome.status === "pass" && outcome.reason === "no-evidence") return;
    if (outcome.status === "answer") {
      const elapsedMs = Math.max(0, this.drawMs - (group.deadlineAt - this.now()));
      const submitted = typeof outcome.confidence === "number" && Number.isFinite(outcome.confidence) && outcome.confidence > 0.5 && outcome.confidence <= 1;
      (game.aiGuesses ??= []).push({ answer: outcome.answer, confidence: outcome.confidence, elapsedMs, submitted });
      if (submitted && normalize(outcome.answer) === normalize(game.target!)) {
        game.aiRound = { scoringVersion: "ai-benchmark-v1", status: "solved", points: speedPoints(elapsedMs, this.drawMs), elapsedMs };
        return;
      }
    }
    game.aiRound = { scoringVersion: "ai-benchmark-v1", status: "unsolved", points: 0, elapsedMs: null };
  }

  /**
   * Dispatch every due observation that has no job in flight.
   *
   * For each role, scan room codes in round-robin order so repeated passes do
   * not always put the same room first. A room/role pair is skipped while its
   * previous observation is still pending: canvas updates coalesce into the
   * next eligible pass instead of building one queued job per stroke. Roles
   * that become due in the same room share one rendered canvas and reservation.
   */
  private scheduleObservations(): void {
    const inference = this.options.inference;
    if (!inference || this.stopping) return;
    const codes = [...this.rooms.keys()];
    const planned = new Map<string, Role[]>();
    for (const role of ["guesser", "referee"] as const) {
      const previous = codes.indexOf(this.inferenceCursor[role] ?? "");
      let nextCursor: string | undefined;
      for (let offset = 1; offset <= codes.length; offset++) {
        const code = codes[(previous + offset) % codes.length];
        const room = this.rooms.get(code);
        if (!room || this.activeInference.has(this.inferenceKey(code, role)) || !this.observationDue(room, role)) continue;
        nextCursor ??= code;
        const roles = planned.get(code) ?? [];
        roles.push(role);
        planned.set(code, roles);
      }
      if (nextCursor) this.inferenceCursor[role] = nextCursor;
    }
    for (const [code, roles] of planned) {
      for (const role of roles) this.activeInference.set(this.inferenceKey(code, role), { role, code, controller: new AbortController(), guessing: false });
      void this.observeGroup(code, roles);
    }
  }

  private observationDue(room: State, role: Role): boolean {
    const inference = this.options.inference!;
    const game = room.game;
    const group = game?.groups[0];
    const now = this.now();
    if (!room.aiMatch?.[role] || !game || !group || !group.sequence || room.phase !== "drawing" ||
        room.settings.mode !== "individual" || group.closed || group.pause || now >= group.deadlineAt) return false;
    const at = this.drawMs - (group.deadlineAt - now);
    if (role === "referee") return at >= 1000 && (game.refereeAt === undefined || at >= game.refereeAt + 1000);
    const progress = game.guesserProgress;
    return game.aiRound?.status !== "solved" && game.aiRound?.status !== "unavailable" && at >= Math.max(3000, inference.options.firstGuessMs) &&
      (progress?.attempts ?? 0) < Math.min(24, inference.options.maxGuesses) && progress?.sequence !== group.sequence &&
      (progress?.settledAt === undefined || at >= progress.settledAt + Math.max(3000, inference.options.guessCooldownMs));
  }

  private async observeGroup(code: string, roles: Role[]): Promise<void> {
    const inference = this.options.inference!;
    const reserved = await this.serial(code, async () => {
      const room = this.rooms.get(code);
      if (!room) return;
      const due = roles.filter(role => !this.activeInference.get(this.inferenceKey(code, role))?.controller.signal.aborted && this.observationDue(room, role));
      if (!due.length) return;
      const game = room.game!;
      const group = game.groups[0];
      const now = this.now();
      const at = this.drawMs - (group.deadlineAt - now);
      if (due.includes("guesser")) game.guesserProgress ??= { attempts: 0 };
      if (due.includes("referee")) {
        if (game.refereeWarning && now >= game.refereeWarning.expiresAt) {
          this.clearRefereeWarning(game);
          this.publish(room);
        }
        game.refereeAt = at;
      }
      const operations = group.operations.slice();
      const jobs = due.map(role => {
        const model = room.aiMatch![role]!;
        const job: Job = { jobId: randomUUID(), turnId: game.turnId, canvasId: group.canvasId, generation: game.generation,
          sequence: group.sequence, deadlineAt: group.deadlineAt, modelId: model.modelId, artifactRevision: model.artifactRevision,
          ...(role === "guesser" ? { hint: this.hint(group, game.target!) } : {}) };
        return { role, job };
      });
      return { jobs, operations, at };
    }).catch(() => undefined);
    if (!reserved) {
      for (const role of roles) this.activeInference.delete(this.inferenceKey(code, role));
      return;
    }
    for (const role of roles) if (!reserved.jobs.some(entry => entry.role === role)) this.activeInference.delete(this.inferenceKey(code, role));
    let png: Buffer | null | undefined;
    try {
      const job = reserved.jobs[0].job;
      png = await inference.render(`${job.canvasId}:${job.generation}:${job.sequence}`, reserved.operations);
    } catch {
      png = undefined;
    }
    await Promise.all(reserved.jobs.map(({ role, job }) => this.observe(code, role, { job, at: reserved.at }, png)));
  }

  private async observe(code: string, role: Role, reserved: { job: Job; at: number }, png: Buffer | null | undefined): Promise<void> {
    const inference = this.options.inference!;
    const active = this.activeInference.get(this.inferenceKey(code, role))!;
    const { signal } = active.controller;
    let submittedAt: number | undefined;
    let outcome: Outcome | undefined;
    try {
      const { job, at } = reserved;
      if (png === undefined) throw new Error("render-failed");
      const hash = role === "guesser" && png ? digest(png) : undefined;
      const send = await this.serial(active.code, async () => {
        const live = this.liveObservation(active.code, job);
        if (!live || signal.aborted) return false;
        if (role === "guesser") {
          const progress = live.game.guesserProgress!;
          progress.sequence = job.sequence;
          if (!hash || progress.hash === hash) return false;
          progress.hash = hash;
          progress.attempts++;
          active.guessing = true;
          this.publish(live.room);
        } else if (!png) {
          if (this.clearRefereeWarning(live.game)) this.publish(live.room);
          return false;
        }
        job.deadlineAt = Math.min(live.group.deadlineAt, this.now() + inference.options.requestTimeoutMs);
        return true;
      });
      if (!send || !png || signal.aborted) return;
      submittedAt = this.now();
      const timer = setTimeout(() => active.controller.abort("timeout"), Math.max(1, job.deadlineAt - submittedAt));
      try {
        outcome = await inference.submit(role, job, png, signal);
      } catch {
        outcome = { status: "unavailable", reason: signal.reason === "timeout" ? "request-timeout" : "transport-failed" };
      } finally {
        clearTimeout(timer);
      }
      await this.serial(active.code, async () => {
        const live = this.liveObservation(active.code, job);
        if (!live || signal.reason === "invalidated" || this.stopping || !outcome) return;
        if (this.now() >= job.deadlineAt || signal.reason === "timeout") outcome = { status: "unavailable", reason: "request-timeout" };
        const { game, group } = live;
        active.guessing = false;
        if (role === "guesser" && outcome.status !== "evidence") {
          game.guesserProgress!.settledAt = this.drawMs - (group.deadlineAt - this.now());
          if (game.aiRound?.status === "solved" || game.aiRound?.status === "unavailable") return;
          if (outcome.status === "answer") {
            const answer = normalize(outcome.answer);
            const canonical = Number.isFinite(outcome.confidence) && outcome.confidence >= 0 && outcome.confidence <= 1
              ? live.room.aiMatch?.guesser?.prompts.find(word => normalize(word) === answer) : undefined;
            this.recordGuess(game, group, canonical ? { status: "answer", answer: canonical, confidence: outcome.confidence } : { status: "pass" });
            if (canonical && Number.isFinite(outcome.confidence) && outcome.confidence > 0.5 && outcome.confidence <= 1) {
              const event: AiGuessEvent = { type: "ai-guess", jobId: job.jobId, canvasId: job.canvasId, generation: job.generation, correct: normalize(canonical) === normalize(game.target!) };
              for (const player of live.room.players) {
                const connection = this.leases.get(`${live.room.code}:${player.id}`);
                if (connection) this.options.eventSink(connection, event);
              }
              console.info(JSON.stringify({
                event: "guesser_accepted", jobId: job.jobId, canvasId: job.canvasId, generation: job.generation,
                sequence: job.sequence, modelId: job.modelId, artifactRevision: job.artifactRevision,
              }));
            }
          } else this.recordGuess(game, group, outcome);
          this.publish(live.room);
        } else if (role === "referee") {
          const previousWarning = game.refereeWarning;
          const streak = game.refereeStreak ??= [null, null];
          const evidence = game.refereeEvidence ??= [false, false];
          let textConfirmed = false;
          for (const channel of [0, 1] as const) {
            const previous = streak[channel];
            if (outcome.status !== "evidence" || outcome.scores[channel] < 0.5) streak[channel] = null;
            else {
              if (previous !== null && at - previous >= 1000 && at - previous <= 3000) {
                evidence[channel] = true;
                if (channel === 0) textConfirmed = true;
              }
              streak[channel] = at;
            }
          }
          const now = this.now();
          const currentWarning = previousWarning !== undefined && previousWarning.expiresAt > now;
          game.refereeWarning = outcome.status === "evidence" && outcome.scores[0] >= 0.5 && (textConfirmed || currentWarning)
            ? { confidence: outcome.scores[0], expiresAt: now + 3000 }
            : undefined;
          if (game.refereeWarning !== previousWarning) this.publish(live.room);
        }
      });
    } catch {
      if (!signal.aborted && !this.stopping) {
        const job = reserved.job;
        await this.serial(active.code, async () => {
          const live = this.liveObservation(active.code, job);
          if (!live || signal.aborted) return;
          if (role === "guesser" && live.game.aiRound?.status !== "solved") {
            active.guessing = false;
            this.recordGuess(live.game, live.group, { status: "unavailable", reason: "render-failed" });
            this.publish(live.room);
          }
          if (role === "referee" && this.clearRefereeWarning(live.game)) this.publish(live.room);
        });
      }
    } finally {
      if (active.guessing) {
        await this.serial(active.code, async () => {
          const live = this.liveObservation(active.code, reserved.job);
          active.guessing = false;
          if (live) this.publish(live.room);
        });
      }
      this.activeInference.delete(this.inferenceKey(code, role));
      console.info(JSON.stringify({
        event: "inference", role, revision: reserved.job.artifactRevision,
        outcome: signal.reason === "invalidated" ? "cancelled" : (outcome?.status ?? (submittedAt === undefined ? "skipped" : "failed")),
        elapsedMs: submittedAt === undefined ? null : this.now() - submittedAt,
      }));
    }
  }

  /** Trusted server integration only. Clients cannot reserve or submit inference jobs. */
  async reserveGuesserObservation(code: string): Promise<GuesserObservation> {
    return this.serial(code.toUpperCase(), async () => {
      const room = this.get(code);
      const game = room.game;
      const group = game?.groups[0];
      requireThat(room.settings.aiGuesserEnabled !== false && room.settings.mode === "individual" && room.phase === "drawing" && game && group && !group.closed && !group.pause && this.now() < group.deadlineAt && game.aiRound?.status !== "solved" && game.aiRound?.status !== "unavailable", "unavailable", "AI observation is unavailable.");
      const observation: GuesserObservation = { jobId: randomUUID(), turnId: game.turnId, canvasId: group.canvasId, generation: game.generation, sequence: group.sequence, hint: this.hint(group, game.target!), deadlineAt: group.deadlineAt };
      game.aiJobs ??= {};
      game.aiJobs[observation.jobId] = { observation, completed: false };
      return clone(observation);
    });
  }

  /** Accept a previously reserved result in authoritative room order. */
  async acceptGuesserResult(code: string, observation: GuesserObservation, result: GuesserResult): Promise<boolean> {
    return this.serial(code.toUpperCase(), async () => {
      const room = this.get(code);
      const game = room.game;
      const group = game?.groups[0];
      const job = game?.aiJobs?.[observation.jobId];
      if (!game || !group || !job || job.completed || result.jobId !== observation.jobId || JSON.stringify(job.observation) !== JSON.stringify(observation) || room.phase !== "drawing" || group.closed || group.pause || game.generation !== observation.generation || game.turnId !== observation.turnId || this.now() >= observation.deadlineAt || this.now() >= group.deadlineAt || game.aiRound?.status === "solved" || game.aiRound?.status === "unavailable") return false;
      if (result.status === "answer" && result.confidence !== undefined && (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1)) return false;
      job.completed = true;
      if (result.status === "unavailable") this.recordGuess(game, group, { status: "unavailable", reason: result.reason ?? "provider-unavailable" });
      else {
        const canonical = (room.aiMatch?.guesser?.prompts ?? PROMPTS).find(word => normalize(word) === normalize(result.answer));
        if (canonical) this.recordGuess(game, group, { status: "answer", answer: canonical, confidence: result.confidence });
      }
      return true;
    });
  }

  private async serial<T>(code: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(code) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(fn);
    this.queues.set(code, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(code) === next) this.queues.delete(code);
    }
  }
  private persisted(room: State): PersistedRoom {
    // Strip journal geometry before deep cloning: drawings have their own archive.
    // Clone every remaining nested value so stores cannot mutate the live room.
    const copy = clone({
      ...room,
      ...(room.game ? { game: {
        ...room.game,
        groups: room.game.groups.map(group => ({ ...group, operations: [] })),
      } } : {}),
    });
    return {
      code: room.code,
      state: copy as unknown as Record<string, unknown>,
    };
  }
  private async save(room: State): Promise<void> {
    await this.options.store.saveRoom(this.persisted(room));
  }
  async initialize(): Promise<void> {
    for (const saved of await this.options.store.loadRooms()) {
      const room = saved.state as unknown as State;
      room.requests ??= {};
      room.settings = { ...DEFAULT_ROOM_SETTINGS, ...room.settings };
      room.aiBenchmark ??= {
        ...emptyBenchmark(),
        completedRounds: room.phase === "result" || room.phase === "finished"
          ? room.round
          : ["choosing", "drawing", "interrupted"].includes(room.phase)
            ? Math.max(0, room.round - 1)
            : 0,
      };
      if (room.phase === "starting") { room.phase = "lobby"; delete room.startDeadlineAt; }
      room.players.forEach((p) => {
        delete p.connectedAt;
      });
      if (["choosing", "drawing"].includes(room.phase) && room.game) {
        room.phase = "interrupted";
        room.game.interruptedTarget = room.game.target;
        for (const group of room.game.groups) {
          const records = await this.options.store.loadDrawing(
            room.code,
            group.canvasId,
            room.game.generation,
          );
          records.sort((a, b) => a.sequence - b.sequence);
          group.operations = records.flatMap(
            (record) => record.operations,
          ) as CanvasOperation[];
          group.sequence = records.at(-1)?.sequence ?? 0;
          group.durableSequence = group.sequence;
        }
        room.interrupted ??= [];
        for (const group of room.game.groups)
          room.interrupted.push({
            canvasId: group.canvasId,
            generation: room.game.generation,
            playerIds:
              room.settings.mode === "individual"
                ? room.players.map((p) => p.id)
                : room.players
                    .filter((p) => p.teamId === group.id)
                    .map((p) => p.id),
          });
        await this.save(room);
      }
      this.rooms.set(room.code, room);
    }
  }
  private get(code: string): State {
    const room = this.rooms.get(code.toUpperCase());
    requireThat(room, "not-found", "Room not found.");
    return room;
  }
  private player(room: State, token: string): Player {
    const player = room.players.find((p) => p.tokenHash === digest(token));
    requireThat(player, "unauthorized", "Session is invalid.");
    return player;
  }
  private connected(room: State, player: Player): boolean {
    return this.leases.has(`${room.code}:${player.id}`);
  }
  private teams(room: State) {
    return room.settings.mode === "team"
      ? Array.from({ length: room.settings.teamCount }, (_, i) => ({
          id: `team-${i + 1}`,
          name: `Team ${i + 1}`,
          capacity: room.settings.seatsPerTeam,
        }))
      : [];
  }
  private group(room: State, player: Player): Group | undefined {
    return room.game?.groups.find(
      (g) => room.settings.mode === "individual" || g.id === player.teamId,
    );
  }
  private hint(group: Group, target: string): string {
    const remaining =
      group.pause?.remainingMs ?? Math.max(0, group.deadlineAt - this.now());
    const elapsed = Math.max(0, this.drawMs - remaining);
    const letters = [...target].filter((c) => c !== " ").length;
    const count = Math.min(
      Math.max(0, letters - 1),
      elapsed >= (this.drawMs * 2) / 3 ? 2 : elapsed >= this.drawMs / 3 ? 1 : 0,
    );
    let shown = 0;
    return [...target]
      .map((c) => (c === " " ? " " : shown++ < count ? c : "_"))
      .join("");
  }
  private projection(
    room: State,
    viewer: Player,
  ): { snapshot: RoomSnapshot; privateState: PrivateRoomState } {
    const game = room.game;
    const group = this.group(room, viewer);
    const now = this.now();
    const privateState: PrivateRoomState = group
      ? {
          role:
            group.drawerId === viewer.id
              ? "drawer"
              : group.eligible.includes(viewer.id)
                ? "guesser"
                : "spectator",
        }
      : {};
    if (game && room.phase === "choosing" && game.chooserId === viewer.id)
      privateState.promptOptions = game.options.map((label) => ({
        id: label,
        label,
      }));
    if (
      game?.target &&
      group?.drawerId === viewer.id &&
      room.phase === "drawing"
    )
      privateState.target = game.target;
    const snapshot: RoomSnapshot = {
      code: room.code,
      revision: room.revision,
      settings: clone(room.settings),
      players: room.players.map((p) => ({
        id: p.id,
        profile: clone(p.profile),
        connected: this.connected(room, p),
        teamId: p.teamId,
        joinedAt: p.joinedAt,
        solved: this.group(room, p)?.solves.some((s) => s.playerId === p.id),
        score: room.scores[p.id] ?? 0,
      })),
      teams: this.teams(room),
      hostId: room.hostId,
      phase: room.phase,
      chat: clone(room.chat),
      serverTime: now,
      canReturnToLobby:
        viewer.id === room.hostId &&
        (room.phase === "finished" ||
          room.phase === "interrupted" ||
          (room.phase === "result" && (!this.ready(room) || !this.hasPromptOptions(room)))),
      startBlockers: [
        ...(room.settings.mode === "team" ? ["Team mode is not available yet."] : []),
        ...(!this.ready(room) ? ["At least two connected players are required."] : []),
        ...(room.phase !== "lobby" && !this.hasPromptOptions(room) ? ["Not enough unused prompts remain."] : []),
      ],
      aiBenchmark: clone(room.aiBenchmark ?? emptyBenchmark()),
      aiHistory: room.aiHistory && clone(room.aiHistory),
      startDeadlineAt: room.phase === "starting" ? room.startDeadlineAt : undefined,
      hostDisconnectedUntil: room.hostDisconnectedUntil,
      interruptedSketches: room.interrupted
        ?.filter((entry) => entry.playerIds.includes(viewer.id))
        .map(({ canvasId, generation }) => ({ canvasId, generation })),
    };
    if (game && group)
      snapshot.game = {
        closing: room.phase === "drawing" && game.groups.every(entry => entry.closed),
        saving: this.resultSaveErrors.has(room.code)
          ? "blocked"
          : (this.archiveCounts.get(room.code) ?? 0)
            ? this.archiveErrors.has(room.code)
              ? "blocked"
              : "saving"
            : "idle",
        choosingPlayerId: game.chooserId,
        teamProgress:
          room.settings.mode === "team"
            ? game.groups.map((entry) => ({
                teamId: entry.id,
                drawerId: entry.drawerId,
                status:
                  room.phase === "choosing"
                    ? "choosing"
                    : entry.closed
                      ? entry.solves.length
                        ? "solved"
                        : "finished"
                      : "drawing",
                solvedBy: entry.solves[0]?.playerId,
                score: room.scores[entry.id] ?? 0,
              }))
            : undefined,
        generation: game.generation,
        canvasId: group.canvasId,
        drawerId: group.drawerId,
        hint: game.target ? this.hint(group, game.target) : "",
        time: "",
        scores: clone(room.scores),
        round: game.round,
        position: { round: game.round },
        deadlineAt:
          room.phase === "choosing" || room.phase === "result"
            ? game.deadlineAt
            : group.deadlineAt,
        pause: group.pause,
        sync: {
          sequence: group.sequence,
          durableSequence: group.durableSequence,
        },
        refereeWarning: room.phase === "drawing" && !group.pause && game.refereeWarning && game.refereeWarning.expiresAt > now ? game.refereeWarning : undefined,
        aiStatus: game.aiRound?.status === "unavailable" || !room.aiMatch?.guesser ? "unavailable" : game.aiRound?.status === "solved" ? "correct" : this.activeInference.get(this.inferenceKey(room.code, "guesser"))?.guessing ? "guessing" : "waiting",
        scoringEligibility: {
          eligible: false,
          reason: "AI inference is unavailable",
        },
        result: game.result && {
          ...game.result,
          aiAnswers: game.result.aiGuesses?.map(guess => guess.answer) ?? game.result.aiAnswers ?? [],
          aiBenchmark: game.result.aiBenchmark ?? unavailableRound(),
          ...(room.settings.mode === "individual" && room.round < room.settings.rounds
            ? { nextDrawerId: this.nextDrawer(room, "individual")?.id }
            : {}),
        },
      };
    if (room.phase === "finished") {
      snapshot.finalStandings = Object.entries(room.scores)
        .map(([id, score]) =>
          room.settings.mode === "team"
            ? { teamId: id, score }
            : { playerId: id, score },
        )
        .sort((a, b) => b.score - a.score);
      const high = snapshot.finalStandings[0]?.score;
      snapshot.winners = snapshot.finalStandings
        .filter((s) => s.score === high)
        .map((s) => s.playerId ?? s.teamId!);
    }
    return { snapshot, privateState };
  }
  private scheduleArchivePublish(room: State): void {
    if (this.stopping || this.rooms.get(room.code) !== room || this.archivePublishTimers.has(room.code)) return;
    const generation = room.game?.generation;
    const timer = setTimeout(() => {
      // Retain the token until the queued callback runs, so an immediate publish
      // can supersede even a timer that has already fired.
      void this.serial(room.code, async () => {
        if (this.archivePublishTimers.get(room.code) !== timer) return;
        this.archivePublishTimers.delete(room.code);
        if (!this.stopping && this.rooms.get(room.code) === room && room.game?.generation === generation) this.publish(room);
      });
    }, 200);
    this.archivePublishTimers.set(room.code, timer);
  }
  private publish(room: State): void {
    const timer = this.archivePublishTimers.get(room.code);
    if (timer) clearTimeout(timer);
    this.archivePublishTimers.delete(room.code);
    for (const p of room.players) {
      const id = this.leases.get(`${room.code}:${p.id}`);
      if (id)
        this.options.eventSink(id, {
          type: "snapshot",
          ...this.projection(room, p),
        });
    }
  }
  private session(room: State, player: Player, token: string): RoomSession {
    return {
      ...this.projection(room, player),
      playerId: player.id,
      resumeToken: token,
      demo: false,
    };
  }
  async create(profile: PlayerProfile): Promise<RoomSession> {
    requireThat(
      validProfile(profile),
      "invalid-profile",
      "Invalid player profile.",
    );
    await this.evictIdle();
    if (this.options.store instanceof MemoryGameStore) requireThat(this.rooms.size + this.creatingCodes.size < 32, "room-limit", "Room capacity reached. Please try again later.");
    let code: string;
    do {
      code = randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
    } while (this.rooms.has(code) || this.creatingCodes.has(code));
    this.creatingCodes.add(code);
    const token = randomBytes(32).toString("base64url");
    const player: Player = {
      id: randomUUID(),
      profile: clone(profile),
      tokenHash: digest(token),
      joinedAt: this.now(),
    };
    const room: State = {
      code,
      revision: 1,
      settings: clone(DEFAULT_ROOM_SETTINGS),
      players: [player],
      hostId: player.id,
      phase: "lobby",
      chat: [],
      scores: {},
      round: 0,
      generation: 0,
      requests: {},
    };
    try { await this.save(room); } finally { this.creatingCodes.delete(code); }
    this.rooms.set(code, room);
    if (this.options.store instanceof MemoryGameStore) this.idleSince.set(code, this.now());
    return this.session(room, player, token);
  }
  async join(code: string, profile: PlayerProfile): Promise<RoomSession> {
    return this.serial(code.toUpperCase(), async () => {
      const room = this.get(code);
      requireThat(
        room.phase === "lobby",
        "in-progress",
        "Match is already in progress.",
      );
      requireThat(
        validProfile(profile),
        "invalid-profile",
        "Invalid player profile.",
      );
      const team = this.teams(room)
        .map((t) => ({
          ...t,
          count: room.players.filter((p) => p.teamId === t.id).length,
        }))
        .sort((a, b) => a.count - b.count)
        .find((t) => t.count < room.settings.seatsPerTeam);
      requireThat(
        room.settings.mode === "individual"
          ? room.players.length < room.settings.seats
          : team,
        "full",
        "Room is full.",
      );
      const token = randomBytes(32).toString("base64url");
      const player: Player = {
        id: randomUUID(),
        profile: clone(profile),
        tokenHash: digest(token),
        joinedAt: this.now(),
        teamId: team?.id,
      };
      const candidate = clone(room);
      candidate.players.push(player);
      candidate.revision++;
      await this.save(candidate);
      Object.assign(room, candidate);
      this.publish(room);
      return this.session(room, player, token);
    });
  }
  async interruptedSketch(
    code: string,
    token: string,
    canvasId: string,
    generation: number,
  ): Promise<{
    canvasId: string;
    generation: number;
    sequence: number;
    operations: unknown[];
  }> {
    const room = this.get(code);
    const player = this.player(room, token);
    const sketch = room.interrupted?.find(
      (entry) =>
        entry.canvasId === canvasId &&
        entry.generation === generation &&
        entry.playerIds.includes(player.id),
    );
    requireThat(sketch, "not-found", "Saved sketch not found.");
    const records = await this.options.store.loadDrawing(
      room.code,
      canvasId,
      generation,
    );
    records.sort((a, b) => a.sequence - b.sequence);
    return {
      canvasId,
      generation,
      sequence: records.at(-1)?.sequence ?? 0,
      operations: records.flatMap((record) => record.operations),
    };
  }
  async resume(code: string, token: string): Promise<RoomSession> {
    await this.evictIdle();
    const room = this.get(code);
    return this.session(room, this.player(room, token), token);
  }
  async connect(
    code: string,
    token: string,
    connectionId: string,
  ): Promise<RoomSession> {
    return this.serial(code.toUpperCase(), async () => {
      const room = this.get(code);
      const player = this.player(room, token);
      const key = `${room.code}:${player.id}`;
      const old = this.leases.get(key);
      const backup = clone(room);
      this.connections.set(connectionId, {
        code: room.code,
        playerId: player.id,
      });
      this.leases.set(key, connectionId);
      this.idleSince.delete(room.code);
      player.connectedAt = this.now();
      if (room.hostDisconnectedUntil && room.hostDisconnectedUntil <= this.now()) {
        const next = room.players.filter((p) => this.connected(room, p) && !p.left)
          .sort((a, b) => (a.connectedAt ?? 0) - (b.connectedAt ?? 0) || a.joinedAt - b.joinedAt)[0];
        if (next) room.hostId = next.id;
        delete room.hostDisconnectedUntil;
      } else if (room.hostId === player.id) delete room.hostDisconnectedUntil;
      this.resumeGroups(room);
      room.revision++;
      try {
        await this.save(room);
      } catch (error) {
        Object.assign(room, backup);
        this.connections.delete(connectionId);
        if (old) this.leases.set(key, old);
        else { this.leases.delete(key); if (![...this.connections.values()].some(connection => connection.code === room.code)) this.idleSince.set(room.code, this.now()); }
        throw error;
      }
      if (old && old !== connectionId) {
        this.closeStroke(room, player.id);
        this.connections.delete(old);
        this.options.disconnectSink?.(old);
      }
      this.publish(room);
      this.schedule(room);
      return this.session(room, player, token);
    });
  }
  private archive(
    room: State,
    group: Group,
    operations: CanvasOperation[],
  ): void {
    const record = {
      roomCode: room.code,
      canvasId: group.canvasId,
      generation: room.game!.generation,
      sequence: group.sequence,
      operations: clone(operations),
    };
    this.archiveCounts.set(
      room.code,
      (this.archiveCounts.get(room.code) ?? 0) + 1,
    );
    const archive = (this.archives.get(room.code) ?? Promise.resolve()).then(
      async () => {
        for (;;) {
          if (this.stopping) return;
          try {
            await this.options.store.appendDrawing(record);
            const recovered = this.archiveErrors.delete(room.code);
            if (recovered) this.publish(room);
            break;
          } catch {
            if (!this.archiveErrors.has(room.code)) {
              this.archiveErrors.add(room.code);
              this.publish(room);
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        const live =
          room.game?.generation === record.generation
            ? room.game.groups.find((item) => item.canvasId === record.canvasId)
            : undefined;
        if (live) live.durableSequence = record.sequence;
        this.archiveCounts.set(
          room.code,
          (this.archiveCounts.get(room.code) ?? 1) - 1,
        );
        this.scheduleArchivePublish(room);
        this.requestFinalization(room);
      },
    );
    this.archives.set(room.code, archive);
  }
  private closeStroke(room: State, playerId: string): void {
    const group = room.game?.groups.find(
      (entry) => entry.drawerId === playerId && entry.openAction,
    );
    if (!group || !room.game) return;
    const previous = [...group.operations]
      .reverse()
      .find(
        (op) =>
          op.actionId === group.openAction &&
          (op.type === "stroke.start" || op.type === "stroke.append"),
      );
    if (
      !previous ||
      (previous.type !== "stroke.start" && previous.type !== "stroke.append")
    )
      return;
    const point =
      previous.type === "stroke.start"
        ? previous.point
        : previous.points.at(-1)!;
    const { x, y, time, pressure } = point;
    const op: CanvasOperation = {
      type: "stroke.end",
      opId: randomUUID(),
      actionId: group.openAction!,
      at: this.now(),
      point: { x, y, time, ...(pressure === undefined ? {} : { pressure }) },
    };
    if (this.options.store instanceof MemoryGameStore) {
      const bytes = Buffer.byteLength(JSON.stringify([op]), "utf8");
      const key = `${room.code}:${group.canvasId}:${room.game.generation}`;
      this.canvasBytes.set(key, (this.canvasBytes.get(key) ?? 0) + bytes);
      this.roomBytes.set(room.code, (this.roomBytes.get(room.code) ?? 0) + bytes);
    }
    group.operations.push(op);
    group.sequence++;
    group.undo.push(group.openAction!);
    group.undo = group.undo.slice(-20);
    group.openAction = undefined;
    group.redo = [];
    group.seenOps.push(op.opId);
    this.archive(room, group, [op]);
    for (const player of room.players) {
      const connection = this.leases.get(`${room.code}:${player.id}`);
      if (connection && this.group(room, player)?.id === group.id)
        this.options.eventSink(connection, {
          type: "drawing",
          canvasId: group.canvasId,
          generation: room.game.generation,
          sequence: group.sequence,
          reset: false,
          caughtUp: true,
          operations: [op],
        });
    }
  }
  async disconnect(connectionId: string): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    await this.serial(conn.code, async () => {
      const room = this.get(conn.code);
      const key = `${room.code}:${conn.playerId}`;
      if (this.leases.get(key) !== connectionId) return;
      this.connections.delete(connectionId);
      this.leases.delete(key);
      if (![...this.connections.values()].some(connection => connection.code === room.code)) this.idleSince.set(room.code, this.now());
      this.closeStroke(room, conn.playerId);
      if (room.hostId === conn.playerId)
        room.hostDisconnectedUntil = this.now() + this.graceMs;
      this.pauseGroups(room);
      if (room.phase === "starting" && (!this.ready(room) || room.hostId === conn.playerId)) this.cancelStart(room);
      room.revision++;
      try {
        await this.save(room);
      } finally {
        this.publish(room);
        this.schedule(room);
      }
    });
  }
  private pauseGroups(room: State): void {
    if (room.phase !== "drawing") return;
    for (const g of room.game!.groups) {
      if (g.closed || g.pause || g.deadlineAt <= this.now()) continue;
      const drawer = room.players.find((p) => p.id === g.drawerId)!;
      const unsolved = g.eligible.filter(
        (id) => !g.solves.some((s) => s.playerId === id),
      );
      const hasGuesser = unsolved.some((id) => {
        const p = room.players.find((x) => x.id === id);
        return p && this.connected(room, p);
      });
      const reason = !this.connected(room, drawer)
        ? "drawer-disconnected"
        : unsolved.length && !hasGuesser
          ? "guessers-disconnected"
          : undefined;
      if (reason) {
        this.closeStroke(room, g.drawerId);
        this.cancelInference(room.code);
        g.pause = {
          reason,
          until: this.now() + this.graceMs,
          remainingMs: Math.max(0, g.deadlineAt - this.now()),
        };
      }
    }
  }
  private resumeGroups(room: State): void {
    if (room.phase !== "drawing") return;
    for (const g of room.game!.groups) {
      if (!g.pause || g.pause.until <= this.now()) continue;
      const drawer = room.players.find((p) => p.id === g.drawerId);
      const active = g.eligible.some(
        (id) =>
          !g.solves.some((s) => s.playerId === id) &&
          room.players.some((p) => p.id === id && this.connected(room, p)),
      );
      if (drawer && this.connected(room, drawer) && active) {
        g.deadlineAt = this.now() + g.pause.remainingMs;
        delete g.pause;
      }
    }
  }
  private cancelStart(room: State): void {
    room.phase = "lobby";
    delete room.startDeadlineAt;
    room.chat.push({ id: randomUUID(), playerId: room.hostId, text: "Match start cancelled because a required player disconnected or left.", at: this.now(), kind: "system" });
    room.chat = room.chat.slice(-100);
  }
  private ready(room: State): boolean {
    return room.settings.mode === "individual"
      ? room.players.filter((p) => !p.left && this.connected(room, p)).length >= 2
      : this.teams(room).every(
          (t) =>
            room.players.filter(
              (p) => p.teamId === t.id && this.connected(room, p),
            ).length >= 2,
        );
  }
  private nextDrawer(room: State, groupId: string): Player | undefined {
    const roster =
      room.settings.mode === "individual"
        ? room.players
        : room.players.filter((player) => player.teamId === groupId);
    const previousId = room.game?.groups.find(
      (group) => group.id === groupId,
    )?.drawerId;
    const previousIndex = previousId
      ? roster.findIndex((player) => player.id === previousId)
      : -1;
    for (let offset = 1; offset <= roster.length; offset++) {
      const player = roster[(previousIndex + offset) % roster.length];
      if (!player.left && this.connected(room, player)) return player;
    }
    return undefined;
  }
  private promptCandidates(room: State): string[] {
    const selected = new Set(room.selectedPrompts ?? []);
    const interrupted = room.game?.interruptedTarget;
    return (room.aiMatch?.guesser?.prompts ?? PROMPTS).filter((word) => !selected.has(word) && word !== interrupted);
  }
  private hasPromptOptions(room: State): boolean {
    return this.promptCandidates(room).length >= 3;
  }
  private optionsFor(room: State): string[] {
    const candidates = this.promptCandidates(room);
    requireThat(candidates.length >= 3, "prompts-exhausted", "Not enough unused prompts remain.");
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, 3);
  }
  private begin(room: State, retry = false): void {
    requireThat(
      this.ready(room),
      "not-ready",
      "At least two connected players per group are required.",
    );
    const options = this.optionsFor(room);
    const previous = room.game;
    const round = retry ? room.round : room.round + 1;
    const generation = room.generation + 1;
    const sets =
      room.settings.mode === "individual"
        ? [{ id: "individual", players: room.players.filter((p) => !p.left) }]
        : this.teams(room).map((t) => ({
            id: t.id,
            players: room.players.filter((p) => !p.left && p.teamId === t.id),
          }));
    const groups: Group[] = sets.map(({ id, players }) => {
      const former = previous?.groups.find((g) => g.id === id)?.drawerId;
      const drawer = retry
        ? players.find((p) => p.id === former)
        : this.nextDrawer(room, id);
      requireThat(
        drawer && this.connected(room, drawer),
        "not-ready",
        "The assigned drawer must be connected.",
      );
      return {
        id,
        drawerId: drawer.id,
        eligible: players.filter((p) => p.id !== drawer.id).map((p) => p.id),
        canvasId: randomUUID(),
        sequence: 0,
        durableSequence: 0,
        operations: [],
        solves: [],
        closed: false,
        deadlineAt: 0,
        undo: [],
        redo: [],
        seenOps: [],
      };
    });
    room.round = round;
    room.generation = generation;
    room.game = {
      generation,
      turnId: randomUUID(),
      round,
      options,
      chooserId: groups[(round - 1) % groups.length].drawerId,
      groups,
      deadlineAt: this.now() + this.chooseMs,
    };
    room.phase = "choosing";
  }
  private choose(room: State, target: string): void {
    const game = room.game!;
    requireThat(
      game.options.includes(target),
      "invalid-prompt",
      "Choose one of the offered prompts.",
    );
    game.target = target;
    if (room.selectedPrompts) room.selectedPrompts.push(target);
    for (const g of game.groups) {
      if (room.settings.mode === "individual")
        g.eligible = g.eligible.filter((id) => room.players.some((p) => p.id === id && !p.left));
      g.deadlineAt = this.now() + this.drawMs;
    }
    room.phase = "drawing";
    this.pauseGroups(room);
  }
  private async finish(room: State): Promise<void> {
    requireThat(
      !(this.archiveCounts.get(room.code) ?? 0),
      "saving-unavailable",
      "Drawing archive is still saving.",
    );
    requireThat(
      !this.archiveErrors.has(room.code),
      "saving-unavailable",
      "Drawing archive is unavailable.",
    );
    this.cancelInference(room.code);
    const game = room.game!;
    const deltas: Record<string, number> = {};
    const components: NonNullable<
      NonNullable<RoomSnapshot["game"]>["result"]
    >["components"] = {};
    for (const g of game.groups) {
      if (room.settings.mode === "individual") {
        const scores = individualScores(
          g.drawerId,
          g.eligible,
          g.solves,
          this.drawMs,
        );
        for (const [id, score] of Object.entries(scores)) {
          components[id] = score;
          deltas[id] = score.guesserBase + score.drawerRecognition;
        }
      } else deltas[g.id] = teamScore(g.solves[0], this.drawMs);
    }
    const candidate = clone(room);
    for (const [id, score] of Object.entries(deltas))
      candidate.scores[id] = (candidate.scores[id] ?? 0) + score;
    const aiRound = game.aiRound ?? unavailableRound();
    const benchmark = clone(room.aiBenchmark ?? emptyBenchmark());
    benchmark.completedRounds++;
    if (aiRound.points !== null) {
      benchmark.totalPoints = (benchmark.totalPoints ?? 0) + aiRound.points;
      benchmark.scoredRounds++;
      if (aiRound.status === "solved") benchmark.solvedRounds++;
    }
    candidate.aiBenchmark = benchmark;
    if (candidate.aiHistory) candidate.aiHistory.push({ round: game.round, drawerId: game.groups[0].drawerId, word: game.target!, aiBenchmark: clone(aiRound), aiGuesses: clone(game.aiGuesses) });
    const committedGame = candidate.game!;
    committedGame.result = {
      word: game.target!,
      aiBenchmark: aiRound,
      aiGuesses: committedGame.aiGuesses,
      aiCorrect: aiRound.status === "solved",
      finalAnswer: game.aiGuesses?.filter(guess => guess.submitted).at(-1)?.answer,
      deltas,
      components,
      nextDrawerId:
        room.settings.mode === "individual" && room.round < room.settings.rounds
          ? this.nextDrawer(room, "individual")?.id
          : undefined,
    };
    delete committedGame.aiGuesses;
    committedGame.deadlineAt = this.now() + this.recapMs;
    candidate.phase = "result";
    candidate.revision++;
    try {
      await this.options.store.finalizeTurn({
        room: this.persisted(candidate),
        turnId: game.turnId,
        generation: game.generation,
        results: { scoringVersion: "human-v1", deltas, components, aiBenchmark: aiRound, aiGuesses: clone(game.aiGuesses), ...(game.refereeEvidence ? { refereeEvidence: game.refereeEvidence } : {}) },
      });
      this.resultSaveErrors.delete(room.code);
    } catch (error) {
      this.resultSaveErrors.add(room.code);
      this.publish(room);
      throw error;
    }
    Object.assign(room, candidate);
  }
  /** Wake a closed turn once its archive is ready, preserving room event ordering. */
  private requestFinalization(room: State): void {
    const game = room.game;
    if (this.stopping || room.phase !== "drawing" || !game ||
        !game.groups.every(group => group.closed) ||
        (this.archiveCounts.get(room.code) ?? 0) !== 0 ||
        this.archiveErrors.has(room.code)) return;
    const generation = game.generation;
    const key = `${room.code}:${generation}`;
    if (this.pendingFinalizations.has(key)) return;
    this.pendingFinalizations.add(key);
    // Queue behind the current command; never await this queue from inside that command.
    void this.serial(room.code, async () => {
      if (this.stopping || this.rooms.get(room.code) !== room ||
          room.phase !== "drawing" || room.game?.generation !== generation ||
          !room.game.groups.every(group => group.closed) ||
          (this.archiveCounts.get(room.code) ?? 0) !== 0 ||
          this.archiveErrors.has(room.code)) return;
      await this.tick(room);
    }).catch(() => {
      if (!this.stopping && this.rooms.get(room.code) === room &&
          room.phase === "drawing" && room.game?.generation === generation)
        this.scheduleRetry(room);
    }).finally(() => this.pendingFinalizations.delete(key));
  }
  private schedule(room: State): void {
    if (this.stopping) return;
    const old = this.timers.get(room.code);
    if (old) clearTimeout(old);
    const deadlines: number[] = [];
    if (room.hostDisconnectedUntil && room.hostDisconnectedUntil > this.now())
      deadlines.push(room.hostDisconnectedUntil);
    if (room.phase === "drawing" && room.game!.groups.every((g) => g.closed))
      deadlines.push(this.now() + 1000);
    if (room.phase === "starting" && room.startDeadlineAt !== undefined) deadlines.push(room.startDeadlineAt);
    if (room.phase === "choosing" || room.phase === "result")
      deadlines.push(room.game!.deadlineAt);
    if (room.phase === "drawing")
      for (const g of room.game!.groups)
        if (!g.closed) {
          deadlines.push(g.pause?.until ?? g.deadlineAt);
          if (!g.pause)
            for (const threshold of [
              g.deadlineAt - (this.drawMs * 2) / 3,
              g.deadlineAt - this.drawMs / 3,
            ])
              if (threshold > this.now()) deadlines.push(threshold);
        }
    if (!deadlines.length) return;
    const delay = Math.max(1, Math.min(...deadlines) - this.now());
    const timer = setTimeout(() => {
      void this.serial(room.code, async () => {
        await this.tick(room);
      }).catch(() => {
        this.scheduleRetry(room);
      });
    }, delay);
    this.timers.set(room.code, timer);
  }
  private scheduleRetry(room: State): void {
    if (this.stopping) return;
    const old = this.timers.get(room.code);
    if (old) clearTimeout(old);
    this.timers.set(
      room.code,
      setTimeout(() => {
        void this.serial(room.code, async () => this.tick(room)).catch(() =>
          this.scheduleRetry(room),
        );
      }, 1000),
    );
  }
  private async tick(room: State): Promise<void> {
    const backup = clone(room);
    try {
      await this.tickTransition(room);
    } catch (error) {
      Object.assign(room, backup);
      this.publish(room);
      throw error;
    }
  }
  private async tickTransition(room: State): Promise<void> {
    const now = this.now();
    let changed = false;
    if (room.hostDisconnectedUntil && room.hostDisconnectedUntil <= now) {
      const next = room.players
        .filter((p) => this.connected(room, p))
        .sort(
          (a, b) =>
            (a.connectedAt ?? now) - (b.connectedAt ?? now) ||
            a.joinedAt - b.joinedAt,
        )[0];
      if (next) {
        room.hostId = next.id;
        delete room.hostDisconnectedUntil;
        changed = true;
      }
    }
    if (room.phase === "starting" && room.startDeadlineAt !== undefined && room.startDeadlineAt <= now) {
      delete room.startDeadlineAt;
      if (this.ready(room) && room.hostId && this.connected(room, room.players.find(p => p.id === room.hostId)!)) this.begin(room);
      else this.cancelStart(room);
      changed = true;
    }
    if (room.phase === "choosing" && room.game!.deadlineAt <= now) {
      this.choose(room, room.game!.options[0]);
      changed = true;
    }
    if (room.phase === "drawing") {
      this.publish(room);
      const closingDrawers: string[] = [];
      for (const g of room.game!.groups)
        if (
          !g.closed &&
          (g.pause ? g.pause.until <= now : g.deadlineAt <= now)
        ) {
          g.closed = true;
          if (g.openAction) closingDrawers.push(g.drawerId);
          this.cancelInference(room.code);
          changed = true;
        }
      if (closingDrawers.length) {
        // Commit closure before broadcasting/archiving a canonical stroke end.
        // A failed save can then roll back without leaking a synthetic operation.
        room.revision++;
        await this.save(room);
        for (const drawerId of closingDrawers) this.closeStroke(room, drawerId);
        this.publish(room);
        this.schedule(room);
        // Finalize on a separate serialized turn after the new archive drains.
        // Its failure must retain this committed closure, not restore the open stroke.
        this.requestFinalization(room);
        return;
      }
      if (
        room.game!.groups.every((g) => g.closed) &&
        !(this.archiveCounts.get(room.code) ?? 0)
      ) {
        await this.finish(room);
        changed = false;
        this.publish(room);
      }
    }
    if (room.phase === "result" && room.game!.deadlineAt <= now) {
      if (room.round >= room.settings.rounds) room.phase = "finished";
      else if (this.ready(room)) {
        try {
          this.begin(room);
        } catch {
          room.game!.deadlineAt = now + 1000;
        }
      } else room.game!.deadlineAt = now + 1000;
      changed = true;
    }
    if (changed) {
      room.revision++;
      await this.save(room);
      this.publish(room);
    }
    this.schedule(room);
  }
  async command(
    connectionId: string,
    name: string,
    envelope: Envelope,
  ): Promise<Ack> {
    const conn = this.connections.get(connectionId);
    if (!conn)
      return {
        ok: false,
        code: "unauthorized",
        message: "Connection is not authenticated.",
      };
    return this.serial(conn.code, async () => {
      const room = this.get(conn.code);
      const player = room.players.find((p) => p.id === conn.playerId);
      if (
        !player ||
        this.leases.get(`${room.code}:${player.id}`) !== connectionId
      )
        return {
          ok: false,
          code: "unauthorized",
          message: "Connection lease expired.",
        };
      if (!envelope || !boundedText(envelope.requestId, 128))
        return {
          ok: false,
          code: "invalid-request",
          message: "Request ID required.",
        };
      const key = `${player.id}:${envelope.requestId}`;
      const hash = digest(JSON.stringify([name, envelope]));
      const previous = room.requests[key];
      if (previous)
        return previous.hash === hash
          ? clone(previous.ack)
          : {
              ok: false,
              code: "request-conflict",
              message: "Request ID was reused with different content.",
              requestId: envelope.requestId,
            };
      const backup = name === "room:drawing" ? undefined : clone(room);
      const ack: Ack = { ok: true, requestId: envelope.requestId };
      let save = true;
      try {
        const management = [
          "room:settings",
          "room:move",
          "room:select-team",
          "room:start",
          "room:retry-interrupted",
          "room:return-to-lobby",
        ];
        if (management.includes(name))
          requireThat(
            envelope.expectedRevision === room.revision,
            "stale-revision",
            "Room changed; refresh and try again.",
          );
        if (["room:choose-prompt", "room:guess", "room:drawing"].includes(name))
          requireThat(
            envelope.generation === room.game?.generation,
            "stale-generation",
            "Drawing turn has changed.",
          );
        const payload = envelope.payload as Record<string, unknown> | undefined;
        if (name === "room:choose-prompt")
          requireThat(
            room.game && this.now() < room.game.deadlineAt,
            "expired",
            "Prompt selection has expired.",
          );
        if (name === "room:guess" || name === "room:drawing") {
          const current = this.group(room, player);
          if (name === "room:drawing" && current?.pause)
            throw new GameError("drawing-paused", "Drawing paused; the unaccepted stroke tail was discarded.");
          requireThat(
            current && !current.pause && this.now() < current.deadlineAt,
            "expired",
            "Drawing time has expired.",
          );
        }
        switch (name) {
          case "room:settings": {
            requireThat(
              room.phase === "lobby" && player.id === room.hostId,
              "forbidden",
              "Only the host can change lobby settings.",
            );
            const settings = payload?.settings ?? payload;
            requireThat(
              validSettings(settings),
              "invalid-settings",
              "Invalid room settings.",
            );
            requireThat(settings.mode === "individual", "unsupported-mode", "Team mode is not available yet.");
            requireThat(
              settings.mode === "individual"
                ? room.players.length <= settings.seats
                : room.players.every(
                    (p) =>
                      !p.teamId ||
                      Number(p.teamId.slice(5)) <= settings.teamCount,
                  ) &&
                    Array.from(
                      { length: settings.teamCount },
                      (_, i) =>
                        room.players.filter((p) => p.teamId === `team-${i + 1}`)
                          .length,
                    ).every((n) => n <= settings.seatsPerTeam),
              "occupied",
              "Settings cannot remove occupied seats.",
            );
            room.settings = { ...room.settings, ...settings };
            if (settings.mode === "individual")
              room.players.forEach((p) => {
                delete p.teamId;
              });
            else
              for (const p of room.players)
                if (!p.teamId) {
                  const team = this.teams(room)
                    .map((t) => ({
                      ...t,
                      count: room.players.filter((x) => x.teamId === t.id)
                        .length,
                    }))
                    .sort((a, b) => a.count - b.count)
                    .find((t) => t.count < settings.seatsPerTeam);
                  requireThat(team, "occupied", "Not enough team seats.");
                  p.teamId = team.id;
                }
            break;
          }
          case "room:move":
          case "room:select-team": {
            requireThat(
              room.phase === "lobby" && room.settings.mode === "team",
              "forbidden",
              "Team selection is available in the lobby.",
            );
            const target =
              name === "room:move"
                ? room.players.find((p) => p.id === payload?.playerId)
                : player;
            requireThat(
              target && (name !== "room:move" || player.id === room.hostId),
              "forbidden",
              "Cannot move that player.",
            );
            const teamId = payload?.teamId;
            requireThat(
              typeof teamId === "string" &&
                this.teams(room).some((t) => t.id === teamId),
              "invalid-team",
              "Unknown team.",
            );
            requireThat(
              target.teamId === teamId ||
                room.players.filter((p) => p.teamId === teamId).length <
                  room.settings.seatsPerTeam,
              "full",
              "Team is full.",
            );
            target.teamId = teamId;
            break;
          }
          case "room:start":
            requireThat(
              room.phase === "lobby" && player.id === room.hostId,
              "forbidden",
              "Only the host can start.",
            );
            requireThat(room.settings.mode === "individual", "unsupported-mode", "Team mode is not available yet.");
            requireThat(this.ready(room), "not-ready", "At least two connected players are required.");
            const guesser = room.settings.aiGuesserEnabled !== false ? this.options.inference?.ready("guesser") : undefined;
            const referee = room.settings.aiRefereeEnabled !== false ? this.options.inference?.ready("referee") : undefined;
            const labels = new Set(guesser?.labels?.map(normalize));
            const prompts = PROMPTS.filter(word => labels.has(normalize(word)));
            room.aiMatch = {
              ...(guesser && prompts.length >= room.settings.rounds + 2 ? { guesser: { modelId: guesser.modelId, artifactRevision: guesser.artifactRevision, prompts } } : {}),
              ...(referee ? { referee: { modelId: referee.modelId, artifactRevision: referee.artifactRevision } } : {}),
            };
            room.aiBenchmark = emptyBenchmark();
            room.aiHistory = [];
            if (this.options.store instanceof MemoryGameStore) room.interrupted = [];
            room.selectedPrompts = [];
            room.scores = Object.fromEntries(room.players.map((p) => [p.id, 0]));
            room.round = 0;
            room.game = undefined;
            if (this.startMs === 0) this.begin(room);
            else { room.phase = "starting"; room.startDeadlineAt = this.now() + this.startMs; }
            break;
          case "room:retry-interrupted":
            requireThat(
              room.phase === "interrupted" && player.id === room.hostId,
              "forbidden",
              "Only the host can retry.",
            );
            this.begin(room, true);
            break;
          case "room:return-to-lobby":
            requireThat(
              (room.phase === "finished" ||
                room.phase === "interrupted" ||
                (room.phase === "result" && (!this.ready(room) || !this.hasPromptOptions(room)))) &&
                player.id === room.hostId,
              "forbidden",
              "Only the host can return to the lobby.",
            );
            room.phase = "lobby";
            room.players = room.players.filter((p) => !p.left);
            room.game = undefined;
            room.aiMatch = undefined;
            room.round = 0;
            room.scores = {};
            room.aiBenchmark = emptyBenchmark();
            room.aiHistory = undefined;
            delete room.startDeadlineAt;
            break;
          case "room:choose-prompt":
            requireThat(
              room.phase === "choosing" && room.game?.chooserId === player.id,
              "forbidden",
              "Only the choosing drawer can select a prompt.",
            );
            this.choose(
              room,
              String(payload?.id ?? payload?.promptId ?? envelope.payload),
            );
            break;
          case "room:chat": {
            const text =
              typeof envelope.payload === "string"
                ? envelope.payload
                : payload?.text;
            requireThat(
              room.phase !== "drawing" || room.game?.groups.every(group => group.closed) ||
                (this.group(room, player)?.drawerId !== player.id &&
                  !this.group(room, player)?.solves.some(
                    (s) => s.playerId === player.id,
                  )),
              "forbidden",
              "The drawer and solved players cannot chat during drawing.",
            );
            requireThat(
              boundedText(text, 300),
              "invalid-chat",
              "Message must contain 1–300 characters.",
            );
            requireThat(
              !(
                room.phase === "drawing" &&
                room.game?.target &&
                normalize(text).includes(normalize(room.game.target))
              ),
              "secret",
              "That message contains the answer.",
            );
            room.chat.push({
              id: randomUUID(),
              playerId: player.id,
              text: text.trim(),
              at: this.now(),
              kind: "chat",
            });
            room.chat = room.chat.slice(-100);
            break;
          }
          case "room:guess": {
            const text =
              typeof envelope.payload === "string"
                ? envelope.payload
                : payload?.text;
            const group = this.group(room, player);
            requireThat(
              room.phase === "drawing" &&
                group &&
                !group.closed &&
                !group.pause &&
                group.eligible.includes(player.id) &&
                !group.solves.some((s) => s.playerId === player.id),
              "forbidden",
              "You cannot guess now.",
            );
            requireThat(
              boundedText(text, 100),
              "invalid-guess",
              "Guess must contain 1–100 characters.",
            );
            if (normalize(text) === normalize(room.game!.target!)) {
              group.solves.push({
                playerId: player.id,
                elapsedMs: Math.max(
                  0,
                  this.drawMs - (group.deadlineAt - this.now()),
                ),
              });
              room.chat.push({
                id: randomUUID(),
                playerId: player.id,
                text: "Correct!",
                at: this.now(),
                kind: "correct",
              });
              if (
                room.settings.mode === "team" ||
                group.solves.length === group.eligible.length
              ) {
                group.closed = true;
                this.cancelInference(room.code);
              }
              if (
                room.game!.groups.every((g) => g.closed) &&
                !(this.archiveCounts.get(room.code) ?? 0) &&
                !group.openAction
              ) {
                await this.finish(room);
                save = false;
              } else this.pauseGroups(room);
            } else {
              requireThat(
                !normalize(text).includes(normalize(room.game!.target!)),
                "secret",
                "That guess contains the answer.",
              );
              if (room.settings.mode === "individual")
                room.chat.push({
                  id: randomUUID(),
                  playerId: player.id,
                  text: text.trim(),
                  at: this.now(),
                  kind: "chat",
                });
            }
            room.chat = room.chat.slice(-100);
            break;
          }
          case "room:drawing": {
            const batch = (payload?.batch ?? envelope.payload) as DrawingPayload;
            const group = this.group(room, player);
            requireThat(
              room.phase === "drawing" &&
                group &&
                !group.closed &&
                !group.pause &&
                group.drawerId === player.id,
              "forbidden",
              "Only the active drawer can draw.",
            );
            requireThat(
              batch &&
                batch.canvasId === group.canvasId &&
                batch.generation === room.game!.generation &&
                batch.roomCode === room.code,
              "stale-generation",
              "Drawing belongs to another canvas.",
            );
            requireThat(
              !this.archiveErrors.has(room.code) &&
                (this.archiveCounts.get(room.code) ?? 0) < 128,
              "saving-unavailable",
              "Drawing archive is full or unavailable.",
            );
            requireThat(
              group.operations.length + batch.operations.length <= 20000,
              "drawing-limit",
              "Canvas operation limit reached.",
            );
            requireThat(
              boundedText(batch.streamId, 100),
              "invalid-drawing",
              "Drawing stream ID required.",
            );
            const expected = (group.streams?.[batch.streamId] ?? 0) + 1;
            requireThat(
              batch.clientSeq[0] === expected,
              "invalid-drawing",
              "Drawing stream has a missing or repeated operation.",
            );
            const operationsJson = JSON.stringify(batch.operations);
            const memoryDrawing = this.options.store instanceof MemoryGameStore
              ? {
                  bytes: Buffer.byteLength(operationsJson, "utf8"),
                  canvasKey: `${room.code}:${group.canvasId}:${room.game!.generation}`,
                }
              : null;
            if (memoryDrawing) {
              const { bytes, canvasKey } = memoryDrawing;
              requireThat((this.canvasBytes.get(canvasKey) ?? 0) + bytes + 1024 <= 1024 * 1024 && (this.roomBytes.get(room.code) ?? 0) + bytes + 1024 <= 8 * 1024 * 1024, "drawing-limit", "Drawing storage limit reached for this session.");
            }
            let seen = this.seenOperationIds.get(group);
            if (!seen || seen.length !== group.seenOps.length) {
              seen = { length: group.seenOps.length, ids: new Set(group.seenOps) };
              this.seenOperationIds.set(group, seen);
            }
            const candidate = {
              ...group,
              undo: [...group.undo],
              redo: [...group.redo],
            };
            validateOperations(candidate, batch, seen.ids, operationsJson);
            group.openAction = candidate.openAction;
            group.undo = candidate.undo.slice(-20);
            group.redo = candidate.redo.slice(-20);
            for (const operation of batch.operations) {
              group.seenOps.push(operation.opId);
              seen.ids.add(operation.opId);
            }
            seen.length = group.seenOps.length;
            group.streams ??= {};
            group.streams[batch.streamId] = batch.clientSeq[1];
            if (memoryDrawing) {
              const { bytes, canvasKey } = memoryDrawing;
              this.canvasBytes.set(canvasKey, (this.canvasBytes.get(canvasKey) ?? 0) + bytes);
              this.roomBytes.set(room.code, (this.roomBytes.get(room.code) ?? 0) + bytes);
            }
            let warningCleared = false;
            if (batch.operations.some(operation => operation.type === "canvas.clear")) {
              warningCleared = this.cancelInference(room.code);
              room.game!.refereeEvidence = undefined;
              if (room.game!.guesserProgress) room.game!.guesserProgress.hash = undefined;
            }
            group.operations.push(...batch.operations);
            group.sequence += batch.operations.length;
            this.archive(room, group, batch.operations);
            ack.sequence = group.sequence;
            ack.durableSequence = group.durableSequence;
            save = false;
            for (const p of room.players) {
              const recipient = this.leases.get(`${room.code}:${p.id}`);
              if (recipient && this.group(room, p)?.id === group.id)
                this.options.eventSink(recipient, {
                  type: "drawing",
                  canvasId: group.canvasId,
                  generation: room.game!.generation,
                  sequence: group.sequence,
                  reset: false,
                  caughtUp: true,
                  operations: batch.operations,
                });
            }
            if (warningCleared) this.publish(room);
            break;
          }
          case "room:resync": {
            this.options.eventSink(connectionId, {
              type: "snapshot",
              ...this.projection(room, player),
            });
            const group = this.group(room, player);
            if (group && room.game)
              this.options.eventSink(connectionId, {
                type: "drawing",
                canvasId: group.canvasId,
                generation: room.game.generation,
                sequence: group.sequence,
                reset: true,
                caughtUp: true,
                operations: clone(group.operations),
              });
            save = false;
            break;
          }
          case "room:leave": {
            if (room.phase === "lobby" || room.phase === "starting" || room.phase === "finished")
              room.players = room.players.filter((p) => p.id !== player.id);
            else {
              player.tokenHash = digest(randomUUID());
              player.left = true;
            }
            if (room.phase === "starting" && (room.hostId === player.id || !this.ready(room))) this.cancelStart(room);
            if (room.hostId === player.id)
              room.hostId =
                room.players
                  .filter((p) => p.id !== player.id && this.connected(room, p))
                  .sort(
                    (a, b) => (a.connectedAt ?? 0) - (b.connectedAt ?? 0),
                  )[0]?.id ?? "";
            if (!room.hostId) room.hostDisconnectedUntil = this.now();
            if (!room.players.length) room.phase = "closed";
            break;
          }
          default:
            throw new GameError("unknown-command", "Unknown command.");
        }
        room.requests[key] = { hash, ack: clone(ack) };
        if (Object.keys(room.requests).length > 2048)
          delete room.requests[Object.keys(room.requests)[0]];
        if (save) {
          room.revision++;
          await this.save(room);
          if (name === "room:start" && this.options.store instanceof MemoryGameStore) {
            await this.archives.get(room.code);
            this.options.store.clearArchive(room.code);
            this.roomBytes.delete(room.code);
            for (const key of this.canvasBytes.keys()) if (key.startsWith(`${room.code}:`)) this.canvasBytes.delete(key);
          }
        }
        // Close the accepted stroke only after the closing solve is saved, so a
        // failed save cannot archive or broadcast a stroke end that was rolled back.
        if (name === "room:guess") {
          const group = this.group(room, player);
          if (group?.closed) this.closeStroke(room, group.drawerId);
        }
        if (name === "room:leave") {
          this.connections.delete(connectionId);
          this.leases.delete(`${room.code}:${player.id}`);
          if (![...this.connections.values()].some(connection => connection.code === room.code)) this.idleSince.set(room.code, this.now());
          this.closeStroke(room, player.id);
          this.pauseGroups(room);
        }
        ack.revision = room.revision;
        room.requests[key].ack = clone(ack);
        if (name !== "room:drawing") {
          this.publish(room);
          this.schedule(room);
          this.requestFinalization(room);
        } else if (!(this.options.store instanceof MemoryGameStore) && (this.archiveCounts.get(room.code) ?? 0) === 1) {
          // Notify saving progress without publishing a full snapshot for each batch.
          this.scheduleArchivePublish(room);
        }
        return ack;
      } catch (error) {
        if (backup) Object.assign(room, backup);
        const failure =
          error instanceof GameError
            ? error
            : new GameError(
                "saving-unavailable",
                "Unable to save the action. Please retry.",
              );
        return {
          ok: false,
          code: failure.code,
          message: failure.message,
          requestId: envelope.requestId,
        };
      }
    });
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.evictionTimer) clearInterval(this.evictionTimer);
    if (this.inferenceTimer) clearInterval(this.inferenceTimer);
    for (const active of this.activeInference.values()) active.controller.abort("invalidated");
    await Promise.allSettled([...this.queues.values()]);
    this.pendingFinalizations.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.archivePublishTimers.values()) clearTimeout(timer);
    this.archivePublishTimers.clear();
  }
}
