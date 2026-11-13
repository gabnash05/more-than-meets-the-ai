import { expect, it } from "vitest";
import { heatmapLayout } from "./heatmap-geometry";

const CANVAS = { x: 0, y: 0, width: 1024, height: 768 };

it("fills the board when the model input covers the whole canvas", () => {
  const layout = heatmapLayout(CANVAS, CANVAS);
  expect(layout).toEqual({
    left: "0%",
    top: "0%",
    width: "100%",
    height: "100%",
    clipPath: "inset(0% 0% 0% 0%)",
  });
});

it("clips the padded margin around the ink", () => {
  // The adapter fitted a square input across the canvas and padded 10% each side.
  const frame = { x: 0, y: 0, width: 1000, height: 800 };
  const content = { x: 100, y: 80, width: 800, height: 640 };
  expect(heatmapLayout(frame, content).clipPath).toBe("inset(10% 10% 10% 10%)");
});

it("places a partially off-canvas input without overflowing the board", () => {
  const frame = { x: 512, y: 384, width: 512, height: 384 };
  const layout = heatmapLayout(frame, { x: 512, y: 384, width: 512, height: 384 });
  expect(layout.left).toBe("50%");
  expect(layout.top).toBe("50%");
  expect(layout.width).toBe("50%");
  expect(layout.height).toBe("50%");
  expect(layout.clipPath).toBe("inset(0% 0% 0% 0%)");
});

it("clamps an ink box that extends beyond the model input", () => {
  const frame = { x: 100, y: 100, width: 200, height: 200 };
  const content = { x: 50, y: 50, width: 400, height: 400 };
  expect(heatmapLayout(frame, content).clipPath).toBe("inset(0% 0% 0% 0%)");
});
