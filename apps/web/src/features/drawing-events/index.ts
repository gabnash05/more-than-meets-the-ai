import { createUuid } from "@/lib/uuid";
import type {
  CanvasOperation,
  DrawingBatch,
  DrawingBatcher,
  DrawingBatcherOptions,
  FlushReason,
  SequencedOperation,
} from "@/contracts/drawing";

/** The console is the only transport in this local prototype. */
export function sendDrawingBatch(batch: DrawingBatch): void {
  console.info("[drawing:batch]", batch);
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export function createDrawingBatcher(
  options: DrawingBatcherOptions,
): DrawingBatcher {
  const intervalMs = options.intervalMs ?? 33;
  const now = options.now ?? (() => performance.now());
  const send = options.send ?? sendDrawingBatch;
  const instanceId = createUuid();
  let sequence = 0;
  let batchNumber = 0;
  let pending: SequencedOperation[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFlush: number | undefined;
  let nextFlushAt: number | undefined;
  let firstEnqueue = 0;
  let disposed = false;

  function flush(reason: FlushReason = "manual") {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!pending.length) return;
    const currentTime = now();
    const operations = pending;
    pending = [];
    const batch: DrawingBatch = {
      transport: options.transport ?? "console",
      ...(options.streamId ? { streamId: options.streamId } : {}),
      ...(options.generation !== undefined ? { generation: options.generation } : {}),
      batchId: `${instanceId}-${++batchNumber}`,
      roomCode: options.roomCode,
      canvasId: options.canvasId,
      clientSeq: [
        operations[0].clientSeq,
        operations[operations.length - 1].clientSeq,
      ],
      flushReason: reason,
      targetIntervalMs: intervalMs,
      elapsedMs: currentTime - (lastFlush ?? firstEnqueue),
      operationCount: operations.length,
      pointCount: operations.reduce(
        (count, op) =>
          count +
          (op.type === "stroke.append"
            ? op.points.length
            : op.type === "stroke.start" ||
                op.type === "stroke.end" ||
                op.type === "fill"
              ? 1
              : 0),
        0,
      ),
      byteCount: 0,
      operations,
    };
    const encoder = new TextEncoder();
    let bytes = encoder.encode(JSON.stringify(batch)).length;
    while (batch.byteCount !== bytes) {
      batch.byteCount = bytes;
      bytes = encoder.encode(JSON.stringify(batch)).length;
    }
    lastFlush = currentTime;
    nextFlushAt = reason === "interval" ? currentTime + intervalMs : undefined;
    send(freeze(batch));
  }

  function enqueue(operation: CanvasOperation) {
    if (disposed) return;
    const command =
      operation.type === "fill" ||
      operation.type === "history.undo" ||
      operation.type === "history.redo" ||
      operation.type === "canvas.clear";
    if (command) flush("command");
    if (
      command ||
      operation.type === "stroke.start" ||
      operation.type === "stroke.end"
    )
      nextFlushAt = undefined;
    if (!pending.length) firstEnqueue = now();
    pending.push({
      ...snapshot(operation),
      clientSeq: ++sequence,
    } as SequencedOperation);
    if (command) flush("command");
    else if (operation.type === "stroke.end") flush("stroke-end");
    else if (timer === undefined)
      timer = setTimeout(
        () => flush("interval"),
        Math.max(0, (nextFlushAt ?? now() + intervalMs) - now()),
      );
  }

  return {
    enqueue,
    flush(reason = "manual") {
      if (!disposed) flush(reason);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      flush("dispose");
    },
  };
}
