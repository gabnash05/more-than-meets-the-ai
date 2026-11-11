import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { DrawingBatch } from "@/contracts/drawing";
import { deleteDrawingEnvelope, loadDrawingEnvelopes, saveDrawingEnvelope } from "./outbox";

describe("remote drawing outbox", () => {
  it("commits a burst atomically in fewer transactions and orders reads and deletes", async () => {
    const items = Array.from({ length: 12 }, (_, order) => ({
      requestId: `group-${order}`, playerId: "group", order,
      payload: { roomCode: "GROUP", canvasId: "c", operations: [{ order }] } as unknown as DrawingBatch,
    }));
    await loadDrawingEnvelopes();
    const transactions = vi.spyOn(IDBDatabase.prototype, "transaction");
    try {
      const writes = items.map(item => saveDrawingEnvelope(item));
      const read = loadDrawingEnvelopes({ playerId: "group", roomCode: "GROUP" });
      expect((await read).sort((a, b) => a.order - b.order)).toEqual(items);
      expect(await Promise.all(writes)).toEqual(items.map(item => item.requestId));
      expect(transactions.mock.calls.filter(call => call[1] === "readwrite").length).toBeLessThan(items.length);
      const deletion = deleteDrawingEnvelope(items[0].requestId);
      const replacement = { ...items[0], acceptedSequence: 9 };
      const put = saveDrawingEnvelope(replacement);
      await Promise.all([deletion, put]);
      expect(await loadDrawingEnvelopes({ playerId: "group", roomCode: "GROUP" })).toContainEqual(replacement);
    } finally {
      transactions.mockRestore();
      await Promise.all(items.map(item => deleteDrawingEnvelope(item.requestId)));
    }
  });
  it("reuses its connection and scopes records by player and room", async () => {
    const open = vi.spyOn(indexedDB, "open");
    const items = [["a", "ONE"], ["b", "ONE"], ["a", "TWO"]].map(([playerId, roomCode]) => ({
      requestId: crypto.randomUUID(), playerId, order: 1,
      payload: { roomCode, canvasId: "c", operations: [] } as unknown as DrawingBatch,
    }));
    for (const item of items) await saveDrawingEnvelope(item);
    expect(await loadDrawingEnvelopes({ playerId: "a", roomCode: "ONE" })).toEqual([items[0]]);
    for (const item of items) await deleteDrawingEnvelope(item.requestId);
    expect(open.mock.calls.length).toBeLessThanOrEqual(1);
    open.mockRestore();
  });
  it("preserves version 1 envelopes when adding the scope index", async () => {
    const factory = new IDBFactory();
    const envelope = { requestId: "old", playerId: "p", order: 42, acceptedSequence: 3, generation: 2, payload: { roomCode: "OLD", canvasId: "c", operations: [] } };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("more-than-meets-remote-outbox", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drawing", { keyPath: "requestId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drawing", "readwrite");
      tx.objectStore("drawing").put(envelope);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    vi.stubGlobal("indexedDB", factory);
    try {
      vi.resetModules();
      const migrated = await import("./outbox");
      expect(await migrated.loadDrawingEnvelopes({ playerId: "p", roomCode: "OLD" })).toEqual([envelope]);
    } finally { vi.unstubAllGlobals(); }
  });
  it("reports a blocked upgrade and retries after the other connection closes", async () => {
    const factory = new IDBFactory();
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("more-than-meets-remote-outbox", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drawing", { keyPath: "requestId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    vi.stubGlobal("indexedDB", factory);
    try {
      vi.resetModules();
      const storage = await import("./outbox");
      await expect(storage.loadDrawingEnvelopes()).rejects.toThrow("upgrade is blocked");
      old.close();
      await expect(storage.loadDrawingEnvelopes()).resolves.toEqual([]);
    } finally { old.close(); vi.unstubAllGlobals(); }
  });
  it("invalidates the cached connection on version change", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    try {
      vi.resetModules();
      const storage = await import("./outbox");
      await storage.loadDrawingEnvelopes();
      const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open("more-than-meets-remote-outbox", 3);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      upgraded.close();
      await expect(storage.loadDrawingEnvelopes()).rejects.toBeInstanceOf(Error);
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects an aborted transaction instead of claiming a write committed", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    try {
      vi.resetModules();
      const storage = await import("./outbox");
      await storage.loadDrawingEnvelopes();
      const original = IDBDatabase.prototype.transaction;
      const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
        const tx = original.apply(this, args);
        queueMicrotask(() => tx.abort());
        return tx;
      });
      try {
        await expect(storage.saveDrawingEnvelope({ requestId: "aborted", playerId: "p", order: 1, payload: { roomCode: "R" } as DrawingBatch })).rejects.toThrow("aborted");
      } finally { spy.mockRestore(); }
      expect(await storage.loadDrawingEnvelopes()).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects every write in an aborted group without committing any", async () => {
    await loadDrawingEnvelopes();
    const original = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = original.apply(this, args);
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    });
    const items = ["abort-a", "abort-b"].map(requestId => ({ requestId, playerId: "abort-group", order: 1, payload: { roomCode: "R" } as DrawingBatch }));
    try {
      const results = await Promise.allSettled(items.map(item => saveDrawingEnvelope(item)));
      expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
      expect(spy.mock.calls.filter(call => call[1] === "readwrite")).toHaveLength(1);
    } finally { spy.mockRestore(); }
    expect((await loadDrawingEnvelopes()).filter(item => item.playerId === "abort-group")).toEqual([]);
  });
  it("rejects a whole group on synchronous put failure and permits later operations", async () => {
    await loadDrawingEnvelopes();
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (++calls === 2) throw new DOMException("Cannot clone", "DataCloneError");
      return original.apply(this, args);
    });
    const items = ["clone-a", "clone-b", "clone-c"].map(requestId => ({ requestId, playerId: "clone-group", order: 1, payload: { roomCode: "R" } as DrawingBatch }));
    try {
      const results = await Promise.allSettled(items.map(item => saveDrawingEnvelope(item)));
      expect(results.every(result => result.status === "rejected" && result.reason.name === "DataCloneError")).toBe(true);
    } finally { put.mockRestore(); }
    expect((await loadDrawingEnvelopes()).filter(item => item.playerId === "clone-group")).toEqual([]);
    await saveDrawingEnvelope(items[0]);
    await deleteDrawingEnvelope(items[0].requestId);
    expect((await loadDrawingEnvelopes()).filter(item => item.playerId === "clone-group")).toEqual([]);
  });
  it("rejects every grouped write when opening storage fails and retries later", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    try {
      vi.resetModules();
      const storage = await import("./outbox");
      const open = vi.spyOn(factory, "open").mockImplementationOnce(() => { throw new Error("open failed"); });
      const items = ["open-a", "open-b"].map(requestId => ({ requestId, playerId: "p", order: 1, payload: { roomCode: "R" } as DrawingBatch }));
      const results = await Promise.allSettled(items.map(item => storage.saveDrawingEnvelope(item)));
      expect(results.every(result => result.status === "rejected" && result.reason.message === "open failed")).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
      expect(await storage.loadDrawingEnvelopes()).toEqual([]);
      await storage.saveDrawingEnvelope(items[0]);
      await storage.deleteDrawingEnvelope(items[0].requestId);
      expect(await storage.loadDrawingEnvelopes()).toEqual([]);
      open.mockRestore();
    } finally { vi.unstubAllGlobals(); }
  });
  it("keeps later accepted metadata when puts for the same ID are queued", async () => {
    const item = { requestId: "metadata-order", playerId: "p", order: 1, payload: { roomCode: "R" } as DrawingBatch };
    try {
      const first = saveDrawingEnvelope(item);
      const second = saveDrawingEnvelope({ ...item, acceptedSequence: 7 });
      await Promise.all([first, second]);
      expect(await loadDrawingEnvelopes()).toContainEqual({ ...item, acceptedSequence: 7 });
    } finally { await deleteDrawingEnvelope(item.requestId); }
  });
  it("persists the complete retry envelope until acknowledged", async () => {
    const envelope = {
      requestId: crypto.randomUUID(), playerId: "player", order: 1,
      expectedRevision: 4, generation: 2,
      payload: { roomCode: "ABC123", canvasId: "canvas", generation: 2, batchId: "batch", operations: [] } as unknown as DrawingBatch,
    };
    await saveDrawingEnvelope(envelope);
    expect(await loadDrawingEnvelopes()).toContainEqual(envelope);
    await deleteDrawingEnvelope(envelope.requestId);
    expect(await loadDrawingEnvelopes()).not.toContainEqual(envelope);
  });
});
