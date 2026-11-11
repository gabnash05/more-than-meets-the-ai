import type { DrawingPayload } from "@/contracts/drawing";

export interface DrawingEnvelope {
  requestId: string;
  playerId: string;
  order: number;
  acceptedSequence?: number;
  expectedRevision?: number;
  generation?: number;
  payload: DrawingPayload;
}

export interface DrawingScope { playerId: string; roomCode: string }
let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (connection) return connection;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("more-than-meets-remote-outbox", 2);
    let rejected = false;
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains("drawing")
        ? request.transaction!.objectStore("drawing")
        : request.result.createObjectStore("drawing", { keyPath: "requestId" });
      if (!store.indexNames.contains("player-room")) store.createIndex("player-room", ["playerId", "payload.roomCode"]);
    };
    request.onblocked = () => { rejected = true; reject(new Error("Drawing storage upgrade is blocked by another tab.")); };
    request.onerror = () => reject(request.error ?? new Error("Could not open drawing storage."));
    request.onsuccess = () => {
      const db = request.result;
      if (rejected) { db.close(); return; }
      db.onversionchange = () => { db.close(); if (connection === opening) connection = undefined; };
      db.onclose = () => { if (connection === opening) connection = undefined; };
      resolve(db);
    };
  });
  connection = opening;
  void opening.catch(() => { if (connection === opening) connection = undefined; });
  return opening;
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drawing", mode);
    const request = operation(tx.objectStore("drawing"));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error("Drawing storage transaction aborted."));
    tx.onerror = () => {};
  });
}
type PendingWrite = { envelope: DrawingEnvelope; resolve: (key: IDBValidKey) => void; reject: (error: unknown) => void };
const MAX_WRITE_GROUP = 64;
let queuedWrites: PendingWrite[] = [];
let storageChain: Promise<void> = Promise.resolve();

// All operations enter this chain in call order. A failed transaction must not
// prevent later cleanup, but its own callers still receive the failure.
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = storageChain.then(work);
  storageChain = result.then(() => {}, () => {});
  return result;
}
function flushWrites() {
  if (!queuedWrites.length) return;
  const writes = queuedWrites;
  queuedWrites = [];
  void enqueue(async () => {
    const db = await database();
    return new Promise<IDBValidKey[]>((resolve, reject) => {
      const tx = db.transaction("drawing", "readwrite");
      const requests: IDBRequest<IDBValidKey>[] = [];
      tx.oncomplete = () => resolve(requests.map(request => request.result));
      tx.onabort = () => reject(tx.error ?? new Error("Drawing storage transaction aborted."));
      tx.onerror = () => {};
      try {
        const store = tx.objectStore("drawing");
        for (const write of writes) requests.push(store.put(write.envelope));
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }).then(keys => writes.forEach((write, index) => write.resolve(keys[index])), error => writes.forEach(write => write.reject(error)));
}
export function saveDrawingEnvelope(envelope: DrawingEnvelope): Promise<IDBValidKey> {
  // Capture the value at submission: later ACK metadata must not mutate an
  // older queued put, and every operation retains its own immutable envelope.
  let snapshot: DrawingEnvelope;
  try { snapshot = structuredClone(envelope); }
  catch (error) { return Promise.reject(error); }
  const result = new Promise<IDBValidKey>((resolve, reject) => queuedWrites.push({ envelope: snapshot, resolve, reject }));
  if (queuedWrites.length >= MAX_WRITE_GROUP) flushWrites();
  else if (queuedWrites.length === 1) queueMicrotask(flushWrites);
  return result;
}
export function deleteDrawingEnvelope(requestId: string) {
  flushWrites();
  return enqueue(() => transaction("readwrite", store => store.delete(requestId)));
}
export function loadDrawingEnvelopes(scope?: DrawingScope) {
  flushWrites();
  return enqueue(() => transaction<DrawingEnvelope[]>("readonly", store =>
    scope ? store.index("player-room").getAll(IDBKeyRange.only([scope.playerId, scope.roomCode])) : store.getAll(),
  ));
}
export async function deleteDrawingEnvelopes(requestIds: readonly string[]): Promise<void> {
  if (!requestIds.length) return;
  flushWrites();
  await enqueue(() => transaction("readwrite", store => {
    let request = store.delete(requestIds[0]);
    for (const requestId of requestIds.slice(1)) request = store.delete(requestId);
    return request;
  }));
}
