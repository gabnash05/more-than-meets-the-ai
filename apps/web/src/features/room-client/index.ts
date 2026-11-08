export type {
  RoomClient,
  RoomSession,
  RoomSnapshot,
  RoomEvent,
  RoomSettings,
  PrivateRoomState,
} from "@/contracts/room";
export { RoomClientError, DEFAULT_ROOM_SETTINGS } from "@/contracts/room";
export { LocalRoomClient } from "./local";
export { RemoteRoomClient } from "./remote";
import type { RoomSession } from "@/contracts/room";
import { LocalRoomClient } from "./local";
import { RemoteRoomClient } from "./remote";
export function createRoomClient() {
  return process.env.NEXT_PUBLIC_ROOM_TRANSPORT === "remote"
    ? new RemoteRoomClient({
        apiUrl: process.env.NEXT_PUBLIC_ROOM_API_URL,
        socketUrl: process.env.NEXT_PUBLIC_ROOM_SOCKET_URL,
      })
    : new LocalRoomClient();
}
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
