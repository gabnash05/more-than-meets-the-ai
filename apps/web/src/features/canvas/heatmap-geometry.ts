import { CANVAS_HEIGHT, CANVAS_WIDTH } from "@/contracts/drawing";

export interface HeatmapGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HeatmapLayout {
  left: string;
  top: string;
  width: string;
  height: string;
  clipPath: string;
}

const percent = (value: number, total: number) => `${(value / total) * 100}%`;
const inset = (value: number) => `${Math.max(0, Math.min(100, value))}%`;

/**
 * Turn canvas-space geometry into CSS for the overlay.
 *
 * `frame` is the model's square input as a rectangle on the canvas, so it becomes
 * the element's position and size as a percentage of the 1024x768 board. `content`
 * is the ink inside that square, so the four differences become a `clip-path`
 * inset: the adapter's white padding is excluded rather than painted as focus.
 * Differences are clamped to 0-100% so a slightly overflowing rectangle cannot
 * produce a negative inset.
 */
export function heatmapLayout(frame: HeatmapGeometry, content: HeatmapGeometry): HeatmapLayout {
  return {
    left: percent(frame.x, CANVAS_WIDTH),
    top: percent(frame.y, CANVAS_HEIGHT),
    width: percent(frame.width, CANVAS_WIDTH),
    height: percent(frame.height, CANVAS_HEIGHT),
    clipPath: `inset(${inset(((content.y - frame.y) / frame.height) * 100)} ${inset(
      ((frame.x + frame.width - content.x - content.width) / frame.width) * 100,
    )} ${inset(((frame.y + frame.height - content.y - content.height) / frame.height) * 100)} ${inset(
      ((content.x - frame.x) / frame.width) * 100,
    )})`,
  };
}
