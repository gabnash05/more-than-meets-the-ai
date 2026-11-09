type Scheduler = {
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  timer(callback: () => void): number;
  cancelTimer(id: number): void;
};

type Waiter = { resolve(): void; reject(error: Error): void };
type Batch<T> = { items: T[]; waiters: Waiter[]; reset: boolean };

export class ReplayQueueOverflowError extends Error {
  constructor() {
    super("Drawing replay exceeded its pending limit; an authoritative reset is required.");
    this.name = "ReplayQueueOverflowError";
  }
}

// A legal server prefix has at most 20,000 operations plus its canonical closure.
// Allow one such in-flight replay and one complete replacement reset at once.
const MAX_ITEMS = 40_002;
const MAX_CALLS = 512;

/** Coalesce ordered replay work with bounded retention and reset-only failure recovery. */
export class ReplayQueue<T> {
  private batch: Batch<T> | undefined;
  private queue: Batch<T>[] = [];
  private running: Batch<T> | undefined;
  private frameId: number | undefined;
  private timerId: number | undefined;
  private scheduleEpoch = 0;
  private pending = new Set<Waiter>();
  private itemCount = 0;
  private needsReset = false;
  private disposed = false;

  constructor(
    private readonly replay: (items: T[], reset: boolean) => Promise<void>,
    private readonly scheduler: Scheduler,
    private readonly changed: (pending: number) => void,
  ) {}

  get requiresReset(): boolean { return this.needsReset; }

  add(items: T[], reset: boolean): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Canvas was disposed"));
    if (this.needsReset && !reset) return Promise.reject(new ReplayQueueOverflowError());
    if (this.pending.size >= MAX_CALLS || this.itemCount + items.length > MAX_ITEMS || (reset && items.length > 20_001)) {
      const error = new ReplayQueueOverflowError();
      this.failPending(error);
      this.needsReset = true;
      return Promise.reject(error);
    }
    if (reset) this.needsReset = false;
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.pending.add(waiter);
      this.itemCount += items.length;
      this.changed(this.pending.size);
      if (reset) {
        this.flush();
        this.queue.push({ items, waiters: [waiter], reset: true });
        this.drain();
      } else {
        if (!this.batch) this.batch = { items: [], waiters: [], reset: false };
        this.batch.items.push(...items);
        this.batch.waiters.push(waiter);
        if (this.batch.waiters.length >= 256) this.flush();
        else if (this.frameId === undefined) {
          const epoch = ++this.scheduleEpoch;
          const scheduled = () => { if (epoch === this.scheduleEpoch) this.flush(); };
          this.frameId = this.scheduler.frame(scheduled);
          this.timerId = this.scheduler.timer(scheduled);
          // An idle packet need not wait for a display frame. Merge synchronous
          // callers in this turn, then keep the scheduled frame as a cooldown:
          // following packets share its trailing pass rather than replaying each.
          if (!this.running && this.queue.length === 0) queueMicrotask(() => {
            if (epoch === this.scheduleEpoch && !this.disposed) this.flush(true);
          });
        }
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.failPending(new Error("Canvas was disposed"));
  }

  private cancelSchedule(): void {
    this.scheduleEpoch++;
    if (this.frameId !== undefined) this.scheduler.cancelFrame(this.frameId);
    if (this.timerId !== undefined) this.scheduler.cancelTimer(this.timerId);
    this.frameId = undefined;
    this.timerId = undefined;
  }

  private failPending(error: Error): void {
    this.cancelSchedule();
    this.batch = undefined;
    this.queue = [];
    // The in-flight replay must finish before a reset can safely repaint the canvas.
    this.itemCount = this.running?.items.length ?? 0;
    for (const waiter of this.pending) waiter.reject(error);
    this.pending.clear();
    this.changed(0);
  }

  private flush(keepSchedule = false): void {
    if (!keepSchedule) this.cancelSchedule();
    const batch = this.batch;
    this.batch = undefined;
    if (batch) { this.queue.push(batch); this.drain(); }
  }

  private drain(): void {
    if (this.running || this.disposed) return;
    const batch = this.queue.shift();
    if (!batch) return;
    this.running = batch;
    void Promise.resolve().then(() => {
      if (this.disposed) throw new Error("Canvas was disposed");
      // Overflow may invalidate a scheduled batch before replay has even begun.
      if (!batch.waiters.some(waiter => this.pending.has(waiter))) return;
      return this.replay(batch.items, batch.reset);
    }).then(
      () => this.complete(batch),
      error => this.complete(batch, error instanceof Error ? error : new Error(String(error))),
    );
  }

  private complete(batch: Batch<T>, error?: Error): void {
    this.running = undefined;
    if (error && batch.waiters.some(waiter => this.pending.has(waiter))) {
      // A failed prefix makes every queued tail unsafe. Reject those callers
      // instead of letting a later successful operation claim the canvas is current.
      this.needsReset = true;
      this.failPending(error);
      return;
    }
    this.itemCount -= batch.items.length;
    for (const waiter of batch.waiters) {
      if (!this.pending.delete(waiter)) continue;
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    if (!this.disposed) this.changed(this.pending.size);
    this.drain();
  }
}
