"use client";

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type Atrament from "atrament";
import { createUuid as uid } from "@/lib/uuid";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  type CanvasOperation,
  type CanvasPoint,
  type DrawingCanvasHandle,
  type DrawingCanvasProps,
} from "../../contracts/drawing";
import { BitmapHistory, type Snapshot } from "./history";
import styles from "./DrawingCanvas.module.css";

type Engine = { undo(): void; redo(): void; clear(): void; finish(): void; hydrate(operations: CanvasOperation[]): Promise<void>; applyOperations(operations: CanvasOperation[]): Promise<void> };
const DrawingCanvas = forwardRef<DrawingCanvasHandle, DrawingCanvasProps>(
  function DrawingCanvas(props, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const propsRef = useRef(props);
    const engineRef = useRef<Engine | null>(null);
    propsRef.current = props;
    useImperativeHandle(
      ref,
      () => ({
        undo: () => engineRef.current?.undo(),
        redo: () => engineRef.current?.redo(),
        clear: () => engineRef.current?.clear(),
        hydrate: (operations) => engineRef.current?.hydrate(operations) ?? Promise.reject(new Error("Canvas is unavailable")),
        applyOperations: (operations) => engineRef.current?.applyOperations(operations) ?? Promise.reject(new Error("Canvas is unavailable")),
      }),
      [],
    );

    useLayoutEffect(() => {
      const canvas = canvasRef.current!;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      let history = new BitmapHistory();
      let replaying = false;
      let replayPending = 0;
      let replayQueue = Promise.resolve();
      const seen = new Set<string>();
      let readyResolve!: () => void;
      let readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      void ready.catch(() => {});
      let alive = true,
        busy = false,
        hasInk = false;
      let artist: Atrament | undefined;
      let worker: Worker | undefined;
      let cancelFill: (() => void) | undefined;
      let queue: (() => void)[] = [];
      const pendingFillWaiters = new Set<(error: Error) => void>();
      let active:
        | {
            pointerId: number;
            actionId: string;
            before: Snapshot;
            last: CanvasPoint;
            previousX: number;
            previousY: number;
            started: number;
          }
        | undefined;
      const status = () => {
        canvas.dataset.ready = String(!!artist);
        canvas.setAttribute("aria-busy", String(!artist || busy || replaying || replayPending > 0));
        propsRef.current.onStatusChange?.({
          canUndo: history.canUndo,
          canRedo: history.canRedo,
          busy: !artist || busy || replaying || replayPending > 0,
          hasInk,
        });
      };
      const emit = (op: CanvasOperation) => { if (!replaying) { seen.add(op.opId); propsRef.current.onOperation(op); } };
      const base = (actionId: string) => ({
        opId: uid(),
        actionId,
        at: Date.now(),
      });
      const snapshot = (): Snapshot => ({
        image: context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT),
        hasInk,
      });
      const detectInk = () => {
        const pixels = context.getImageData(
          0,
          0,
          CANVAS_WIDTH,
          CANVAS_HEIGHT,
        ).data;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i + 3] &&
            (pixels[i] !== 255 ||
              pixels[i + 1] !== 255 ||
              pixels[i + 2] !== 255)
          )
            return true;
        return false;
      };
      const restore = (s: Snapshot) => {
        context.putImageData(s.image, 0, 0);
        hasInk = s.hasInk;
      };
      const point = (e: PointerEvent, started: number): CanvasPoint => {
        const r = canvas.getBoundingClientRect();
        return {
          x: Math.max(
            0,
            Math.min(
              CANVAS_WIDTH - 1,
              ((e.clientX - r.left) * CANVAS_WIDTH) / r.width,
            ),
          ),
          y: Math.max(
            0,
            Math.min(
              CANVAS_HEIGHT - 1,
              ((e.clientY - r.top) * CANVAS_HEIGHT) / r.height,
            ),
          ),
          time: Math.max(0, performance.now() - started),
          pressure: e.pressure || 0.5,
        };
      };
      // Atrament receives a logical-size view so replay is independent of CSS sizing.
      const external = (p: CanvasPoint) => ({ x: p.x, y: p.y });
      const finish = () => {
        if (!active || !artist) return;
        const s = active;
        active = undefined;
        const p = external(s.last);
        artist.endStroke(p.x, p.y);
        history.push(s.actionId, s.before);
        hasInk = detectInk();
        emit({ ...base(s.actionId), type: "stroke.end", point: s.last });
        if (canvas.hasPointerCapture(s.pointerId))
          canvas.releasePointerCapture(s.pointerId);
        status();
      };
      const command = (run: () => void) => {
        if (propsRef.current.readOnly || replaying || replayPending || replayStroke) return;
        finish();
        if (busy) queue.push(run);
        else run();
      };
      const drain = () => {
        while (!busy && queue.length && alive) queue.shift()?.();
      };
      const fill = (p: CanvasPoint, color: string, replayOp?: Extract<CanvasOperation, { type: "fill" }>, done?: (error?: Error) => void) => {
        if (!worker) {
          try {
            worker = new Worker(new URL("./fill.worker.ts", import.meta.url));
          } catch {
            propsRef.current.onError?.("Fill worker is unavailable.");
            done?.(new Error("Fill worker is unavailable."));
            return;
          }
        }
        const actionId = replayOp?.actionId ?? uid();
        const before = snapshot();
        // Composite transparency over white before filling so erased pixels match the visible surface.
        const layer = document.createElement("canvas");
        layer.width = CANVAS_WIDTH;
        layer.height = CANVAS_HEIGHT;
        const layerContext = layer.getContext("2d")!;
        layerContext.fillStyle = "white";
        layerContext.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        layerContext.drawImage(canvas, 0, 0);
        const data = layerContext.getImageData(
          0,
          0,
          CANVAS_WIDTH,
          CANVAS_HEIGHT,
        ).data;
        busy = true;
        status();
        cancelFill = () => done?.(new Error("Canvas was disposed during fill"));
        const fail = (message: string) => {
          if (!alive) return;
          busy = false;
          cancelFill = undefined;
          propsRef.current.onError?.(message);
          done?.(new Error(message));
          status();
          drain();
        };
        worker.onmessage = (
          event: MessageEvent<{
            data?: Uint8ClampedArray<ArrayBuffer>;
            changed?: boolean;
            error?: string;
          }>,
        ) => {
          if (!alive) return;
          if (event.data.error || !event.data.data) {
            fail(event.data.error || "Fill failed.");
            return;
          }
          if (event.data.changed) {
            context.putImageData(
              new ImageData(event.data.data, CANVAS_WIDTH, CANVAS_HEIGHT),
              0,
              0,
            );
            history.push(actionId, before);
            hasInk = detectInk();
            emit({
              ...base(actionId),
              type: "fill",
              point: p,
              color,
              tolerance: 0,
            });
          }
          busy = false;
          cancelFill = undefined;
          done?.();
          status();
          drain();
        };
        worker.onerror = () => {
          worker?.terminate();
          worker = undefined;
          fail("Fill worker failed.");
        };
        try {
          worker.postMessage(
            {
              data,
              width: CANVAS_WIDTH,
              height: CANVAS_HEIGHT,
              x: Math.floor(p.x),
              y: Math.floor(p.y),
              color,
            },
            [data.buffer],
          );
        } catch {
          worker?.terminate();
          worker = undefined;
          fail("Could not start fill.");
        }
      };
      const down = (e: PointerEvent) => {
        e.stopImmediatePropagation();
        if (!artist || busy || active || replaying || replayPending || replayStroke || propsRef.current.readOnly || e.button !== 0) return;
        e.preventDefault();
        const started = performance.now();
        const p = point(e, started);
        const settings = { ...propsRef.current.settings };
        if (settings.tool === "fill") {
          fill(p, settings.color);
          return;
        }
        const actionId = uid(),
          before = snapshot(),
          ext = external(p);
        artist.mode = settings.tool === "eraser" ? "erase" : "draw";
        artist.color = settings.color;
        artist.weight = settings.size;
        artist.adaptiveStroke = false;
        artist.pressureLow = 1;
        artist.pressureHigh = 1;
        artist.beginStroke(ext.x, ext.y);
        // Atrament strokes a quadratic path; a nonzero segment is needed for a visible tap.
        const next = artist.draw(ext.x + 0.1, ext.y, ext.x, ext.y, p.pressure);
        active = {
          pointerId: e.pointerId,
          actionId,
          before,
          last: p,
          previousX: next.x,
          previousY: next.y,
          started,
        };
        canvas.setPointerCapture(e.pointerId);
        emit({ ...base(actionId), type: "stroke.start", settings, point: p });
      };
      const move = (e: PointerEvent) => {
        e.stopImmediatePropagation();
        if (!active || !artist || e.pointerId !== active.pointerId) return;
        e.preventDefault();
        const points: CanvasPoint[] = [];
        const coalesced = e.getCoalescedEvents?.() || [];
        for (const sample of coalesced.length ? coalesced : [e]) {
          const p = point(sample, active.started),
            ext = external(p);
          const next = artist.draw(
            ext.x,
            ext.y,
            active.previousX,
            active.previousY,
            p.pressure,
          );
          active.previousX = next.x;
          active.previousY = next.y;
          active.last = p;
          points.push(p);
        }
        if (points.length)
          emit({ ...base(active.actionId), type: "stroke.append", points });
      };
      const up = (e: PointerEvent) => {
        e.stopImmediatePropagation();
        if (active?.pointerId === e.pointerId) {
          const p = point(e, active.started);
          if (artist && (p.x !== active.last.x || p.y !== active.last.y)) {
            const ext = external(p);
            artist.draw(
              ext.x,
              ext.y,
              active.previousX,
              active.previousY,
              p.pressure,
            );
            emit({
              ...base(active.actionId),
              type: "stroke.append",
              points: [p],
            });
          }
          active.last = p;
          finish();
        }
      };
      const cancel = (e: PointerEvent) => {
        e.stopImmediatePropagation();
        if (active?.pointerId === e.pointerId) finish();
      };
      const hidden = () => {
        if (document.hidden) finish();
      };
      // Replay uses the exact same Atrament setup and point calls as pointer capture.
      let replayStroke: { actionId: string; before: Snapshot; last: CanvasPoint; previousX: number; previousY: number } | undefined;
      const replay = async (operations: CanvasOperation[], reset: boolean) => {
        await ready;
        if (busy) await new Promise<void>((resolve, reject) => {
          pendingFillWaiters.add(reject);
          queue.push(() => { pendingFillWaiters.delete(reject); resolve(); });
        });
        // An echo of our own operations must not interrupt a pointer still drawing.
        if (!reset && operations.every(operation => seen.has(operation.opId))) return;
        if (active) finish();
        if (!alive) throw new Error("Canvas was disposed");
        replaying = true;
        status();
        try {
          if (reset) {
            if (replayStroke && artist) { const p = external(replayStroke.last); artist.endStroke(p.x, p.y); }
            context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
            hasInk = false; history = new BitmapHistory(); seen.clear(); replayStroke = undefined;
          }
          for (const op of operations) {
            if (seen.has(op.opId)) continue;
            if (!artist) throw new Error("Canvas is unavailable");
            if (op.type === "stroke.start") {
              if (replayStroke) throw new Error("Overlapping strokes in drawing journal");
              const ext = external(op.point);
              artist.mode = op.settings.tool === "eraser" ? "erase" : "draw";
              artist.color = op.settings.color;
              artist.weight = op.settings.size;
              artist.adaptiveStroke = false; artist.pressureLow = 1; artist.pressureHigh = 1;
              const before = snapshot();
              artist.beginStroke(ext.x, ext.y);
              const next = artist.draw(ext.x + 0.1, ext.y, ext.x, ext.y, op.point.pressure);
              replayStroke = { actionId: op.actionId, before, last: op.point, previousX: next.x, previousY: next.y };
            } else if (op.type === "stroke.append") {
              if (!replayStroke || replayStroke.actionId !== op.actionId) throw new Error("Stroke append without matching start");
              for (const p of op.points) {
                const ext = external(p);
                const next = artist.draw(ext.x, ext.y, replayStroke.previousX, replayStroke.previousY, p.pressure);
                replayStroke.previousX = next.x; replayStroke.previousY = next.y; replayStroke.last = p;
              }
            } else if (op.type === "stroke.end") {
              if (!replayStroke || replayStroke.actionId !== op.actionId) throw new Error("Stroke end without matching start");
              const ext = external(op.point);
              artist.endStroke(ext.x, ext.y); history.push(op.actionId, replayStroke.before);
              replayStroke = undefined; hasInk = detectInk();
            } else {
              if (replayStroke) throw new Error("Drawing command during an unfinished stroke");
              if (op.type === "fill") await new Promise<void>((resolve, reject) => fill(op.point, op.color, op, error => error ? reject(error) : resolve()));
              else if (op.type === "canvas.clear") {
                const before = snapshot(); context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT); hasInk = false; history.push(op.actionId, before);
              } else {
                const entry = op.type === "history.undo" ? history.undo(snapshot()) : history.redo(snapshot());
                if (!entry || entry.actionId !== op.targetActionId) throw new Error("History target does not match drawing journal");
                restore(entry.snapshot);
              }
            }
            seen.add(op.opId);
          }
        } finally { replaying = false; status(); }
      };
      const scheduleReplay = (operations: CanvasOperation[], reset: boolean) => {
        replayPending++; status();
        const result = replayQueue.then(() => replay(operations, reset)).finally(() => { replayPending--; status(); });
        replayQueue = result.catch(() => {});
        return result;
      };
      const engine: Engine = {
        finish,
        hydrate: operations => scheduleReplay(operations, true),
        applyOperations: operations => scheduleReplay(operations, false),
        undo: () =>
          command(() => {
            const entry = history.undo(snapshot());
            if (!entry) return;
            restore(entry.snapshot);
            const actionId = uid();
            emit({
              ...base(actionId),
              type: "history.undo",
              targetActionId: entry.actionId,
            });
            status();
          }),
        redo: () =>
          command(() => {
            const entry = history.redo(snapshot());
            if (!entry) return;
            restore(entry.snapshot);
            const actionId = uid();
            emit({
              ...base(actionId),
              type: "history.redo",
              targetActionId: entry.actionId,
            });
            status();
          }),
        clear: () =>
          command(() => {
            const before = snapshot();
            context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
            hasInk = false;
            const actionId = uid();
            history.push(actionId, before);
            emit({ ...base(actionId), type: "canvas.clear" });
            status();
          }),
      };
      engineRef.current = engine;
      canvas.addEventListener("pointerdown", down, true);
      canvas.addEventListener("pointermove", move, true);
      canvas.addEventListener("pointerup", up, true);
      canvas.addEventListener("pointercancel", cancel, true);
      canvas.addEventListener("lostpointercapture", cancel, true);
      document.addEventListener("visibilitychange", hidden);
      try {
        worker = new Worker(new URL("./fill.worker.ts", import.meta.url));
      } catch {
        propsRef.current.onError?.("Fill worker is unavailable.");
      }
      import("atrament")
        .then(({ default: Constructor }) => {
          if (!alive) return;
          const logicalCanvas = new Proxy(canvas, {
            get(target, key) {
              if (key === "offsetWidth") return CANVAS_WIDTH;
              if (key === "offsetHeight") return CANVAS_HEIGHT;
              const value: unknown = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
            set(target, key, value) { return Reflect.set(target, key, value, target); },
          });
          artist = new Constructor(logicalCanvas, {
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
          });
          readyResolve();
          status();
        })
        .catch(() => {
          readyReject(new Error("Could not initialize drawing canvas."));
          propsRef.current.onError?.("Could not initialize drawing canvas.");
        });
      status();
      return () => {
        finish();
        alive = false;
        cancelFill?.();
        for (const reject of pendingFillWaiters) reject(new Error("Canvas was disposed"));
        pendingFillWaiters.clear();
        readyReject(new Error("Canvas was disposed"));
        engineRef.current = null;
        queue = [];
        worker?.terminate();
        canvas.removeEventListener("pointerdown", down, true);
        canvas.removeEventListener("pointermove", move, true);
        canvas.removeEventListener("pointerup", up, true);
        canvas.removeEventListener("pointercancel", cancel, true);
        canvas.removeEventListener("lostpointercapture", cancel, true);
        document.removeEventListener("visibilitychange", hidden);
        artist?.destroy();
      };
    }, []);
    useEffect(() => {
      engineRef.current?.finish();
    }, [props.settings.tool, props.settings.color, props.settings.size, props.readOnly]);
    return (
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className={[styles.surface, props.className].filter(Boolean).join(" ")}
        aria-label="Drawing canvas"
        aria-busy="true"
        data-ready="false"
        data-readonly={String(!!props.readOnly)}
        data-testid="drawing-canvas"
      />
    );
  },
);
export default DrawingCanvas;
