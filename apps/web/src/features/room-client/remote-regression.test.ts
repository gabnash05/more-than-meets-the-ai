import "fake-indexeddb/auto";
import { deleteDrawingEnvelope, loadDrawingEnvelopes, saveDrawingEnvelope } from "./outbox";
import * as outbox from "./outbox";
import type { DrawingBatch } from "@/contracts/drawing";
import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { DEFAULT_AVATAR } from "@/contracts/player";
import {
  DEFAULT_ROOM_SETTINGS,
  type RoomEvent,
  type RoomSession,
} from "@/contracts/room";
import { RemoteRoomClient } from "./remote";

const profile = { name: "Test", avatar: DEFAULT_AVATAR };
function session(): RoomSession {
  return {
    playerId: "p",
    resumeToken: "token",
    demo: false,
    snapshot: {
      code: "ABC123",
      revision: 1,
      settings: { ...DEFAULT_ROOM_SETTINGS },
      players: [{ id: "p", profile, connected: true, joinedAt: 1 }],
      teams: [],
      hostId: "p",
      phase: "lobby",
      chat: [],
    },
  };
}
class FakeSocket {
  connected = true;
  handlers = new Map<string, (...args: never[]) => void>();
  requests: {
    envelope: Record<string, unknown>;
    ack: (error: Error | null, result?: { ok: boolean; sequence?: number; code?: string }) => void;
  }[] = [];
  on(name: string, fn: (...args: never[]) => void) {
    this.handlers.set(name, fn);
    return this;
  }
  off(name: string) {
    this.handlers.delete(name);
    return this;
  }
  connect() {
    return this;
  }
  disconnect() {
    return this;
  }
  timeout() {
    return this;
  }
  emit(
    _name: string,
    envelope: Record<string, unknown>,
    ack: (error: Error | null, result?: { ok: boolean; sequence?: number; code?: string }) => void,
  ) {
    this.requests.push({ envelope, ack });
    return this;
  }
  receive(name: string, event?: unknown) {
    this.handlers.get(name)?.(event as never);
  }
}
function setup() {
  const socket = new FakeSocket();
  const client = new RemoteRoomClient({
    fetch: vi.fn(
      async () => ({ ok: true, json: async () => session() }) as unknown as Response,
    ) as typeof fetch,
    socketFactory: () => socket as unknown as Socket,
  });
  return { client, socket };
}
describe("remote room recovery", () => {
  it("does not emit any drawing whose grouped storage transaction aborts", async () => {
    const { client, socket } = setup();
    await loadDrawingEnvelopes();
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "abort-wire", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const original = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = original.apply(this, args);
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    });
    try {
      const batch = { roomCode: "ABC123", canvasId: "abort-wire", generation: 1, streamId: "s", operations: [] } as unknown as DrawingBatch;
      const results = await Promise.allSettled([client.submitDrawing(batch), client.submitDrawing(batch)]);
      expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
      expect(socket.requests).toHaveLength(0);
      expect(spy.mock.calls.filter(call => call[1] === "readwrite")).toHaveLength(1);
    } finally { spy.mockRestore(); client.dispose(); }
    expect((await loadDrawingEnvelopes()).filter(item => item.payload.canvasId === "abort-wire")).toEqual([]);
  });
  it("groups concurrent live ACK metadata writes and preserves replay envelopes above the durable watermark", async () => {
    const { client, socket } = setup();
    const batch = { roomCode: "ABC123", canvasId: "ack-group", generation: 1, streamId: "s", operations: [] } as unknown as DrawingBatch;
    const transactions = vi.spyOn(IDBDatabase.prototype, "transaction");
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: "ack-group", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      const sends = Array.from({ length: 4 }, () => client.submitDrawing(batch));
      await vi.waitFor(() => expect(socket.requests).toHaveLength(4));
      const originals = socket.requests.map(request => structuredClone(request.envelope));
      transactions.mockClear();
      socket.requests.forEach((request, index) => request.ack(null, { ok: true, sequence: index + 1 }));
      await Promise.all(sends);
      expect(transactions.mock.calls.filter(call => call[1] === "readwrite")).toHaveLength(1);
      const stored = (await loadDrawingEnvelopes({ playerId: "p", roomCode: "ABC123" })).filter(item => item.payload.canvasId === "ack-group").sort((a, b) => a.order - b.order);
      expect(stored).toEqual(originals.map((item, index) => ({ ...item, acceptedSequence: index + 1 })));
      snapshot.game.sync!.durableSequence = 2;
      socket.receive("room:event", { type: "snapshot", snapshot });
      socket.receive("room:event", { type: "drawing", canvasId: "ack-group", generation: 1, sequence: 4, reset: true, caughtUp: true, operations: [] });
      await vi.waitFor(async () => {
        const remaining = (await loadDrawingEnvelopes()).filter(item => item.payload.canvasId === "ack-group");
        expect(remaining.map(item => item.acceptedSequence).sort()).toEqual([3, 4]);
      });
    } finally {
      transactions.mockRestore(); client.dispose();
      for (const item of await loadDrawingEnvelopes()) if (item.payload.canvasId === "ack-group") await deleteDrawingEnvelope(item.requestId);
    }
  });
  it("replays legacy envelopes serially in stored order with unchanged IDs and payloads", async () => {
    const { client, socket } = setup();
    const items = [2, 1, 3].map(order => ({ requestId: `serial-legacy-${order}`, playerId: "p", order, expectedRevision: 9, generation: 1, payload: { roomCode: "ABC123", canvasId: "serial-legacy", generation: 1, streamId: "legacy", clientSeq: [order, order], operations: [], byteCount: 73 } as unknown as DrawingBatch }));
    await Promise.all(items.map(item => saveDrawingEnvelope(item)));
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: "serial-legacy", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      socket.receive("room:event", { type: "drawing", canvasId: "serial-legacy", generation: 1, sequence: 0, reset: true, caughtUp: true, operations: [] });
      for (let index = 0; index < 3; index++) {
        await vi.waitFor(() => expect(socket.requests).toHaveLength(index + 1));
        expect(socket.requests[index].envelope).toEqual(items.find(item => item.order === index + 1));
        socket.requests[index].ack(null, { ok: true, sequence: index + 1 });
      }
      await vi.waitFor(async () => expect((await loadDrawingEnvelopes()).filter(item => item.payload.canvasId === "serial-legacy" && item.acceptedSequence !== undefined)).toHaveLength(3));
    } finally { client.dispose(); for (const item of items) await deleteDrawingEnvelope(item.requestId); }
  });
  it("retries a legacy stored payload unchanged after recovery", async () => {
    const { client, socket } = setup();
    const payload = { transport: "remote", batchId: "legacy", roomCode: "ABC123", canvasId: "legacy", generation: 1, streamId: "legacy-stream", clientSeq: [1, 1], flushReason: "manual", targetIntervalMs: 33, elapsedMs: 7, operationCount: 0, pointCount: 0, byteCount: 123, operations: [] } as DrawingBatch;
    const envelope = { requestId: "legacy-retry", playerId: "p", order: 1, expectedRevision: 17, generation: 1, payload };
    await saveDrawingEnvelope(envelope);
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: "legacy", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      socket.receive("room:event", { type: "drawing", canvasId: "legacy", generation: 1, sequence: 0, reset: true, caughtUp: true, operations: [] });
      await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
      expect(socket.requests[0].envelope).toEqual(envelope);
      socket.requests[0].ack(null, { ok: true, sequence: 1 });
      await vi.waitFor(async () => expect((await loadDrawingEnvelopes()).find(item => item.requestId === envelope.requestId)?.acceptedSequence).toBe(1));
      expect((await loadDrawingEnvelopes()).find(item => item.requestId === envelope.requestId)?.payload).toEqual(payload);
    } finally { client.dispose(); await deleteDrawingEnvelope(envelope.requestId); }
  });
  it("persists the wire payload before emission without local diagnostics", async () => {
    const { client, socket } = setup();
    const batch = { transport: "room-client", batchId: "wire", roomCode: "ABC123", canvasId: "wire", generation: 1, streamId: "s", clientSeq: [1, 1], flushReason: "manual", targetIntervalMs: 33, elapsedMs: 12, operationCount: 1, pointCount: 1, byteCount: 99, operations: [{ type: "stroke.end", opId: "op", actionId: "action", at: 4, clientSeq: 1, point: { x: 1.23456789, y: 9.87654321, time: 4, pressure: 0.123456 } }] } as DrawingBatch;
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: "wire", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      const sent = client.submitDrawing(batch);
      await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
      const envelope = socket.requests[0].envelope;
      const payload = envelope.payload as Record<string, unknown>;
      expect(payload.operations).toEqual(batch.operations);
      for (const key of ["transport", "flushReason", "targetIntervalMs", "elapsedMs", "operationCount", "pointCount", "byteCount"]) expect(payload).not.toHaveProperty(key);
      expect(await loadDrawingEnvelopes()).toContainEqual(envelope);
      socket.requests[0].ack(null, { ok: true, sequence: 1 });
      await sent;
      await deleteDrawingEnvelope(envelope.requestId as string);
    } finally { client.dispose(); }
  });
  it.each([150, 250, 400, 500])("keeps a 33 ms stream bounded with %i ms ACKs", async (latency) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, socket } = setup();
    const submitted: number[] = [];
    const emitted: number[] = [];
    const acknowledged: number[] = [];
    const sends: Promise<void>[] = [];
    let active = 0;
    let maximum = 0;
    const emit = socket.emit.bind(socket);
    socket.emit = (name, envelope, ack) => {
      emit(name, envelope, ack);
      const index = Number((envelope.payload as DrawingBatch).batchId);
      emitted[index] = Date.now();
      maximum = Math.max(maximum, ++active);
      setTimeout(() => {
        acknowledged[index] = Date.now();
        active--;
        ack(null, { ok: true, sequence: index + 1 });
      }, latency);
      return socket;
    };
    const drain = async () => {
      for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve));
    };
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: `clock-${latency}`, generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      for (let i = 0; i < 90; i++) {
        submitted.push(Date.now());
        sends.push(client.submitDrawing({ roomCode: "ABC123", canvasId: `clock-${latency}`, generation: 1, streamId: "s", batchId: String(i), operations: [] } as unknown as DrawingBatch));
        await drain();
        await vi.advanceTimersByTimeAsync(33);
        await drain();
      }
      await vi.advanceTimersByTimeAsync(latency + 100);
      await drain();
      await Promise.all(sends);
      expect(socket.requests.map(request => (request.envelope.payload as DrawingBatch).batchId)).toEqual(Array.from({ length: 90 }, (_, i) => String(i)));
      expect(new Set(socket.requests.map(request => request.envelope.requestId)).size).toBe(90);
      expect(maximum).toBeLessThanOrEqual(16);
      expect(acknowledged.every((time, i) => time - emitted[i] === latency)).toBe(true);
      const waits = emitted.map((time, i) => time - submitted[i]);
      expect(Math.max(...waits.slice(60))).toBeLessThanOrEqual(Math.max(...waits.slice(30, 60)));
      for (const item of await loadDrawingEnvelopes({ playerId: "p", roomCode: "ABC123" })) {
        if (item.payload.canvasId === `clock-${latency}`) await deleteDrawingEnvelope(item.requestId);
      }
    } finally { client.dispose(); vi.useRealTimers(); }
  });
  it("resumes and sends commands and drawing without crypto.randomUUID", async () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    const { client, socket } = setup();
    try {
      await client.resume("ABC123", "token");
      socket.receive("connect");
      const resync = socket.requests.at(-1)!;
      resync.ack(null, { ok: true });

      const chat = client.sendChat("hello");
      const chatRequest = socket.requests.at(-1)!;
      chatRequest.ack(null, { ok: true });
      await chat;

      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: "uuid-test", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      const batch = { roomCode: "ABC123", canvasId: "uuid-test", generation: 1, streamId: "stream", batchId: "batch", operations: [] } as unknown as DrawingBatch;
      const drawing = client.submitDrawing(batch);
      await vi.waitFor(() => expect(socket.requests).toHaveLength(3));
      const drawingRequest = socket.requests.at(-1)!;
      drawingRequest.ack(null, { ok: true, sequence: 1 });
      await drawing;

      const ids = [resync, chatRequest, drawingRequest].map(request => request.envelope.requestId);
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      await deleteDrawingEnvelope(drawingRequest.envelope.requestId as string);
    } finally {
      client.dispose();
      vi.unstubAllGlobals();
    }
  });
  it("calls browser fetch with its global receiver", async () => {
    const socket = new FakeSocket();
    const native = vi.spyOn(globalThis, "fetch").mockImplementation(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve({ ok: true, json: async () => session() } as Response);
    });
    try {
      const client = new RemoteRoomClient({ socketFactory: () => socket as unknown as Socket });
      await expect(client.create(profile)).resolves.toMatchObject({ playerId: "p" });
      client.dispose();
    } finally { native.mockRestore(); }
  });
  it("shares an in-flight resync and identifies timed-out commands without exposing payloads", async () => {
    const { client, socket } = setup();
    await client.create(profile);
    const first = client.resync();
    const second = client.resync();
    expect(socket.requests).toHaveLength(1);
    socket.requests[0].ack(null, { ok: true });
    await Promise.all([first, second]);
    const guess = client.submitGuess("secret answer");
    socket.requests[1].ack(new Error("timeout"));
    await expect(guess).rejects.toMatchObject({ message: "guess request timed out." });
    client.dispose();
  });
  it("completes an unchanged lobby resync", async () => {
    const { client, socket } = setup();
    const events: RoomEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.create(profile);
    socket.receive("room:event", {
      type: "snapshot",
      snapshot: session().snapshot,
    });
    expect(events).toContainEqual({ type: "connection", status: "connected" });
  });
  it("ignores an old socket resync timeout after a replacement session connects", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let index = 0;
    const client = new RemoteRoomClient({ fetch: vi.fn(async () => ({ ok: true, json: async () => session() }) as Response) as typeof fetch, socketFactory: () => sockets[index++] as unknown as Socket });
    const events: RoomEvent[] = [];
    client.subscribe(event => events.push(event));
    try {
      await client.create(profile);
      sockets[0].receive("connect");
      await client.create(profile);
      sockets[1].receive("room:event", { type: "snapshot", snapshot: session().snapshot });
      events.length = 0;
      sockets[0].requests[0].ack(new Error("timeout"));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(events).toEqual([]);
    } finally { client.dispose(); }
  });
  it("counts every persisted unaccepted batch even beyond the in-flight window", async () => {
    const { client, socket } = setup();
    const counts: number[] = [];
    client.subscribe(event => { if (event.type === "drawing-queue") counts.push(event.pending); });
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "queue-series", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const sends = Array.from({ length: 20 }, (_, i) => client.submitDrawing({ roomCode: "ABC123", canvasId: "queue-series", generation: 1, streamId: "s", batchId: String(i), operations: [] } as unknown as DrawingBatch));
    try {
      await vi.waitFor(async () => expect((await loadDrawingEnvelopes()).filter(item => item.payload.canvasId === "queue-series")).toHaveLength(20));
      await vi.waitFor(() => expect(socket.requests).toHaveLength(16));
      expect(counts.at(-1)).toBe(20);
    } finally {
      for (const request of socket.requests) request.ack(null, { ok: true, sequence: 1 });
      await vi.waitFor(() => expect(socket.requests).toHaveLength(20));
      for (const request of socket.requests.slice(16)) request.ack(null, { ok: true, sequence: 1 });
      await Promise.all(sends);
      expect(counts.at(-1)).toBe(0);
      client.dispose();
      for (const item of await loadDrawingEnvelopes()) if (item.payload.canvasId === "queue-series") await deleteDrawingEnvelope(item.requestId);
    }
  });
  it("restores a replacement session without awaiting its predecessor's failing prune", async () => {
    const { client, socket } = setup();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const load = outbox.loadDrawingEnvelopes;
    let calls = 0;
    const scan = vi.spyOn(outbox, "loadDrawingEnvelopes").mockImplementation(async scope => {
      if (++calls === 1) { enter(); await gate; throw new Error("old prune failed"); }
      return load(scope);
    });
    const events: RoomEvent[] = [];
    client.subscribe(event => events.push(event));
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: "prune-session", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      await entered;
      await client.create(profile);
      events.length = 0;
      socket.receive("room:event", { type: "snapshot", snapshot });
      socket.receive("room:event", { type: "drawing", canvasId: "prune-session", generation: 1, sequence: 0, reset: true, caughtUp: true, operations: [] });
      await vi.waitFor(() => expect(events).toContainEqual({ type: "connection", status: "connected" }), { timeout: 500 });
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(events.some(event => event.type === "connection" && event.status === "disconnected")).toBe(false);
    } finally { release(); scan.mockRestore(); client.dispose(); }
  });
  it("does not delete outbox rows when disposal wins a pending prune scan", async () => {
    const { client, socket } = setup();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const scan = vi.spyOn(outbox, "loadDrawingEnvelopes").mockImplementation(async () => { enter(); await gate; return []; });
    const deletion = vi.spyOn(outbox, "deleteDrawingEnvelopes");
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.game = { canvasId: "dispose-prune", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      await entered;
      client.dispose();
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(deletion).not.toHaveBeenCalled();
    } finally { release(); scan.mockRestore(); deletion.mockRestore(); client.dispose(); }
  });
  it("sends persisted drawing batches in order without waiting for each ACK, with a bounded window", async () => {
    const { client, socket } = setup();
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "window-test", generation: 8, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const sends = Array.from({ length: 17 }, (_, index) => client.submitDrawing({ roomCode: "ABC123", canvasId: "window-test", generation: 8, streamId: "stream", batchId: String(index), operations: [] } as unknown as DrawingBatch));
    await vi.waitFor(() => expect(socket.requests.length).toBeGreaterThanOrEqual(1));
    socket.receive("room:event", { type: "drawing", canvasId: "window-test", generation: 8, sequence: 1, reset: false, caughtUp: true, operations: [] });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(16));
    expect(socket.requests.map(request => (request.envelope.payload as DrawingBatch).batchId)).toEqual(Array.from({ length: 16 }, (_, index) => String(index)));
    const persisted = await loadDrawingEnvelopes();
    expect(socket.requests.every(request => persisted.some(item => item.requestId === request.envelope.requestId))).toBe(true);
    socket.requests[0].ack(null, { ok: true, sequence: 1 });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(17));
    for (let index = 1; index < 17; index++) socket.requests[index].ack(null, { ok: true, sequence: index + 1 });
    await Promise.all(sends);
    for (const item of await loadDrawingEnvelopes()) if (item.payload.canvasId === "window-test") await deleteDrawingEnvelope(item.requestId);
    client.dispose();
  });
  it("waits for outstanding acknowledgements before discarding a rejected tail", async () => {
    const { client, socket } = setup();
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "failure-window", generation: 7, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const batch = { roomCode: "ABC123", canvasId: "failure-window", generation: 7, streamId: "stream", operations: [] } as unknown as DrawingBatch;
    const first = client.submitDrawing(batch);
    const second = client.submitDrawing(batch);
    const settledFirst = first.catch(error => error);
    await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
    // A canonical resync may arrive while both ACKs are outstanding.
    socket.receive("room:event", { type: "drawing", canvasId: "failure-window", generation: 7, sequence: 0, reset: true, caughtUp: true, operations: [] });
    socket.requests[0].ack(null, { ok: false, code: "drawing-paused" });
    socket.requests[1].ack(null, { ok: true, sequence: 1 });
    await second;
    expect(await settledFirst).toMatchObject({ code: "invalid-drawing" });
    const remaining = (await loadDrawingEnvelopes()).filter(item => item.payload.canvasId === "failure-window");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].acceptedSequence).toBe(1);
    await deleteDrawingEnvelope(remaining[0].requestId);
    client.dispose();
  });
  it("retains the complete envelope after timeout and clears it on rejection", async () => {
    const { client, socket } = setup();
    await client.create(profile);
    const first = client.sendChat("hello");
    const original = socket.requests.at(-1)!;
    original.ack(new Error("timeout"));
    await expect(first).rejects.toMatchObject({ code: "connection" });
    const updated = session().snapshot;
    updated.revision = 2;
    socket.receive("room:event", { type: "snapshot", snapshot: updated });
    const retry = client.sendChat("hello");
    const retried = socket.requests.at(-1)!;
    expect(retried.envelope).toEqual(original.envelope);
    retried.ack(null, { ok: false });
    await expect(retry).rejects.toMatchObject({ code: "rejected" });
    const next = client.sendChat("hello");
    const newRequest = socket.requests.at(-1)!;
    expect(newRequest.envelope.requestId).not.toBe(original.envelope.requestId);
    expect(newRequest.envelope.expectedRevision).toBe(2);
    newRequest.ack(null, { ok: true });
    await next;
  });
  it("ignores a late acknowledgement from a timed-out command retry", async () => {
    const { client, socket } = setup();
    await client.create(profile);
    const first = client.sendChat("hello");
    const old = socket.requests[0];
    old.ack(new Error("timeout"));
    await expect(first).rejects.toMatchObject({ code: "connection" });
    const retry = client.sendChat("hello");
    old.ack(null, { ok: true });
    const third = client.sendChat("hello");
    expect(socket.requests[2].envelope.requestId).toBe(socket.requests[1].envelope.requestId);
    socket.requests[1].ack(null, { ok: true });
    socket.requests[2].ack(null, { ok: true });
    await Promise.all([retry, third]);
    client.dispose();
  });
  it("reports unaccepted local batches separately from accepted, undurable batches", async () => {
    const { client, socket } = setup();
    const events: RoomEvent[] = [];
    client.subscribe(event => events.push(event));
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "queue-test", generation: 9, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const batch = { roomCode: "ABC123", canvasId: "queue-test", generation: 9, streamId: "stream", batchId: "batch", operations: [] } as unknown as DrawingBatch;
    const sent = client.submitDrawing(batch);
    await vi.waitFor(() => expect(events).toContainEqual({ type: "drawing-queue", pending: 1 }));
    await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
    const request = socket.requests.at(-1)!;
    request.ack(null, { ok: true, sequence: 1 });
    await sent;
    expect(events.at(-1)).toEqual({ type: "drawing-queue", pending: 0 });
    const retained = (await loadDrawingEnvelopes()).find(item => item.payload.canvasId === "queue-test");
    expect(retained?.acceptedSequence).toBe(1);
    snapshot.revision++;
    snapshot.game!.sync = { sequence: 1, durableSequence: 1 };
    socket.receive("room:event", { type: "snapshot", snapshot });
    await vi.waitFor(async () => expect((await loadDrawingEnvelopes()).some(item => item.payload.canvasId === "queue-test")).toBe(false));
    if (retained) await deleteDrawingEnvelope(retained.requestId);
    client.dispose();
  });
  it("prunes an acknowledgement arriving after its durable watermark", async () => {
    const { client, socket } = setup();
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "late-ack", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const sent = client.submitDrawing({ roomCode: "ABC123", canvasId: "late-ack", generation: 1, streamId: "s", batchId: "b", operations: [] } as unknown as DrawingBatch);
    await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
    snapshot.game.sync = { sequence: 1, durableSequence: 1 };
    socket.receive("room:event", { type: "snapshot", snapshot });
    await new Promise(resolve => setTimeout(resolve, 250));
    socket.requests[0].ack(null, { ok: true, sequence: 1 });
    await sent;
    await vi.waitFor(async () => expect((await loadDrawingEnvelopes()).some(item => item.payload.canvasId === "late-ack")).toBe(false));
    client.dispose();
  });
  it("coalesces prune bursts and runs one dirty follow-up without overlapping scans", async () => {
    const { client, socket } = setup();
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const original = outbox.loadDrawingEnvelopes;
    let active = 0, maximum = 0, scans = 0;
    const spy = vi.spyOn(outbox, "loadDrawingEnvelopes").mockImplementation(async scope => {
      scans++; maximum = Math.max(maximum, ++active);
      try { if (scans === 1) { enter(); await gate; } return await original(scope); }
      finally { active--; }
    });
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: "prune-burst", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      for (let i = 0; i < 30; i++) socket.receive("room:event", { type: "snapshot", snapshot });
      await entered;
      for (let i = 0; i < 30; i++) socket.receive("room:event", { type: "snapshot", snapshot });
      expect(scans).toBe(1);
      release();
      await vi.waitFor(() => expect(scans).toBe(2));
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(scans).toBe(2);
      expect(maximum).toBe(1);
    } finally { release(); spy.mockRestore(); client.dispose(); }
  });
  it("reports a prune failure and retains accepted data", async () => {
    const { client, socket } = setup();
    const events: RoomEvent[] = [];
    client.subscribe(event => events.push(event));
    const item = { requestId: "prune-failure", playerId: "p", order: 1, generation: 1, acceptedSequence: 1, payload: { roomCode: "ABC123", canvasId: "prune-failure", operations: [] } as unknown as DrawingBatch };
    await saveDrawingEnvelope(item);
    const spy = vi.spyOn(outbox, "loadDrawingEnvelopes").mockRejectedValue(new Error("storage failed"));
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: "prune-failure", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 1, durableSequence: 1 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      await vi.waitFor(() => expect(events).toContainEqual({ type: "connection", status: "disconnected", message: "Could not save drawing changes on this device." }));
    } finally { spy.mockRestore(); client.dispose(); }
    expect(await loadDrawingEnvelopes({ playerId: "p", roomCode: "ABC123" })).toContainEqual(item);
    await deleteDrawingEnvelope(item.requestId);
  });
  it("retries an ambiguously acknowledged drawing with its original ID after hydration", async () => {
    const { client, socket } = setup();
    const events: RoomEvent[] = [];
    client.subscribe(event => events.push(event));
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "retry-test", generation: 10, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const batch = { roomCode: "ABC123", canvasId: "retry-test", generation: 10, streamId: "stream", batchId: "batch", operations: [] } as unknown as DrawingBatch;
    const sent = client.submitDrawing(batch);
    const second = client.submitDrawing({ ...batch, batchId: "second" });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
    const original = socket.requests[0];
    socket.requests[1].ack(null, { ok: true, sequence: 2 });
    await second;
    original.ack(new Error("timeout"));
    await expect(sent).rejects.toMatchObject({ code: "connection" });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(3));
    socket.requests[2].ack(null, { ok: true });
    socket.receive("room:event", { type: "drawing", canvasId: "retry-test", generation: 10, sequence: 0, reset: true, caughtUp: true, operations: [] });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(4));
    expect(socket.requests[3].envelope.requestId).toBe(original.envelope.requestId);
    socket.requests[3].ack(null, { ok: true, sequence: 1 });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "connection", status: "connected" }));
    expect(events).toContainEqual({ type: "drawing-queue", pending: 0 });
    for (const item of await loadDrawingEnvelopes()) if (item.payload.canvasId === "retry-test") await deleteDrawingEnvelope(item.requestId);
    client.dispose();
  });
  it.each([true, false])("warns for old-generation data only when not known durable (durable=%s)", async (durable) => {
    const { client, socket } = setup();
    const events: RoomEvent[] = [];
    client.subscribe(event => events.push(event));
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "old-generation-test", generation: 21, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 2, durableSequence: 2 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const requestId = crypto.randomUUID();
    await saveDrawingEnvelope({ requestId, playerId: "p", order: 1, generation: 21, ...(durable ? { acceptedSequence: 2 } : {}), payload: { roomCode: "ABC123", canvasId: "old-generation-test", generation: 21, operations: [] } as unknown as DrawingBatch });
    events.length = 0;
    const next = structuredClone(snapshot);
    next.revision++;
    next.game!.canvasId = "new-generation-test";
    next.game!.generation = 22;
    next.game!.sync = { sequence: 0, durableSequence: 0 };
    socket.receive("room:event", { type: "snapshot", snapshot: next });
    await vi.waitFor(async () => expect((await loadDrawingEnvelopes()).some(item => item.requestId === requestId)).toBe(false));
    expect(events.some(event => event.type === "gameplay" && event.name === "drawing-tail-discarded")).toBe(!durable);
    client.dispose();
  });
  it.each(["drawing-paused", "expired", "stale-generation", "invalid-drawing"])("retires a rejected %s tail, retains accepted data and restores the canonical stream", async code => {
    const { client, socket } = setup();
    const events: RoomEvent[] = [];
    client.subscribe(event => events.push(event));
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "rejected-tail", generation: 30, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 1, durableSequence: 0 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const batch = { roomCode: "ABC123", canvasId: "rejected-tail", generation: 30, streamId: "old-stream", batchId: "batch", operations: [] } as unknown as DrawingBatch;
    const acceptedId = crypto.randomUUID();
    await saveDrawingEnvelope({ requestId: acceptedId, playerId: "p", order: 0, generation: 30, acceptedSequence: 1, payload: batch });
    const sent = client.submitDrawing(batch);
    await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
    socket.requests[0].ack(null, { ok: false, code });
    await expect(sent).rejects.toMatchObject({ code: "invalid-drawing" });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
    const retained = (await loadDrawingEnvelopes()).filter(item => item.payload.canvasId === "rejected-tail");
    expect(retained.map(item => item.requestId)).toEqual([acceptedId]);
    expect(events).toContainEqual({ type: "gameplay", name: "drawing-tail-discarded" });
    expect(events).toContainEqual({ type: "drawing-queue", pending: 0 });
    socket.requests[1].ack(null, { ok: true });
    socket.receive("room:event", { type: "drawing", canvasId: "rejected-tail", generation: 30, sequence: 1, reset: true, caughtUp: true, operations: [] });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "connection", status: "connected" }));
    await deleteDrawingEnvelope(acceptedId);
    client.dispose();
  });
  it("stays restoring after a rejected reconnect tail until the fresh canonical replay catches up", async () => {
    const { client, socket } = setup();
    const events: RoomEvent[] = [];
    client.subscribe(event => events.push(event));
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "restore-rejected", generation: 31, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 1, durableSequence: 1 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const requestId = crypto.randomUUID();
    await saveDrawingEnvelope({ requestId, playerId: "p", order: 1, generation: 31, payload: { roomCode: "ABC123", canvasId: "restore-rejected", generation: 31, streamId: "old-stream", operations: [] } as unknown as DrawingBatch });
    const replay = { type: "drawing", canvasId: "restore-rejected", generation: 31, sequence: 1, reset: true, caughtUp: true, operations: [] };
    socket.receive("room:event", replay);
    await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
    socket.requests[0].ack(null, { ok: false, code: "drawing-paused" });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
    expect(events.some(event => event.type === "connection" && event.status === "connected")).toBe(false);
    expect(events).toContainEqual({ type: "gameplay", name: "drawing-tail-discarded" });
    socket.requests[1].ack(null, { ok: true });
    socket.receive("room:event", replay);
    await vi.waitFor(() => expect(events).toContainEqual({ type: "connection", status: "connected" }));
    expect((await loadDrawingEnvelopes()).some(item => item.requestId === requestId)).toBe(false);
    client.dispose();
  });
  it("does not repeatedly resync when replay encounters a retryable rejection", async () => {
    const { client, socket } = setup();
    const events: RoomEvent[] = [];
    client.subscribe(event => events.push(event));
    await client.create(profile);
    const snapshot = session().snapshot;
    snapshot.phase = "drawing";
    snapshot.game = { canvasId: "retry-once", generation: 6, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
    socket.receive("room:event", { type: "snapshot", snapshot });
    const sent = client.submitDrawing({ roomCode: "ABC123", canvasId: "retry-once", generation: 6, streamId: "stream", operations: [] } as unknown as DrawingBatch);
    await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
    socket.requests[0].ack(null, { ok: false, code: "saving-unavailable" });
    await expect(sent).rejects.toMatchObject({ code: "saving-unavailable" });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
    socket.requests[1].ack(null, { ok: true });
    socket.receive("room:event", { type: "drawing", canvasId: "retry-once", generation: 6, sequence: 0, reset: true, caughtUp: true, operations: [] });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(3));
    socket.requests[2].ack(null, { ok: false, code: "saving-unavailable" });
    await vi.waitFor(() => expect(events.some(event => event.type === "connection" && event.status === "disconnected")).toBe(true));
    expect(socket.requests).toHaveLength(3);
    for (const item of await loadDrawingEnvelopes()) if (item.payload.canvasId === "retry-once") await deleteDrawingEnvelope(item.requestId);
    client.dispose();
  });
  it("wraps invalid JSON in a typed error", async () => {
    const client = new RemoteRoomClient({
      fetch: vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => {
              throw new SyntaxError();
            },
          }) as unknown as Response,
      ) as typeof fetch,
    });
    await expect(client.create(profile)).rejects.toMatchObject({
      code: "malformed",
    });
  });
});


