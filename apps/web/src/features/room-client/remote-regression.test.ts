import "fake-indexeddb/auto";
import { deleteDrawingEnvelope, loadDrawingEnvelopes, saveDrawingEnvelope } from "./outbox";
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
    await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
    const original = socket.requests[0];
    original.ack(new Error("timeout"));
    await expect(sent).rejects.toMatchObject({ code: "connection" });
    socket.receive("room:event", { type: "drawing", canvasId: "retry-test", generation: 10, sequence: 0, reset: true, caughtUp: true, operations: [] });
    await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
    expect(socket.requests[1].envelope.requestId).toBe(original.envelope.requestId);
    socket.requests[1].ack(null, { ok: true, sequence: 1 });
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
  it("cleans only the expired player's room outbox after a confirmed missing room", async () => {
    const payload = { roomCode: "ABC123", canvasId: "c", generation: 1, streamId: "s", clientSeq: [1, 1], operations: [] } as unknown as DrawingBatch;
    await saveDrawingEnvelope({ requestId: "expired", playerId: "p", order: 1, payload });
    await saveDrawingEnvelope({ requestId: "other", playerId: "other", order: 2, payload });
    vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify({ code: "ABC123", playerId: "p", resumeToken: "token" }) });
    const client = new RemoteRoomClient({ fetch: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ code: "not-found", message: "Room not found." }) }) as Response) as typeof fetch });
    await expect(client.resume("ABC123", "token")).rejects.toMatchObject({ code: "session-ended" });
    const entries = await loadDrawingEnvelopes();
    expect(entries.some(item => item.requestId === "expired")).toBe(false);
    expect(entries.some(item => item.requestId === "other")).toBe(true);
    await deleteDrawingEnvelope("other");
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
