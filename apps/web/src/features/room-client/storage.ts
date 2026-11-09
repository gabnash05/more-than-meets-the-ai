import type { RoomSession } from "@/contracts/room";
import { RoomClientError } from "@/contracts/room";

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("more-than-meets-room-demo", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("rooms");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function deleteStoredRoom(store: IDBObjectStore, code: string) {
  store.delete(code);
  const cursor = store.openCursor();
  cursor.onsuccess = () => {
    const entry = cursor.result;
    if (!entry) return;
    if (
      typeof entry.key === "string" &&
      entry.key.startsWith("session:") &&
      entry.value?.roomCode === code
    ) {
      entry.delete();
    }
    entry.continue();
  };
}

/** Persist a room and its viewer credential in one transaction. */
export async function persistLocalRoomSession(
  session: RoomSession,
  expectedRevision?: number | null,
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("rooms", "readwrite");
    const store = tx.objectStore("rooms");
    let conflict = false;
    const current = store.get(session.snapshot.code);
    current.onsuccess = () => {
      const existing = current.result as RoomSession | undefined;
      if (
        expectedRevision !== undefined &&
        (expectedRevision === null
          ? !!existing
          : existing?.snapshot.revision !== expectedRevision)
      ) {
        conflict = true;
        tx.abort();
        return;
      }
      if (session.snapshot.phase === "closed") {
        deleteStoredRoom(store, session.snapshot.code);
      } else {
        store.put(session, session.snapshot.code);
        store.put(
          {
            playerId: session.playerId,
            resumeToken: session.resumeToken,
            privateState: session.privateState,
            roomCode: session.snapshot.code,
          },
          `session:${session.resumeToken}`,
        );
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(
        conflict
          ? new RoomClientError(
              "stale",
              "Room changed in another tab. Restore the room and retry.",
              true,
            )
          : tx.error,
      );
    };
    tx.onerror = () => {};
  });
}

export async function loadLocalRoomSession(
  code: string,
): Promise<RoomSession | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("rooms", "readonly");
    const request = tx.objectStore("rooms").get(code);
    tx.oncomplete = () => {
      db.close();
      resolve(request.result ?? null);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function loadLocalCredential(
  token: string,
): Promise<
  | (Pick<RoomSession, "playerId" | "resumeToken" | "privateState"> & {
      roomCode?: string;
    })
  | null
> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("rooms", "readonly");
    const request = tx.objectStore("rooms").get(`session:${token}`);
    tx.oncomplete = () => {
      db.close();
      resolve(request.result ?? null);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function deleteLocalRoomSession(code: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("rooms", "readwrite");
    deleteStoredRoom(tx.objectStore("rooms"), code);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}