describe("expired remote sessions", () => {
  it.each(["initial", "accepted"])("waits for an uncommitted %s transaction during expiry and rejects new work", async phase => {
    const socket = new FakeSocket();
    const fetcher = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ code: "unauthorized" }) }) as Response);
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => session() } as Response);
    const client = new RemoteRoomClient({ fetch: fetcher as typeof fetch, socketFactory: () => socket as unknown as Socket });
    const other = { requestId: `expiry-other-${phase}`, playerId: "other", order: 1, payload: { roomCode: "ABC123", canvasId: "other" } as DrawingBatch };
    let holding = false;
    let selected: IDBTransaction | undefined;
    let completed = false;
    let reads = 0;
    const original = IDBDatabase.prototype.transaction;
    const transactions = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = original.apply(this, args);
      if (holding && !selected && args[1] === "readwrite") {
        selected = tx;
        tx.addEventListener("complete", () => { completed = true; });
        // The first read precedes the puts; subsequent reads run after them
        // and keep this actual transaction active until the test releases it.
        const keepAlive = () => {
          const request = tx.objectStore("drawing").get("expiry-keepalive-missing");
          request.onsuccess = () => { reads++; if (holding) keepAlive(); };
        };
        keepAlive();
      }
      return tx;
    });
    try {
      await saveDrawingEnvelope(other);
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: `expiry-group-${phase}`, generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      const batch = { roomCode: "ABC123", canvasId: `expiry-group-${phase}`, generation: 1, streamId: "s", operations: [] } as unknown as DrawingBatch;
      if (phase === "initial") holding = true;
      const sends = [client.submitDrawing(batch), client.submitDrawing(batch)];
      const settled = Promise.allSettled(sends);
      if (phase === "accepted") {
        await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
        holding = true;
        socket.requests.forEach((request, index) => request.ack(null, { ok: true, sequence: index + 1 }));
      }
      await vi.waitFor(() => { expect(selected).toBeDefined(); expect(reads).toBeGreaterThanOrEqual(2); });
      expect(completed).toBe(false);
      socket.receive("connect_error", new Error("Unauthorized"));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect((client as unknown as { expiringSession: RoomSession | null }).expiringSession).toBeTruthy());
      await expect(client.submitDrawing(batch)).rejects.toMatchObject({ code: "session-ended" });
      expect(completed).toBe(false);
      expect(client.getSession()).not.toBeNull();
      if (phase === "initial") expect(socket.requests).toHaveLength(0);
      holding = false;
      await vi.waitFor(() => expect(completed).toBe(true));
      await settled;
      await vi.waitFor(() => expect(client.getSession()).toBeNull());
      const rows = await loadDrawingEnvelopes();
      expect(rows.filter(item => item.payload.canvasId === batch.canvasId)).toEqual([]);
      expect(rows).toContainEqual(other);
      socket.requests.forEach(request => request.ack(null, { ok: true, sequence: 99 }));
      expect((await loadDrawingEnvelopes()).filter(item => item.payload.canvasId === batch.canvasId)).toEqual([]);
    } finally { holding = false; transactions.mockRestore(); client.dispose(); await deleteDrawingEnvelope(other.requestId); }
  });
  it("rejects new drawing writes while session expiry is scanning storage", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ code: "unauthorized" }) }) as Response);
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => session() } as Response);
    const client = new RemoteRoomClient({ fetch: fetcher as typeof fetch, socketFactory: () => socket as unknown as Socket });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const load = outbox.loadDrawingEnvelopes;
    const scan = vi.spyOn(outbox, "loadDrawingEnvelopes").mockImplementation(async scope => {
      const rows = await load(scope);
      if (!scope) { enter(); await gate; }
      return rows;
    });
    const writes = vi.spyOn(outbox, "saveDrawingEnvelope");
    try {
      await client.create(profile);
      socket.receive("connect_error", new Error("Unauthorized"));
      await entered;
      const result = client.submitDrawing({ roomCode: "ABC123", canvasId: "expiry-new-write", generation: 1, streamId: "s", operations: [] } as unknown as DrawingBatch).catch(error => error);
      expect(writes).not.toHaveBeenCalled();
      expect(await result).toMatchObject({ code: "session-ended" });
      release();
      await vi.waitFor(() => expect(client.getSession()).toBeNull());
    } finally {
      release(); scan.mockRestore(); writes.mockRestore(); client.dispose();
      for (const item of await load()) if (item.payload.canvasId === "expiry-new-write") await deleteDrawingEnvelope(item.requestId);
    }
  });
  it("waits for an already-started acceptance write before expiry cleanup", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ code: "unauthorized" }) }) as Response);
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => session() } as Response);
    const client = new RemoteRoomClient({ fetch: fetcher as typeof fetch, socketFactory: () => socket as unknown as Socket });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const save = outbox.saveDrawingEnvelope;
    const spy = vi.spyOn(outbox, "saveDrawingEnvelope").mockImplementation(async envelope => {
      if (envelope.acceptedSequence !== undefined) { entered(); await gate; }
      return save(envelope);
    });
    let id = "";
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: "expiry-write", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      const sent = client.submitDrawing({ roomCode: "ABC123", canvasId: "expiry-write", generation: 1, streamId: "s", operations: [] } as unknown as DrawingBatch);
      await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
      id = socket.requests[0].envelope.requestId as string;
      socket.requests[0].ack(null, { ok: true, sequence: 1 });
      await started;
      socket.receive("connect_error", new Error("Unauthorized"));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      // Let expiry run while the accepted metadata write is still pending.
      await new Promise(resolve => setTimeout(resolve, 50));
      release();
      await sent;
      await vi.waitFor(() => expect(client.getSession()).toBeNull());
      expect((await loadDrawingEnvelopes()).some(item => item.requestId === id)).toBe(false);
    } finally {
      release(); spy.mockRestore();
      if (id) await deleteDrawingEnvelope(id);
      client.dispose();
    }
  });
  it("does not resurrect an expired envelope when its ACK races session cleanup", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ code: "unauthorized" }) }) as Response);
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => session() } as Response);
    const client = new RemoteRoomClient({ fetch: fetcher as typeof fetch, socketFactory: () => socket as unknown as Socket });
    let enterCleanup!: () => void, releaseCleanup!: () => void;
    const entered = new Promise<void>(resolve => { enterCleanup = resolve; });
    const gate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const originalDelete = outbox.deleteDrawingEnvelope;
    const deletion = vi.spyOn(outbox, "deleteDrawingEnvelope").mockImplementation(async id => {
      await originalDelete(id);
      enterCleanup();
      await gate;
    });
    let requestId = "";
    try {
      await client.create(profile);
      const snapshot = session().snapshot;
      snapshot.phase = "drawing";
      snapshot.game = { canvasId: "expiry-ack-race", generation: 1, drawerId: "p", hint: "", time: "", scores: {}, sync: { sequence: 0, durableSequence: 0 } };
      socket.receive("room:event", { type: "snapshot", snapshot });
      const sent = client.submitDrawing({ roomCode: "ABC123", canvasId: "expiry-ack-race", generation: 1, streamId: "s", operations: [] } as unknown as DrawingBatch);
      await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
      requestId = socket.requests[0].envelope.requestId as string;
      socket.receive("connect_error", new Error("Unauthorized"));
      await entered;
      // The record is gone, but expiry still owns the old session until cleanup
      // returns. Its late ACK must not recreate that record in this window.
      socket.requests[0].ack(null, { ok: true, sequence: 1 });
      await sent;
      releaseCleanup();
      await vi.waitFor(() => expect(client.getSession()).toBeNull());
      expect((await loadDrawingEnvelopes()).some(item => item.requestId === requestId)).toBe(false);
    } finally {
      releaseCleanup();
      deletion.mockRestore();
      if (requestId) await deleteDrawingEnvelope(requestId);
      client.dispose();
    }
  });
  it("cleans only the expired player's room outbox after a confirmed missing room", async () => {
    const payload = { roomCode: "ABC123", canvasId: "c", generation: 1, streamId: "s", clientSeq: [1, 1], operations: [] } as unknown as DrawingBatch;
    await saveDrawingEnvelope({ requestId: "expired", playerId: "p", order: 1, payload });
    await saveDrawingEnvelope({ requestId: "other", playerId: "other", order: 2, payload });
    await saveDrawingEnvelope({ requestId: "other-room", playerId: "p", order: 3, payload: { ...payload, roomCode: "OTHER" } });
    vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify({ code: "ABC123", playerId: "p", resumeToken: "token" }) });
    const client = new RemoteRoomClient({ fetch: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ code: "not-found", message: "Room not found." }) }) as Response) as typeof fetch });
    await expect(client.resume("ABC123", "token")).rejects.toMatchObject({ code: "session-ended" });
    const entries = await loadDrawingEnvelopes();
    expect(entries.some(item => item.requestId === "expired")).toBe(false);
    expect(entries.some(item => item.requestId === "other")).toBe(true);
    expect(entries.some(item => item.requestId === "other-room")).toBe(true);
    await deleteDrawingEnvelope("other");
    await deleteDrawingEnvelope("other-room");
    vi.unstubAllGlobals();
    client.dispose();
  });
  it("retains outbox on transient resume failure", async () => {
    const payload = { roomCode: "ABC123", canvasId: "c", generation: 1, streamId: "s", clientSeq: [1, 1], operations: [] } as unknown as DrawingBatch;
    await saveDrawingEnvelope({ requestId: "transient", playerId: "p", order: 1, payload });
    const client = new RemoteRoomClient({ fetch: vi.fn(async () => { throw new Error("offline"); }) as typeof fetch });
    await expect(client.resume("ABC123", "token")).rejects.toMatchObject({ code: "connection" });
    expect((await loadDrawingEnvelopes()).some(item => item.requestId === "transient")).toBe(true);
    await deleteDrawingEnvelope("transient");
    client.dispose();
  });
});
