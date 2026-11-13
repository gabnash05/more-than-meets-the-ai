import type { DrawingSettings } from "@/contracts/drawing";
import type { FreeDrawMode } from "./types";

export interface FreeDrawSaved {
  bitmap: Blob;
  metadata: {
    settings: DrawingSettings;
    mode: FreeDrawMode;
    prompt: string;
    toggles: { guesser: boolean; referee: boolean; heatmap: boolean };
  };
}
const DB_NAME = "mmtai-free-draw";
const STORE = "current";
let saveQueue: Promise<void> = Promise.resolve();
let newestSave = 0;
let saveSequence = 0;
export function nextFreeDrawSaveVersion(): number {
  saveSequence += 1;
  return saveSequence;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("Browser storage is unavailable."));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open browser storage."));
  });
}
export async function loadFreeDraw(): Promise<FreeDrawSaved | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get("snapshot");
      r.onsuccess = () => resolve(r.result as FreeDrawSaved | undefined);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
export function saveFreeDraw(
  value: FreeDrawSaved,
  version: number,
): Promise<void> {
  saveSequence = Math.max(saveSequence, version);
  newestSave = Math.max(newestSave, version);
  const write = async () => {
    if (version < newestSave) return;
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, "snapshot");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () =>
          reject(tx.error ?? new Error("Could not save drawing."));
      });
    } finally {
      db.close();
    }
  };
  const task = saveQueue.then(write);
  saveQueue = task.catch(() => {});
  return task;
}
