"use client";
import { useEffect, useRef, useState } from "react";
import type { RoomClient } from "@/contracts/room";
import { DEFAULT_DRAWING_SETTINGS, type DrawingCanvasHandle } from "@/contracts/drawing";
import DrawingCanvas from "@/features/canvas/DrawingCanvas";

export function SavedSketch({ getClient, canvasId, generation }: { getClient: () => RoomClient | null; canvasId: string; generation: number }) {
  const canvas = useRef<DrawingCanvasHandle>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void getClient()?.getInterruptedSketch(canvasId, generation)
      .then(sketch => canvas.current?.hydrate(sketch.operations))
      .catch(() => { if (active) setError("Could not load the saved drawing."); });
    return () => { active = false; };
  }, [getClient, canvasId, generation]);
  return <>{error && <p role="alert">{error}</p>}<DrawingCanvas ref={canvas} readOnly settings={DEFAULT_DRAWING_SETTINGS} onOperation={() => {}} /></>;
}
