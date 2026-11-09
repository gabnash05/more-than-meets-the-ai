export const CANVAS_WIDTH = 1024;
export const CANVAS_HEIGHT = 768;
/** Maximum points accepted in one canonical stroke.append operation. */
export const MAX_STROKE_APPEND_POINTS = 512;
export type DrawingTool = "brush" | "eraser" | "fill";
export interface DrawingSettings {
  tool: DrawingTool;
  color: string;
  size: number;
}
export const DEFAULT_DRAWING_SETTINGS: DrawingSettings = {
  tool: "brush",
  color: "#181321",
  size: 12,
};
export interface CanvasPoint {
  x: number;
  y: number;
  time: number;
  pressure?: number;
}
export interface OperationBase {
  opId: string;
  actionId: string;
  at: number;
}
export type CanvasOperation =
  | (OperationBase & {
      type: "stroke.start";
      settings: DrawingSettings;
      point: CanvasPoint;
    })
  | (OperationBase & { type: "stroke.append"; points: CanvasPoint[] })
  | (OperationBase & { type: "stroke.end"; point: CanvasPoint })
  | (OperationBase & {
      type: "fill";
      point: CanvasPoint;
      color: string;
      tolerance: number;
    })
  | (OperationBase & {
      type: "history.undo" | "history.redo";
      targetActionId: string;
    })
  | (OperationBase & { type: "canvas.clear" });
export interface CanvasStatus {
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  hasInk: boolean;
}
export interface DrawingCanvasHandle {
  hydrate(operations: CanvasOperation[]): Promise<void>;
  applyOperations(operations: CanvasOperation[]): Promise<void>;
  undo(): void;
  redo(): void;
  clear(): void;
}
export interface DrawingCanvasProps {
  readOnly?: boolean;
  settings: DrawingSettings;
  onOperation(operation: CanvasOperation): void;
  onStatusChange?(status: CanvasStatus): void;
  onError?(message: string): void;
  className?: string;
}
export type FlushReason =
  "interval" | "stroke-start" | "stroke-end" | "command" | "size" | "count" | "manual" | "dispose";
export type SequencedOperation = CanvasOperation & { clientSeq: number };
/** Canonical wire fields, excluding local diagnostics. */
export interface DrawingPayload {
  batchId: string;
  streamId?: string;
  roomCode: string;
  canvasId: string;
  generation?: number;
  clientSeq: [number, number];
  operations: SequencedOperation[];
}
/** Select canonical fields without changing identities, sequences, or operations. */
export function toDrawingPayload(batch: DrawingPayload): DrawingPayload {
  return { batchId: batch.batchId,
    ...(batch.streamId !== undefined ? { streamId: batch.streamId } : {}),
    roomCode: batch.roomCode, canvasId: batch.canvasId,
    ...(batch.generation !== undefined ? { generation: batch.generation } : {}),
    clientSeq: batch.clientSeq, operations: batch.operations };
}
export interface DrawingBatch extends DrawingPayload {
  transport: "console" | "local" | "remote" | "room-client";
  flushReason: FlushReason;
  targetIntervalMs: number;
  elapsedMs: number;
  operationCount: number;
  pointCount: number;
  /** UTF-8 bytes of the serialized canonical payload. */
  byteCount: number;
}
export interface DrawingBatcherOptions {
  roomCode: string;
  canvasId: string;
  generation?: number;
  intervalMs?: number;
  maxBytes?: number;
  maxOperations?: number;
  maxPoints?: number;
  transport?: DrawingBatch["transport"];
  streamId?: string;
  send?(batch: DrawingBatch): void;
  now?(): number;
}
export interface DrawingBatcher {
  enqueue(operation: CanvasOperation): void;
  flush(reason?: FlushReason): void;
  dispose(): void;
}
