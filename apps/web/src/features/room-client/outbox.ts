import type { DrawingBatch } from "@/contracts/drawing";

export interface DrawingEnvelope {
  requestId: string;
  playerId: string;
  order: number;
  acceptedSequence?: number;
  expectedRevision?: number;
  generation?: number;
  payload: DrawingBatch;
}

const database = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("more-than-meets-remote-outbox", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("drawing", { keyPath: "requestId" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drawing", mode);
    const request = operation(tx.objectStore("drawing"));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = () => { db.close(); reject(tx.error); };
    tx.onerror = () => {};
  });
}
export const saveDrawingEnvelope = (envelope: DrawingEnvelope) => transaction("readwrite", store => store.put(envelope));
export const deleteDrawingEnvelope = (requestId: string) => transaction("readwrite", store => store.delete(requestId));
export const loadDrawingEnvelopes = () => transaction<DrawingEnvelope[]>("readonly", store => store.getAll());
