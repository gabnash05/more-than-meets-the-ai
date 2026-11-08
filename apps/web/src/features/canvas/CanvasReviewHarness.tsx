"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_DRAWING_SETTINGS, type CanvasOperation, type DrawingCanvasHandle, type DrawingSettings } from "@/contracts/drawing";
import DrawingCanvas from "./DrawingCanvas";
import { SavedSketch } from "@/features/room/SavedSketch";
import type { RoomClient } from "@/contracts/room";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type CanvasReviewApi = {
  echo(): Promise<void>;
  replayAndUnmount(): void;
  operations(): CanvasOperation[];
  renderPng(prefix: CanvasOperation[]): Promise<string | null>;
};

declare global {
  interface Window { canvasReview?: CanvasReviewApi }
}

/** Isolated browser harness for exercising the imperative replay interface. */
export default function CanvasReviewHarness() {
  const canvas = useRef<DrawingCanvasHandle>(null);
  const operations = useRef<CanvasOperation[]>([]);
  const [mounted, setMounted] = useState(true);
  const [outcome, setOutcome] = useState("idle");
  const [settings, setSettings] = useState<DrawingSettings>(DEFAULT_DRAWING_SETTINGS);
  const getArchiveClient = useCallback(() => ({
    getInterruptedSketch: async () => ({ canvasId: "review", generation: 1, sequence: operations.current.length, operations: [...operations.current] }),
  }) as unknown as RoomClient, []);
  useEffect(() => {
    window.canvasReview = {
      echo: () => canvas.current!.applyOperations([...operations.current]),
      replayAndUnmount: () => {
        const pending = canvas.current!.applyOperations([]);
        pending.then(() => setOutcome("resolved"), error => setOutcome(error.message));
        setMounted(false);
      },
      operations: () => [...operations.current],
      renderPng: async prefix => {
        await canvas.current!.hydrate(prefix);
        const source = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Drawing canvas"]')!;
        const image = document.createElement("canvas");
        image.width = source.width;
        image.height = source.height;
        const context = image.getContext("2d", { willReadFrequently: true })!;
        context.fillStyle = "#fff";
        context.fillRect(0, 0, image.width, image.height);
        context.drawImage(source, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height).data;
        return pixels.some(value => value < 255) ? image.toDataURL("image/png") : null;
      },
    };
    return () => { delete window.canvasReview; };
  }, []);
  return <main>
    <button onClick={() => setSettings({ ...settings, tool: "fill" })}>Fill</button>
    <Dialog><DialogTrigger asChild><button>View saved drawings</button></DialogTrigger><DialogContent><DialogTitle>Saved drawings</DialogTitle><DialogDescription>Local review fixture</DialogDescription><SavedSketch getClient={getArchiveClient} canvasId="review" generation={1} /></DialogContent></Dialog>
    <output data-testid="replay-outcome">{outcome}</output>
    {mounted && <DrawingCanvas ref={canvas} settings={settings} onOperation={operation => operations.current.push(operation)} />}
  </main>;
}
