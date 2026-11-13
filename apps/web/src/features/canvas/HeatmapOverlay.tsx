"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RoomGame } from "@/contracts/room";
import { heatmapLayout } from "./heatmap-geometry";

const GRID = 14;
/** Strength of the hottest cell. Below 1 so the ink underneath stays readable. */
const PEAK_ALPHA = 0.92;
/** Fraction of the frame's range that counts as noise and is painted transparent. */
const FLOOR = 0.34;
/** How strong the oldest kept frame is, relative to the newest. */
const OLDEST_ALPHA = 0.24;
/** Maps composited into the trail, newest on top. */
const TRAIL_FRAMES = 6;
/** Thumbnails shown in the strip; the most recent ones only. */
const STRIP_FRAMES = 4;
/** Cyan → yellow → red, the same ramp the on-board legend shows. */
const RAMP: [number, number, number][] = [
  [34, 199, 242],
  [255, 232, 61],
  [255, 59, 48],
];

type Heatmap = NonNullable<RoomGame["aiHeatmap"]>;
type Guess = { answer: string; confidence: number };

/** One observed map, with the prediction it belonged to. */
type Frame = {
  signature: string;
  /** 196 bytes rather than 196 boxed numbers: a long drawing keeps every frame. */
  grid: Uint8Array;
  label: string;
};

/**
 * Interpolate the colour ramp for one cell weight.
 *
 * `weight` is 0-1. The ramp is split into equal segments and blended within the
 * matching pair, so adding a stop later needs no other change.
 */
function ramp(weight: number): [number, number, number] {
  const position = weight * (RAMP.length - 1);
  const index = Math.min(RAMP.length - 2, Math.floor(position));
  const blend = position - index;
  const from = RAMP[index];
  const to = RAMP[index + 1];
  return [
    Math.round(from[0] + (to[0] - from[0]) * blend),
    Math.round(from[1] + (to[1] - from[1]) * blend),
    Math.round(from[2] + (to[2] - from[2]) * blend),
  ];
}

/**
 * Render one 14x14 grid into an ImageData buffer.
 *
 * The raw grid puts a low value in almost every cell, so painting it honestly
 * tints the whole box and reads as a rectangle rather than as focus. The values
 * are therefore rescaled against the frame's own peak: everything under
 * `PEAK * FLOOR` becomes fully transparent (the model is not looking there), and
 * the rest is stretched across the ramp. That is a per-frame contrast stretch —
 * it shows *where* attention concentrates, never how confident the model is, so
 * confidence stays in the label rather than in the colour.
 *
 * `floorAlpha` keeps weak cells visible for the small history thumbnails, which
 * sit on a white card where a transparent cell would leave nothing to read.
 */
function gridImage(context: CanvasRenderingContext2D, grid: ArrayLike<number>, floorAlpha: number): ImageData {
  let peak = 0;
  for (let index = 0; index < grid.length; index += 1) peak = Math.max(peak, grid[index]);
  const cut = peak * FLOOR;
  const span = Math.max(1, peak - cut);
  const image = context.createImageData(GRID, GRID);
  for (let index = 0; index < grid.length; index += 1) {
    // Rescale against this frame's own peak, then clamp to the 0-1 ramp.
    const weight = Math.max(0, Math.min(1, (grid[index] - cut) / span));
    const offset = index * 4;
    const [red, green, blue] = ramp(weight);
    image.data[offset] = red;
    image.data[offset + 1] = green;
    image.data[offset + 2] = blue;
    image.data[offset + 3] = weight === 0
      ? 0
      : Math.round((floorAlpha + (1 - floorAlpha) * weight) * 255 * PEAK_ALPHA);
  }
  return image;
}

/** One mini-map in the history strip, titled with the guess it belonged to. */
function Thumb({ frame }: { frame: Frame }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!context) return;
    context.putImageData(gridImage(context, frame.grid, 0.45), 0, 0);
  }, [frame]);
  return <canvas ref={canvas} className="room-heatmap-thumb" width={GRID} height={GRID} title={frame.label} aria-hidden="true" />;
}

