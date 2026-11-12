/** Distance from the bottom, in pixels, still treated as "pinned". */
export const PIN_THRESHOLD_PX = 24;

/**
 * Decide whether the reader is following the conversation.
 *
 * `scrollHeight - scrollTop - clientHeight` is the distance still hidden below
 * the viewport. Within the threshold the reader counts as being at the bottom
 * and may be scrolled for a new message; outside it they are reading history
 * and must be left alone. A log shorter than its viewport is always pinned.
 */
export function isPinnedToBottom(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = PIN_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}
