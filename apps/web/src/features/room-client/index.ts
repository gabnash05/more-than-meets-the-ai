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
export { saveRoomSession, loadRoomSession, clearRoomSession } from "./session";
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