/**
 * Paint the Guesser's 14x14 attention map over the live canvas.
 *
 * The grid describes the model's square input, so the overlay is positioned from
 * `frame` and clipped to `content`: the white padding the adapter added is never
 * painted as focus. The element uses `mix-blend-mode: screen` in CSS, so colour
 * survives only where the drawer left ink — over white paper the blend resolves to
 * white and the map disappears. That is what turns a tinted rectangle into "it is
 * looking at these strokes".
 *
 * Successive maps are kept for the whole drawing — every one of them — and the most
 * recent `TRAIL_FRAMES` are composited oldest-first with increasing opacity, so the
 * newest frame is strongest and earlier attention lingers as a trail. That trail is
 * the only way to see movement: each map is a still, and without it a viewer cannot
 * tell a shifted focus from a widened one. The strip shows only the most recent
 * `STRIP_FRAMES`, so it stays a glance rather than a filmstrip, while the trail can
 * still reach further back. `drawing` (canvas and generation) identifies the turn,
 * so history resets exactly when a different drawing starts.
 *
 * Every room snapshot deserialises a fresh heatmap object, so an effect keyed on
 * that object would repaint — and clear — the canvas several times a second even
 * when the pixels are identical. Identical payloads are therefore skipped, and the
 * backing store is only resized when its size actually differs.
 */
export function HeatmapOverlay({ heatmap, guess, drawing }: { heatmap?: Heatmap; guess?: Guess; drawing?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const history = useRef<Frame[]>([]);
  const painted = useRef("");
  const owned = useRef<string | undefined>(undefined);
  const [frames, setFrames] = useState<Frame[]>([]);

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element || !heatmap) return;

    // A new turn means a different drawing: start the trail over. Identity comes
    // from the canvas and generation, never from a guess about the geometry.
    if (owned.current !== drawing) {
      owned.current = drawing;
      history.current = [];
      painted.current = "";
    }

    const box = `${heatmap.frame.x},${heatmap.frame.y},${heatmap.frame.width},${heatmap.frame.height}`;
    const signature = `${heatmap.grid.join(",")}|${box}`;
    if (painted.current === signature) return;
    painted.current = signature;

    const label = guess ? `${guess.answer} · ${Math.round(guess.confidence * 100)}%` : "no prediction yet";
    const newest = history.current[history.current.length - 1];
    if (newest?.signature !== signature) {
      // Every map of the drawing is kept: memory is 196 bytes per frame, and a
      // heavy drawer can easily produce more than a dozen in one round.
      history.current = [...history.current, { signature, grid: Uint8Array.from(heatmap.grid), label }];
    }

    if (element.width !== GRID) element.width = GRID;
    if (element.height !== GRID) element.height = GRID;
    const context = element.getContext("2d");
    if (!context) return;

    // Older frames go down first at lower opacity; the newest lands on top at
    // full strength, so the trail reads as a path rather than a smear.
    const buffer = scratch.current ?? (scratch.current = document.createElement("canvas"));
    buffer.width = GRID;
    buffer.height = GRID;
    const bufferContext = buffer.getContext("2d");
    if (!bufferContext) return;
    context.clearRect(0, 0, GRID, GRID);
    const trail = history.current.slice(-TRAIL_FRAMES);
    trail.forEach((frame, index) => {
      // putImageData is blind to globalAlpha, so each frame is painted into the
      // scratch canvas and stamped down as an image at the weight for its age.
      bufferContext.putImageData(gridImage(bufferContext, frame.grid, 0.15), 0, 0);
      context.globalAlpha = OLDEST_ALPHA + (1 - OLDEST_ALPHA) * ((index + 1) / trail.length);
      context.drawImage(buffer, 0, 0);
    });
    context.globalAlpha = 1;
    setFrames(history.current.slice(-STRIP_FRAMES));
  }, [heatmap, guess, drawing]);

  if (!heatmap) return null;
  const layout = heatmapLayout(heatmap.frame, heatmap.content);
  return (
    <>
      <canvas
        ref={canvas}
        className="room-heatmap"
        aria-hidden="true"
        style={{
          left: layout.left,
          top: layout.top,
          width: layout.width,
          height: layout.height,
          clipPath: layout.clipPath,
        }}
      />
      {guess && (
        <span className="room-heatmap-guess" aria-hidden="true">
          {guess.answer} · {Math.round(guess.confidence * 100)}%
        </span>
      )}
      {frames.length > 1 && (
        <div className="room-heatmap-history" aria-hidden="true">
          {frames.map(frame => <Thumb key={frame.signature} frame={frame} />)}
        </div>
      )}
    </>
  );
}
