import type { ChatMessage } from "@/contracts/room";

export interface ChatRow {
  id: string;
  name: string;
  text: string;
  correct: boolean;
}

/**
 * Build the rows to render, resolving each author once.
 *
 * The component previously searched the player list for every message on every
 * render. With a 100-message log and a snapshot roughly five times a second
 * during a round, that is thousands of scans where one map will do.
 */
export function chatRows(
  chat: readonly ChatMessage[],
  players: readonly { id: string; profile: { name: string } }[],
): ChatRow[] {
  const names = new Map<string, string>();
  for (const player of players) names.set(player.id, player.profile.name);
  return chat.map(message => ({
    id: message.id,
    name: names.get(message.playerId) ?? "Room",
    text: message.text,
    correct: message.kind === "correct",
  }));
}
