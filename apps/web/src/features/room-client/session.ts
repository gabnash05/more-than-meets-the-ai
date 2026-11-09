import type { RoomSession } from "@/contracts/room";

const SESSION_KEY = "mtmai-room-session-v1";

export function saveRoomSession(session: RoomSession) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      code: session.snapshot.code,
      playerId: session.playerId,
      resumeToken: session.resumeToken,
    }),
  );
}

export function loadRoomSession(): {
  code: string;
  resumeToken: string;
  playerId?: string;
} | null {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function clearRoomSession() {
  sessionStorage.removeItem(SESSION_KEY);
}
