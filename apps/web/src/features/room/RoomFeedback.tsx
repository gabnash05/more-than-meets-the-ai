import type { PrivateRoomState, RoomGame, RoomSnapshot } from "@/contracts/room";

type FeedbackProps = {
  phase: RoomSnapshot["phase"];
  role?: PrivateRoomState["role"];
  pending: boolean;
  solved?: boolean;
  closing?: boolean;
  paused?: boolean;
  saving?: RoomGame["saving"];
};

/** Explain confirmed progress without exposing answers. */
export function RoomFeedback({ phase, role, pending, solved, closing, saving, paused }: FeedbackProps) {
  if (phase === "starting") return <p className="room-feedback" role="status">Get ready. Word selection begins after the countdown.</p>;
  if (phase === "choosing") return <p className="room-feedback" role="status">The drawer is choosing a word. Room chat is open.</p>;
  if (phase !== "drawing") return null;
  if (closing) {
    const text = saving === "blocked" ? "Saving is delayed. Results will appear once saved."
      : saving === "saving" ? "Round complete. Saving the drawing and results…"
        : "Round complete. Preparing results…";
    return <p className="room-feedback" role="status">{text}</p>;
  }
  if (paused) return <p className="room-feedback" role="status">Turn paused. Guessing resumes when players reconnect.</p>;
  if (role === "drawer") return <p className="room-feedback" role="status">You are drawing. Guessing and chat are unavailable until the round ends.</p>;
  if (role === "guesser" && solved) return <p className="room-feedback is-correct" role="status">Correct! The others are still guessing.</p>;
  if (role === "guesser" && pending) return <p className="room-feedback" role="status">Checking your guess…</p>;
  return null;
}
