import type { CanvasOperation } from "@/contracts/drawing";
/** Finish an interrupted local stroke deterministically; remote ordering is server-owned. */
export function closeInterruptedStroke(
  operations: CanvasOperation[],
): CanvasOperation[] {
  let start: Extract<CanvasOperation, { type: "stroke.start" }> | undefined;
  let point = undefined as
    Extract<CanvasOperation, { type: "stroke.start" }>["point"] | undefined;
  let at = 0;
  for (const op of operations) {
    if (op.type === "stroke.start") {
      start = op;
      point = op.point;
      at = op.at;
    } else if (op.type === "stroke.append" && start) {
      point = op.points.at(-1) ?? point;
      at = op.at;
    } else if (op.type === "stroke.end") {
      start = undefined;
      point = undefined;
    }
  }
  if (!start || !point) return [];
  const opId = `recovered-end:${start.actionId}`;
  if (operations.some((op) => op.opId === opId)) return [];
  return [{ type: "stroke.end", opId, actionId: start.actionId, point, at }];
}
