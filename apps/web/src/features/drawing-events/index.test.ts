import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasOperation, DrawingBatch } from "@/contracts/drawing";
import { createDrawingBatcher, sendDrawingBatch } from "./index";

const point = { x: 1, y: 2, time: 0 };
const start = (): CanvasOperation => ({
  type: "stroke.start",
  opId: "1",
  actionId: "a",
  at: 0,
  point: { ...point },
  settings: { tool: "brush", color: "#123456", size: 4 },
});
const append = (): CanvasOperation => ({
  type: "stroke.append",
  opId: "2",
  actionId: "a",
  at: 1,
  points: [{ ...point }],
});
const end = (): CanvasOperation => ({
  type: "stroke.end",
  opId: "3",
  actionId: "a",
  at: 2,
  point: { ...point },
});
const clear = (): CanvasOperation => ({
  type: "canvas.clear",
  opId: "4",
  actionId: "b",
  at: 3,
});

describe("drawing batcher", () => {
  let batches: DrawingBatch[];
  beforeEach(() => {
    vi.useFakeTimers();
    batches = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  function setup() {
    return createDrawingBatcher({
      roomCode: "R",
      canvasId: "C",
      now: () => Date.now(),
      send: (batch) => batches.push(batch),
    });
  }

  it("emits held stroke intervals and immediate final tail without idle batches", () => {
    const b = setup();
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(0);
    b.enqueue(start());
    vi.advanceTimersByTime(33);
    b.enqueue(append());
    vi.advanceTimersByTime(33);
    b.enqueue(end());
    expect(batches.map((x) => x.flushReason)).toEqual([
      "interval",
      "interval",
      "stroke-end",
    ]);
    expect(batches.map((x) => x.elapsedMs)).toEqual([33, 33, 0]);
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(3);
  });
  it("keeps the interval deadline between samples without idle batches", () => {
    const b = setup();
    b.enqueue(start());
    vi.advanceTimersByTime(33);
    expect(batches).toHaveLength(1);
    vi.advanceTimersByTime(15);
    b.enqueue(append());
    vi.advanceTimersByTime(17);
    expect(batches).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(batches).toHaveLength(2);
    expect(batches[1].elapsedMs).toBe(33);
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(2);
  });
  it("flushes a short stroke immediately and orders edits after pending ink", () => {
    const b = setup();
    b.enqueue(start());
    b.enqueue(end());
    b.enqueue(append());
    b.enqueue(clear());
    expect(batches.map((x) => x.operations.map((op) => op.type))).toEqual([
      ["stroke.start", "stroke.end"],
      ["stroke.append"],
      ["canvas.clear"],
    ]);
    expect(batches.map((x) => x.flushReason)).toEqual([
      "stroke-end",
      "command",
      "command",
    ]);
  });
  it("assigns sequence, unique batch ids, point count and exact UTF-8 size", () => {
    const b = createDrawingBatcher({
      roomCode: "é",
      canvasId: "C",
      send: (x) => batches.push(x),
    });
    b.enqueue(start());
    b.enqueue(append());
    b.enqueue(end());
    b.enqueue(clear());
    expect(batches.map((x) => x.clientSeq)).toEqual([
      [1, 3],
      [4, 4],
    ]);
    expect(batches[0].pointCount).toBe(3);
    expect(batches[0].operationCount).toBe(3);
    expect(new Set(batches.map((x) => x.batchId)).size).toBe(2);
    for (const batch of batches)
      expect(batch.byteCount).toBe(
        new TextEncoder().encode(JSON.stringify(batch)).length,
      );
  });
  it("flushes once on disposal and ignores subsequent calls", () => {
    const b = setup();
    b.enqueue(start());
    b.dispose();
    b.dispose();
    b.enqueue(end());
    b.flush();
    vi.runAllTimers();
    expect(batches).toHaveLength(1);
    expect(batches[0].flushReason).toBe("dispose");
  });
  it("snapshots and freezes captured data", () => {
    const b = setup();
    const op = append();
    if (op.type !== "stroke.append") throw new Error();
    b.enqueue(op);
    op.points[0].x = 999;
    op.points.push({ ...point });
    b.flush();
    expect(batches[0].operations[0]).toMatchObject({ points: [{ x: 1 }] });
    expect(Object.isFrozen(batches[0].operations[0])).toBe(true);
    expect(Object.isFrozen(batches[0].operations)).toBe(true);
  });
  it("uses the injected room-client transport and stable stream identity", () => {
    const b = createDrawingBatcher({ roomCode: "R", canvasId: "C", transport: "room-client", streamId: "stream-1", generation: 4, send: batch => batches.push(batch) });
    b.enqueue(start());
    b.enqueue(end());
    b.enqueue(clear());
    expect(batches.map(batch => [batch.transport, batch.streamId, batch.generation, batch.clientSeq])).toEqual([
      ["room-client", "stream-1", 4, [1, 2]],
      ["room-client", "stream-1", 4, [3, 3]],
    ]);
  });
  it("logs the inspectable batch", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const b = setup();
    b.enqueue(clear());
    sendDrawingBatch(batches[0]);
    expect(spy).toHaveBeenCalledWith("[drawing:batch]", batches[0]);
  });
});
