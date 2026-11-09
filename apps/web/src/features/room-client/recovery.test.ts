import { describe, expect, it } from "vitest";
import { closeInterruptedStroke } from "./recovery";
import type { CanvasOperation } from "@/contracts/drawing";
const point = { x: 1, y: 2, time: 3 };
const start: CanvasOperation = {
  type: "stroke.start",
  opId: "start",
  actionId: "a",
  at: 4,
  settings: { tool: "brush", color: "#000", size: 4 },
  point,
};
describe("local recovery", () => {
  it("closes a trailing stroke deterministically, once", () => {
    const end = closeInterruptedStroke([start]);
    expect(end).toEqual([
      {
        type: "stroke.end",
        opId: "recovered-end:a",
        actionId: "a",
        at: 4,
        point,
      },
    ]);
    expect(closeInterruptedStroke([start, ...end])).toEqual([]);
  });
});
