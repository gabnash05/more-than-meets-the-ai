import { createUuid } from "@/lib/uuid";
import { MAX_STROKE_APPEND_POINTS } from "@/contracts/drawing";
import type { CanvasOperation, DrawingBatch, DrawingBatcher, DrawingBatcherOptions, DrawingPayload, FlushReason, SequencedOperation } from "@/contracts/drawing";

/** Log an inspectable batch when no RoomClient transport was supplied. */
export function sendDrawingBatch(batch: DrawingBatch): void {
  console.info("[drawing:batch]", batch);
}
/** Freeze a captured batch depth-first so consumers cannot change retry data. */
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
/** Validate a caller's positive integer budget instead of silently clamping it. */
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || !Number.isInteger(result) || result < 1 || result > maximum)
    throw new RangeError(`Drawing batch limit must be an integer between 1 and ${maximum}`);
  return result;
}
/** Count geometry samples without serializing an operation. */
function points(operation: CanvasOperation): number {
  if (operation.type === "stroke.append") return operation.points.length;
  return operation.type === "stroke.start" || operation.type === "stroke.end" || operation.type === "fill" ? 1 : 0;
}
/** Buffer immutable input under age/size/count caps, with immediate ordered edit barriers. */
export function createDrawingBatcher(options: DrawingBatcherOptions): DrawingBatcher {
  const intervalMs = limit(options.intervalMs, 33, 33);
  const maxBytes = limit(options.maxBytes, 64 * 1024, 127999);
  const maxOperations = limit(options.maxOperations, 128, 255);
  const maxPoints = limit(options.maxPoints, 1024, 2047);
  const now = options.now ?? (() => performance.now());
  const send = options.send ?? sendDrawingBatch;
  const instanceId = createUuid();
  const encoder = new TextEncoder();
  let sequence = 0;
  let batchNumber = 0;
  let pending: SequencedOperation[] = [];
  let operationBytes = 0;
  let pointCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFlush: number | undefined;
  let firstEnqueue = 0;
  let disposed = false;
  function payload(first: number, last: number, operations: SequencedOperation[], number = batchNumber + 1): DrawingPayload {
    return { batchId: `${instanceId}-${number}`,
      ...(options.streamId !== undefined ? { streamId: options.streamId } : {}),
      roomCode: options.roomCode, canvasId: options.canvasId,
      ...(options.generation !== undefined ? { generation: options.generation } : {}),
      clientSeq: [first, last], operations };
  }
  // The empty envelope plus cached operation JSON sizes and commas is the exact
  // UTF-8 payload size, without serializing the accumulated operations again.
  function size(first: number, last: number, bytes: number, count: number, number = batchNumber + 1): number {
    return encoder.encode(JSON.stringify(payload(first, last, [], number))).length + bytes + Math.max(0, count - 1);
  }
  function flush(reason: FlushReason = "manual") {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!pending.length) return;
    const currentTime = now();
    const canonical = payload(pending[0].clientSeq, pending[pending.length - 1].clientSeq, pending);
    const batch: DrawingBatch = { ...canonical, transport: options.transport ?? "console", flushReason: reason,
      targetIntervalMs: intervalMs, elapsedMs: currentTime - (lastFlush ?? firstEnqueue),
      operationCount: pending.length, pointCount,
      byteCount: size(canonical.clientSeq[0], canonical.clientSeq[1], operationBytes, pending.length) };
    batchNumber++;
    pending = [];
    operationBytes = 0;
    pointCount = 0;
    lastFlush = currentTime;
    send(freeze(batch));
  }
  function enqueue(operation: CanvasOperation) {
    if (disposed) return;
    const op = { ...structuredClone(operation), clientSeq: sequence + 1 } as SequencedOperation;
    const opPoints = points(op);
    const opBytes = encoder.encode(JSON.stringify(op)).length;
    const barrier = op.type !== "stroke.append";
    const reason = op.type === "stroke.start" ? "stroke-start" : op.type === "stroke.end" ? "stroke-end" : "command";
    const exceedsCount = pending.length + 1 > maxOperations || pointCount + opPoints > maxPoints;
    const flushBefore = pending.length > 0 && (barrier || exceedsCount ||
      size(pending[0].clientSeq, op.clientSeq, operationBytes + opBytes, pending.length + 1) > maxBytes);
    // Preflight the actual destination header before emitting pending work. Its
    // batch number can grow across the flush; a rejected input changes nothing.
    const destination = batchNumber + (flushBefore ? 2 : 1);
    if ((op.type === "stroke.append" && opPoints > MAX_STROKE_APPEND_POINTS) ||
      opPoints > maxPoints || size(op.clientSeq, op.clientSeq, opBytes, 1, destination) > maxBytes)
      throw new RangeError("Drawing operation exceeds batch limits");
    if (flushBefore) flush(barrier ? reason : exceedsCount ? "count" : "size");
    if (!pending.length) firstEnqueue = now();
    sequence++;
    pending.push(op);
    operationBytes += opBytes;
    pointCount += opPoints;
    if (barrier) flush(reason);
    else if (pending.length === maxOperations || pointCount === maxPoints ||
      size(pending[0].clientSeq, op.clientSeq, operationBytes, pending.length) === maxBytes)
      flush(pending.length === maxOperations || pointCount === maxPoints ? "count" : "size");
    else if (timer === undefined) {
      // Keep the prior flush deadline instead of adding a fresh full interval
      // after an idle gap. A pending sample still waits no longer than the cap.
      const delay = Math.max(0, (lastFlush ?? firstEnqueue) + intervalMs - now());
      if (delay === 0) flush("interval");
      else timer = setTimeout(() => flush("interval"), delay);
    }
  }
  return { enqueue, flush(reason = "manual") { if (!disposed) flush(reason); },
    dispose() { if (!disposed) { disposed = true; flush("dispose"); } } };
}
