import { describe, expect, it, vi } from "vitest";
import { ReplayQueue } from "./replayQueue";

function setup() {
  let frame: (() => void) | undefined;
  let timer: (() => void) | undefined;
  const run = vi.fn<(_items: number[], _reset: boolean) => Promise<void>>(async () => {});
  const queue = new ReplayQueue(run, {
    frame: callback => { frame = callback; return 1; },
    cancelFrame: () => { frame = undefined; },
    timer: callback => { timer = callback; return 1; },
    cancelTimer: () => { timer = undefined; },
  }, () => {});
  return { queue, run, frame: () => frame?.(), timer: () => timer?.() };
}

describe("ReplayQueue", () => {
  it("does not start an invalidated burst after overflow wins its microtask", async () => {
    const { queue, run } = setup();
    const calls = Array.from({ length: 600 }, (_, index) => queue.add([index], false));
    expect((await Promise.allSettled(calls)).every(outcome => outcome.status === "rejected")).toBe(true);
    expect(run).not.toHaveBeenCalled();
    await queue.add([1, 2], true);
    expect(run.mock.calls).toEqual([[[1, 2], true]]);
  });
  it("lets a replacement reset repair an invalidated in-flight failure", async () => {
    const { queue, run, frame } = setup();
    let fail!: (error: Error) => void;
    run.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const first = queue.add([1], false);
    frame();
    await Promise.resolve();
    const tail = Array.from({ length: 600 }, (_, index) => queue.add([index], false));
    expect((await Promise.allSettled([first, ...tail])).every(outcome => outcome.status === "rejected")).toBe(true);
    const replacement = queue.add([1, 2, 3], true);
    fail(new Error("Old fill failed"));
    await expect(replacement).resolves.toBeUndefined();
    expect(queue.requiresReset).toBe(false);
    expect(run.mock.calls.at(-1)).toEqual([[1, 2, 3], true]);
  });
  it("invalidates the prefix on replay failure instead of accepting a later tail", async () => {
    const { queue, run, frame } = setup();
    let fail!: (error: Error) => void;
    run.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const first = queue.add([1], false);
    frame();
    await Promise.resolve();
    const later = queue.add([2], false);
    frame();
    const outcomes = Promise.allSettled([first, later]);
    fail(new Error("Fill failed"));
    expect((await outcomes).map(outcome => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.requiresReset).toBe(true);
    await expect(queue.add([3], false)).rejects.toThrow("authoritative reset");
    await queue.add([1, 2, 3], true);
    expect(queue.requiresReset).toBe(false);
    expect(run.mock.calls.at(-1)).toEqual([[1, 2, 3], true]);
  });
  it("does not enter replay after disposal wins the scheduled microtask", async () => {
    const { queue, run } = setup();
    const pending = queue.add([1], true);
    const rejection = expect(pending).rejects.toThrow("disposed");
    queue.dispose();
    await rejection;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });
  it("delivers an idle burst promptly but coalesces following packets until the frame", async () => {
    const { queue, run, frame } = setup();
    const first = queue.add([1], false);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    await first;
    const second = queue.add([2], false);
    const third = queue.add([3], false);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    frame();
    await Promise.all([second, third]);
    expect(run.mock.calls).toEqual([[[1], false], [[2, 3], false]]);
  });
  it("coalesces incrementals in order and resolves after replay", async () => {
    const { queue, run, frame } = setup();
    const a = queue.add([1], false);
    const b = queue.add([2], false);
    expect(run).not.toHaveBeenCalled();
    frame();
    await Promise.all([a, b]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith([1, 2], false);
  });

  it("keeps reset between batches and does not wait for a frame", async () => {
    const { queue, run, frame } = setup();
    const a = queue.add([1], false);
    const b = queue.add([2], true);
    const c = queue.add([3], false);
    await b;
    expect(run.mock.calls).toEqual([[[1], false], [[2], true]]);
    frame();
    await Promise.all([a, c]);
    expect(run.mock.calls[2]).toEqual([[3], false]);
  });

  it("waits for async replay and rejects pending work on dispose", async () => {
    let finish!: () => void;
    const { queue, run, frame } = setup();
    run.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const a = queue.add([1], false);
    frame();
    await Promise.resolve();
    const b = queue.add([2], false);
    const rejected = Promise.all([expect(a).rejects.toThrow("disposed"), expect(b).rejects.toThrow("disposed")]);
    queue.dispose();
    finish();
    await rejected;
  });

  it("keeps later batches pending behind asynchronous replay", async () => {
    let finish!: () => void;
    const { queue, run, frame } = setup();
    run.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = queue.add([1], false);
    frame();
    await Promise.resolve();
    let resolved = false;
    const second = queue.add([2], false).then(() => { resolved = true; });
    frame();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    expect(run.mock.calls).toEqual([[[1], false], [[2], false]]);
  });

  it("flushes a large burst without waiting for a frame", async () => {
    const { queue, run } = setup();
    const pending = Array.from({ length: 256 }, (_, index) => queue.add([index], false));
    await Promise.all(pending);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toHaveLength(256);
  });

  it("uses a timer when frames are throttled", async () => {
    const { queue, run, timer } = setup();
    const a = queue.add([1], false);
    timer();
    await a;
    expect(run).toHaveBeenCalledWith([1], false);
  });
});

it("bounds stalled replay and requires an authoritative reset after overflow", async () => {
  let finish!: () => void;
  const { queue, run, frame } = setup();
  run.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = queue.add([0], false);
  frame();
  await Promise.resolve();
  const calls = Array.from({ length: 600 }, (_, index) => queue.add([index + 1], false));
  const results = Promise.allSettled([first, ...calls]);
  await expect(queue.add([999], false)).rejects.toMatchObject({ name: "ReplayQueueOverflowError" });
  const settled = await results;
  expect(settled.every(result => result.status === "rejected" && result.reason.name === "ReplayQueueOverflowError")).toBe(true);
  finish();
  const reset = queue.add([42, 43], true);
  await reset;
  expect(run.mock.calls).toEqual([[[0], false], [[42, 43], true]]);
  const next = queue.add([44], false);
  frame();
  await next;
  expect(run.mock.calls.at(-1)).toEqual([[44], false]);
});

it("rejects an oversized reset without truncating it and cancels stale callbacks", async () => {
  let scheduled!: () => void;
  const run = vi.fn<(_items: number[], _reset: boolean) => Promise<void>>(async () => {});
  const queue = new ReplayQueue(run, {
    frame: callback => { scheduled = callback; return 1; },
    cancelFrame: () => {},
    timer: () => 2,
    cancelTimer: () => {},
  }, () => {});
  const pending = queue.add([1], false);
  const rejected = expect(pending).rejects.toMatchObject({ name: "ReplayQueueOverflowError" });
  await expect(queue.add(Array(20_002).fill(0), true)).rejects.toMatchObject({ name: "ReplayQueueOverflowError" });
  await rejected;
  scheduled();
  await Promise.resolve();
  expect(run).not.toHaveBeenCalled();
  await queue.add([2], true);
  expect(run.mock.calls).toEqual([[[2], true]]);
});
