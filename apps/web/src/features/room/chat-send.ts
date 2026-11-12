/**
 * Client-side send state for the room composer.
 *
 * The composer must clear the moment the user submits. Waiting for the socket
 * acknowledgement leaves the message sitting in the box for a whole round trip,
 * which reads as an unresponsive input. These helpers keep that decision out of
 * the React component so it can be tested without a DOM.
 */
export interface ChatSendDecision {
  /** Trimmed text to send. */
  text: string;
  /** Draft value to show immediately, before the acknowledgement arrives. */
  draft: "";
}

/**
 * Decide how to start a send.
 *
 * @returns `null` when the draft is empty or a send is already in flight;
 *          otherwise the trimmed text and the empty draft to display now.
 */
export function beginChatSend(draft: string, inFlight: boolean): ChatSendDecision | null {
  const text = draft.trim();
  if (!text || inFlight) return null;
  return { text, draft: "" };
}

/**
 * Draft value after a failed send.
 *
 * Restores the text the user lost only when the composer is still empty. If
 * they have already started typing something else, their new text wins.
 */
export function restoreChatDraft(currentDraft: string, sentText: string): string {
  return currentDraft.trim() ? currentDraft : sentText;
}
