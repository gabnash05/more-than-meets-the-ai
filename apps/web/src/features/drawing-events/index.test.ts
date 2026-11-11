import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toDrawingPayload, type CanvasOperation, type DrawingBatch } from "@/contracts/drawing";
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
      "stroke-start",
      "interval",
      "stroke-end",
    ]);
    expect(batches.map((x) => x.elapsedMs)).toEqual([0, 33, 33]);
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(3);
  });
  it("keeps the flush deadline instead of restarting a full wait after each idle gap", () => {
    const b = setup();
    b.enqueue(start());
    expect(batches[0].flushReason).toBe("stroke-start");
    vi.advanceTimersByTime(15);
    b.enqueue(append());
    vi.advanceTimersByTime(17);
    expect(batches).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(batches).toHaveLength(2);
    expect(batches[1].flushReason).toBe("interval");
    vi.advanceTimersByTime(100);
    b.enqueue(append());
    expect(batches).toHaveLength(3);
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(3);
  });
  it("flushes a short stroke immediately and orders edits after pending ink", () => {
    const b = setup();
    b.enqueue(start());
    b.enqueue(end());
    b.enqueue(append());
    b.enqueue(clear());
    expect(batches.map((x) => x.operations.map((op) => op.type))).toEqual([
      ["stroke.start"],
      ["stroke.end"],
      ["stroke.append"],
      ["canvas.clear"],
    ]);
    expect(batches.map((x) => x.flushReason)).toEqual([
      "stroke-start",
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
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
    expect(batches[1].pointCount).toBe(1);
    expect(batches[1].operationCount).toBe(1);
    expect(new Set(batches.map((x) => x.batchId)).size).toBe(4);
    for (const batch of batches)
      expect(batch.byteCount).toBe(
        new TextEncoder().encode(JSON.stringify(toDrawingPayload(batch))).length,
      );
  });
  it("flushes once on disposal and ignores subsequent calls", () => {
    const b = setup();
    b.enqueue(append());
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
      ["room-client", "stream-1", 4, [1, 1]],
      ["room-client", "stream-1", 4, [2, 2]],
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

describe("bounded drawing payloads", () => {
  it("rejects an append above the server per-operation point limit before emitting anything", () => {
    const batches: DrawingBatch[] = [];
    const b = createDrawingBatcher({ roomCode: "R", canvasId: "C", send: x => batches.push(x) });
    expect(() => b.enqueue({ ...append(), points: Array.from({ length: 600 }, () => ({ ...point })) } as CanvasOperation)).toThrow("exceeds");
    expect(batches).toHaveLength(0);
    b.enqueue(start());
    expect(batches[0].clientSeq).toEqual([1, 1]);
    b.dispose();
  });
  it("sends starts immediately and batches movement within caps", () => {
    const batches: DrawingBatch[] = [];
    const b = createDrawingBatcher({ roomCode: "é", canvasId: "C", maxOperations: 2, maxPoints: 2, send: x => batches.push(x) });
    b.enqueue(start());
    expect(batches[0].flushReason).toBe("stroke-start");
    for (let i = 0; i < 5; i++) b.enqueue({ ...append(), opId: `${i}` });
    b.flush();
    expect(batches.map(x => x.operations.length)).toEqual([1, 2, 2, 1]);
    expect(batches.flatMap(x => x.operations.map(op => op.clientSeq))).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("counts canonical UTF-8 bytes and splits at the exact byte boundary", () => {
    const batches: DrawingBatch[] = [];
    const options = { roomCode: "é", canvasId: "C", streamId: "流", generation: 2, send: (x: DrawingBatch) => batches.push(x) };
    const first = createDrawingBatcher(options);
    first.enqueue(append()); first.flush();
    const cap = batches[0].byteCount;
    expect(cap).toBe(new TextEncoder().encode(JSON.stringify(toDrawingPayload(batches[0]))).length);
    expect(Object.keys(toDrawingPayload(batches[0]))).not.toContain("byteCount");
    batches.length = 0;
    const bounded = createDrawingBatcher({ ...options, maxBytes: cap });
    bounded.enqueue(append()); bounded.enqueue(append()); bounded.flush();
    expect(batches).toHaveLength(2);
    expect(batches.every(batch => batch.byteCount <= cap)).toBe(true);
    expect(batches.map(batch => batch.operations[0].opId)).toEqual(["2", "2"]);
  });
  it("rejects invalid configuration and oversized operations without consuming sequence", () => {
    expect(() => createDrawingBatcher({ roomCode: "R", canvasId: "C", intervalMs: Infinity })).toThrow();
    expect(() => createDrawingBatcher({ roomCode: "R", canvasId: "C", maxPoints: NaN })).toThrow();
    const batches: DrawingBatch[] = [];
    const b = createDrawingBatcher({ roomCode: "R", canvasId: "C", maxPoints: 2, send: x => batches.push(x) });
    expect(() => b.enqueue({ ...append(), points: Array.from({ length: 5000 }, () => ({ ...point })) } as CanvasOperation)).toThrow();
    b.enqueue(append()); b.flush();
    expect(batches[0].clientSeq).toEqual([1, 1]);
  });
  it("preflights growing batch headers before changing pending work", () => {
    const batches: DrawingBatch[] = [];
    const b = createDrawingBatcher({ roomCode: "R", canvasId: "C", maxBytes: 400, send: x => batches.push(x) });
    for (let i = 0; i < 8; i++) b.enqueue({ ...clear(), opId: `clear-${i}` });
    b.enqueue(append());
    const candidate = append();
    const bytes = () => new TextEncoder().encode(JSON.stringify({
      ...toDrawingPayload(batches[7]), batchId: batches[7].batchId.replace(/-8$/, "-9"),
      clientSeq: [10, 10], operations: [{ ...candidate, clientSeq: 10 }],
    })).length;
    // Fit batch 9 exactly. Flushing the pending append would put this operation
    // in batch 10, whose larger header makes it invalid without changing input.
    while (bytes() < 400) candidate.opId += bytes() < 399 ? "é" : "x";
    expect(bytes()).toBe(400);
    expect(() => b.enqueue(candidate)).toThrow("exceeds");
    expect(batches).toHaveLength(8);
    b.flush();
    expect(batches[8].clientSeq).toEqual([9, 9]);
    b.enqueue({ ...append(), opId: "valid-next" }); b.flush();
    expect(batches[9].clientSeq).toEqual([10, 10]);
    expect(batches.every(batch => batch.byteCount <= 400)).toBe(true);
    b.dispose();
  });
});
