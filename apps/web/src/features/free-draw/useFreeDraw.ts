"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_DRAWING_SETTINGS,
  type CanvasOperation,
  type CanvasStatus,
  type DrawingCanvasHandle,
  type DrawingSettings,
} from "@/contracts/drawing";
import type {
  FreeDrawCapabilities,
  FreeDrawObservation,
  FreeDrawResult,
  FreeDrawSession,
} from "../../../../../packages/game-contracts/src/free-draw";
import type { GuessHeatmapV1 } from "../../../../../packages/game-contracts/src/ai-inference";
import { createUuid } from "@/lib/uuid";
import { loadFreeDraw, nextFreeDrawSaveVersion, saveFreeDraw } from "./storage";
import {
  normalizeFreeDrawLabel,
  planRoles,
  predictionFromAnswer,
  shouldAnalyze,
} from "./state";
import type {
  FeatureStatus,
  FreeDrawController,
  FreeDrawFeature,
  FreeDrawMode,
  FreeDrawPrediction,
} from "./types";

const MIN_INTERVAL = 3000;
const emptyStatus: CanvasStatus = {
  canUndo: false,
  canRedo: false,
  busy: true,
  hasInk: false,
};
const initialCaps: FreeDrawCapabilities = {
  guesser: { available: false, labels: [] },
  referee: { available: false },
  minIntervalMs: MIN_INTERVAL,
};
function apiRoot(): string {
  return (process.env.NEXT_PUBLIC_ROOM_API_URL ?? "").replace(/\/$/, "");
}
async function boundedFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  outerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener("abort", abort, { once: true });
  if (outerSignal?.aborted) abort();
  const timer = window.setTimeout(
    () =>
      controller.abort(
        new DOMException("AI request timed out", "TimeoutError"),
      ),
    15000,
  );
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abort);
  }
}

export function useFreeDraw(): FreeDrawController {
  const canvasRef = useRef<DrawingCanvasHandle>(null);
  const [settings, setSettingsState] = useState<DrawingSettings>(
    DEFAULT_DRAWING_SETTINGS,
  );
  const [canvasStatus, setCanvasStatus] = useState<CanvasStatus>(emptyStatus);
  const [mode, setModeState] = useState<FreeDrawMode>("free");
  const [prompt, setPromptState] = useState("");
  const [toggles, setToggles] = useState({
    guesser: true,
    referee: true,
    heatmap: false,
  });
  const [history, setHistory] = useState<FreeDrawPrediction[]>([]);
  const [solved, setSolved] = useState(false);
  const [heatmap, setHeatmap] = useState<GuessHeatmapV1 | undefined>(undefined);
  const [heatmapGuess, setHeatmapGuess] = useState<
    { answer: string; confidence: number } | undefined
  >(undefined);
  const [heatmapKey, setHeatmapKey] = useState("");
  const [warning, setWarning] = useState<{ confidence: number } | undefined>(
    undefined,
  );
  const [availability, setAvailability] = useState<
    Record<FreeDrawFeature, FeatureStatus>
  >({ guesser: "waiting", referee: "waiting", heatmap: "off" });
  const [capabilities, setCapabilities] =
    useState<FreeDrawCapabilities>(initialCaps);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [loading, setLoading] = useState(true);
  const [labels, setLabels] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [saveTick, setSaveTick] = useState(0);
  const sessionRef = useRef<FreeDrawSession | undefined>(undefined);
  const runRef = useRef(createUuid());
  const revisionRef = useRef(0);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const inFlight = useRef(false);
  const lastDispatch = useRef(0);
  const retryAt = useRef<Record<string, number>>({});
  const successRevision = useRef<
    Partial<Record<"guesser" | "referee", number>>
  >({});
  const guessLoggedRevision = useRef<number | undefined>(undefined);
  const retryDelay = useRef<Record<string, number>>({
    guesser: 3000,
    referee: 3000,
  });
  const epoch = useRef({ guesser: 0, referee: 0, heatmap: 0 });
  const warningTimer = useRef<number | undefined>(undefined);
  const saveVersion = useRef(0);
  const canvasStatusRef = useRef(emptyStatus);

  const invalidate = useCallback((resetSuccess = true) => {
    epoch.current = {
      guesser: epoch.current.guesser + 1,
      referee: epoch.current.referee + 1,
      heatmap: epoch.current.heatmap + 1,
    };
    if (resetSuccess) {
      successRevision.current = {};
      guessLoggedRevision.current = undefined;
    }
    if (warningTimer.current !== undefined)
      window.clearTimeout(warningTimer.current);
    warningTimer.current = undefined;
    setWarning(undefined);
    requestRef.current?.abort();
  }, []);
  useEffect(() => {
    let live = true;
    const root = apiRoot();
    const fetchCaps = async (signal?: AbortSignal): Promise<boolean> => {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          let session = sessionRef.current;
          if (!session) {
            const response = await boundedFetch(
              `${root}/api/free-draw/sessions`,
              { method: "POST" },
              signal,
            );
            if (!response.ok)
              throw new Error(
                "AI is unavailable. You can keep drawing while we reconnect.",
              );
            session = (await response.json()) as FreeDrawSession;
            if (live) sessionRef.current = session;
          }
          const response = await boundedFetch(
            `${root}/api/free-draw/capabilities`,
            { headers: { Authorization: `Bearer ${session.token}` } },
            signal,
          );
          if (response.status === 401 || response.status === 404) {
            sessionRef.current = undefined;
            continue;
          }
          if (!response.ok)
            throw new Error(
              "AI is unavailable. You can keep drawing while we reconnect.",
            );
          const caps = (await response.json()) as FreeDrawCapabilities;
          if (live) {
            session.capabilities = caps;
            setCapabilities(caps);
            setLabels(caps.guesser.labels);
          }
          return true;
        }
        throw new Error(
          "AI is unavailable. You can keep drawing while we reconnect.",
        );
      } catch (e) {
        if (live && !(e instanceof DOMException && e.name === "AbortError"))
          setError(
            "AI is unavailable. You can keep drawing while we reconnect.",
          );
        return false;
      }
    };
    let pollController: AbortController | undefined;
    let pollTimer = 0;
    let pollDelay = 3000;
    let pollBusy = false;
    const poll = async () => {
      if (!live || document.hidden || pollBusy) return;
      pollBusy = true;
      pollController = new AbortController();
      const healthy = await fetchCaps(pollController.signal);
      pollBusy = false;
      pollController = undefined;
      if (!live) return;
      if (!healthy)
        setAvailability((v) => ({
          ...v,
          guesser: "unavailable",
          referee: "unavailable",
          heatmap: "unavailable",
        }));
      else
        setAvailability((v) => ({
          ...v,
          guesser: v.guesser === "unavailable" ? "waiting" : v.guesser,
          referee: v.referee === "unavailable" ? "waiting" : v.referee,
          heatmap: v.heatmap === "unavailable" ? "waiting" : v.heatmap,
        }));
      pollDelay = healthy ? 3000 : Math.min(30000, pollDelay * 2);
      pollTimer = window.setTimeout(() => void poll(), pollDelay);
    };
    const visible = () => {
      if (document.hidden) {
        pollController?.abort();
        return;
      }
      window.clearTimeout(pollTimer);
      void poll();
    };
    document.addEventListener("visibilitychange", visible);
    void (async () => {
      try {
        const saved = await loadFreeDraw();
        if (!live) return;
        if (saved) {
          setSettingsState(saved.metadata.settings);
          setModeState(saved.metadata.mode);
          setPromptState(saved.metadata.prompt);
          setToggles({ ...saved.metadata.toggles, guesser: false });
          await new Promise<void>((resolve) => {
            const id = window.setInterval(() => {
              if (canvasRef.current && !canvasStatusRef.current.busy) {
                window.clearInterval(id);
                resolve();
              }
            }, 50);
            window.setTimeout(() => {
              window.clearInterval(id);
              resolve();
            }, 5000);
          });
          await canvasRef.current?.restoreBitmap(saved.bitmap);
        }
      } catch (e) {
        if (live)
          setSaveError(
            e instanceof Error ? e.message : "Could not restore saved drawing.",
          );
      } finally {
        if (live) setLoading(false);
      }
      void poll();
    })();
    return () => {
      live = false;
      window.clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", visible);
      pollController?.abort();
      requestRef.current?.abort();
      const session = sessionRef.current;
      if (session)
        void boundedFetch(`${root}/api/free-draw/sessions/current`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.token}` },
        }).catch(() => {});
    };
  }, []);

  const persist = useCallback(() => {
    if (loading) return;
    const run = async () => {
      const version = nextFreeDrawSaveVersion();
      saveVersion.current = version;
      try {
        const bitmap = await canvasRef.current?.capturePNG();
        if (!bitmap) return;
        await saveFreeDraw(
          { bitmap, metadata: { settings, mode, prompt, toggles } },
          version,
        );
        if (version === saveVersion.current) setSaveError("");
      } catch (e) {
        if (version === saveVersion.current)
          setSaveError(
            e instanceof Error ? e.message : "Could not save drawing.",
          );
      }
    };
    const id = window.setTimeout(() => void run(), 350);
    return () => window.clearTimeout(id);
  }, [loading, settings, mode, prompt, toggles]);
  useEffect(() => {
    const cancel = persist();
    return cancel;
  }, [persist, canvasStatus.hasInk, saveTick]);
  const onOperation = useCallback((operation: CanvasOperation) => {
    revisionRef.current++;
    successRevision.current = {};
    setRevision((value) => value + 1);
    if (
      operation.type === "stroke.end" ||
      operation.type === "fill" ||
      operation.type === "canvas.clear" ||
      operation.type === "history.undo" ||
      operation.type === "history.redo"
    )
      setSaveTick((v) => v + 1);
  }, []);
  const onStatusChange = useCallback((status: CanvasStatus) => {
    canvasStatusRef.current = status;
    setCanvasStatus(status);
  }, []);
  const setSettings = useCallback((value: DrawingSettings) => {
    setSettingsState(value);
  }, []);
  const setMode = useCallback(
    (value: FreeDrawMode) => {
      if (value === mode) return;
      invalidate();
      setModeState(value);
      setHistory([]);
      setSolved(false);
      setHeatmap(undefined);
      setWarning(undefined);
      runRef.current = createUuid();
    },
    [mode, invalidate],
  );
  const setPrompt = useCallback(
    (value: string) => {
      if (
        !labels.some(
          (label) =>
            normalizeFreeDrawLabel(label) === normalizeFreeDrawLabel(value),
        )
      ) {
        setError("Choose a prompt from the supported labels.");
        return;
      }
      invalidate();
      setPromptState(value);
      setModeState("prompt");
      setHistory([]);
      setSolved(false);
      setHeatmap(undefined);
      setWarning(undefined);
      runRef.current = createUuid();
    },
    [labels, invalidate],
  );
  const toggle = useCallback(
    (feature: FreeDrawFeature) => {
      if (feature === "referee") {
        epoch.current.referee++;
        delete successRevision.current.referee;
        requestRef.current?.abort();
        if (toggles.referee) {
          if (warningTimer.current !== undefined)
            window.clearTimeout(warningTimer.current);
          warningTimer.current = undefined;
          setWarning(undefined);
        }
      } else {
        epoch.current.guesser++;
        epoch.current.heatmap++;
        requestRef.current?.abort();
        successRevision.current.guesser = undefined;
      }
      setToggles((prev) => ({ ...prev, [feature]: !prev[feature] }));
    },
    [toggles.referee],
  );
  const clearHistory = useCallback(() => setHistory([]), []);
  const restartGuesser = useCallback(() => {
    invalidate();
    setHistory([]);
    setSolved(false);
    setToggles((v) => ({ ...v, guesser: true }));
    runRef.current = createUuid();
  }, [invalidate]);
  const clearCanvas = useCallback(() => {
    invalidate();
    canvasRef.current?.clear();
    setHistory([]);
    setSolved(false);
    setHeatmap(undefined);
    setHeatmapGuess(undefined);
    setWarning(undefined);
    runRef.current = createUuid();
  }, [invalidate]);
  const randomPrompt = useCallback(() => {
    const options = labels.filter(
      (label) =>
        normalizeFreeDrawLabel(label) !== normalizeFreeDrawLabel(prompt),
    );
    if (!options.length) return;
    setPrompt(options[Math.floor(Math.random() * options.length)]);
  }, [labels, prompt, setPrompt]);

  useEffect(() => {
    if (
      !shouldAnalyze({
        loading,
        hidden: document.hidden,
        busy: canvasStatus.busy,
        hasInk: canvasStatus.hasInk,
        inFlight: inFlight.current,
      })
    )
      return;
    const activeRoles =
      (toggles.guesser &&
        (mode === "free" || Boolean(prompt)) &&
        !(mode === "prompt" && solved)) ||
      toggles.referee ||
      toggles.heatmap;
    if (!activeRoles) return;
    const now = Date.now();
    const caps = sessionRef.current?.capabilities ?? initialCaps;
    const retryWait: number[] = [];
    if (
      ((toggles.guesser && !(mode === "prompt" && solved)) ||
        toggles.heatmap) &&
      caps.guesser.available &&
      successRevision.current.guesser !== revisionRef.current
    )
      retryWait.push(Math.max(0, (retryAt.current.guesser ?? 0) - now));
    if (
      toggles.referee &&
      caps.referee.available &&
      successRevision.current.referee !== revisionRef.current
    )
      retryWait.push(Math.max(0, (retryAt.current.referee ?? 0) - now));
    const wait = Math.max(
      0,
      Math.max(MIN_INTERVAL, caps.minIntervalMs) - (now - lastDispatch.current),
      retryWait.length ? Math.min(...retryWait) : 0,
    );
    const timer = window.setTimeout(async () => {
      if (document.hidden || inFlight.current) return;
      const caps = sessionRef.current?.capabilities ?? initialCaps;
      const roles = planRoles({
        toggles,
        mode,
        prompt,
        solved,
        capabilities: caps,
        successfulRevision: successRevision.current,
        revision: revisionRef.current,
        retryAt: retryAt.current,
        now: Date.now(),
      });
      if (!roles.length) return;
      const canvas = canvasRef.current;
      const session = sessionRef.current;
      if (!canvas || !session) return;
      inFlight.current = true;
      lastDispatch.current = Date.now();
      const obs: FreeDrawObservation = {
        runId: runRef.current,
        revision: revisionRef.current,
        requestId: createUuid(),
        roles,
      };
      const epochs = { ...epoch.current };
      const abort = new AbortController();
      requestRef.current = abort;
      for (const role of roles)
        setAvailability((v) => ({ ...v, [role]: "working" }));
      try {
        const blob = await canvas.capturePNG();
        if (abort.signal.aborted || document.hidden) return;
        if (blob.size > 4 * 1024 * 1024)
          throw new Error("Drawing exceeds the 4 MiB inference limit.");
        const response = await boundedFetch(
          `${apiRoot()}/api/free-draw/infer`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.token}`,
              "Content-Type": "image/png",
              "x-free-draw-observation": JSON.stringify(obs),
            },
            body: blob,
          },
          abort.signal,
        );
        if (response.status === 401 || response.status === 404) {
          sessionRef.current = undefined;
          throw new Error(
            "AI is unavailable. You can keep drawing while we reconnect.",
          );
        }
        if (response.status === 429)
          throw new Error("AI is busy. Retrying shortly.");
        if (!response.ok)
          throw new Error(
            "AI is unavailable. You can keep drawing while we reconnect.",
          );
        const result = (await response.json()) as FreeDrawResult;
        if (
          result.sessionId !== session.sessionId ||
          result.runId !== obs.runId ||
          result.revision !== obs.revision ||
          result.requestId !== obs.requestId
        )
          return;
        for (const role of roles) {
          if (epochs[role] !== epoch.current[role]) continue;
          const outcome = result.outcomes[role];
          if (!outcome || outcome.status === "unavailable") {
            const delay = retryDelay.current[role];
            retryAt.current[role] = Date.now() + delay;
            retryDelay.current[role] = Math.min(30000, delay * 2);
            setAvailability((v) => ({ ...v, [role]: "unavailable" }));
            if (role === "referee") {
              if (warningTimer.current !== undefined)
                window.clearTimeout(warningTimer.current);
              warningTimer.current = undefined;
              setWarning(undefined);
            }
            continue;
          }
          retryDelay.current[role] = 3000;
          retryAt.current[role] = 0;
          setError("");
          setAvailability((v) => ({
            ...v,
            [role]:
              role === "guesser" && !toggles.guesser && !toggles.heatmap
                ? "off"
                : "ready",
          }));
          successRevision.current[role] = obs.revision;
          if (role === "guesser") {
            if (outcome.status === "answer") {
              if (toggles.heatmap) {
                setHeatmap(outcome.heatmap);
                setHeatmapGuess(
                  outcome.heatmap
                    ? { answer: outcome.answer, confidence: outcome.confidence }
                    : undefined,
                );
                setHeatmapKey(runRef.current);
              }
              if (
                toggles.guesser &&
                (mode === "free" || Boolean(prompt)) &&
                !(mode === "prompt" && solved) &&
                guessLoggedRevision.current !== obs.revision
              ) {
                const item = predictionFromAnswer({
                  id: obs.requestId,
                  answer: outcome.answer,
                  confidence: outcome.confidence,
                  mode,
                  prompt,
                });
                guessLoggedRevision.current = obs.revision;
                setHistory((old) => [...old, item]);
                if (item.correct) setSolved(true);
              }
            } else if (outcome.status === "pass") {
              /* pass has no history entry */
            }
          } else if (
            outcome.status === "evidence" &&
            outcome.scores[0] >= 0.3
          ) {
            if (warningTimer.current !== undefined)
              window.clearTimeout(warningTimer.current);
            setWarning({ confidence: outcome.scores[0] });
            warningTimer.current = window.setTimeout(() => {
              warningTimer.current = undefined;
              setWarning(undefined);
            }, 3000);
          }
          if (
            role === "referee" &&
            (outcome.status !== "evidence" || outcome.scores[0] < 0.3)
          ) {
            if (warningTimer.current !== undefined)
              window.clearTimeout(warningTimer.current);
            warningTimer.current = undefined;
            setWarning(undefined);
          }
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError(
            e instanceof Error && e.message === "AI is busy. Retrying shortly."
              ? e.message
              : "AI is unavailable. You can keep drawing while we reconnect.",
          );
          for (const role of roles) {
            const delay = retryDelay.current[role];
            retryAt.current[role] = Date.now() + delay;
            retryDelay.current[role] = Math.min(30000, delay * 2);
            setAvailability((v) => ({ ...v, [role]: "unavailable" }));
          }
          if (roles.includes("referee")) {
            if (warningTimer.current !== undefined)
              window.clearTimeout(warningTimer.current);
            warningTimer.current = undefined;
            setWarning(undefined);
          }
        }
      } finally {
        inFlight.current = false;
        requestRef.current = undefined;
        setRevision((v) => v + 1);
      }
    }, wait);
    return () => window.clearTimeout(timer);
  }, [
    loading,
    revision,
    canvasStatus.busy,
    canvasStatus.hasInk,
    toggles,
    mode,
    solved,
    prompt,
    availability,
  ]);

  useEffect(() => {
    const hidden = () => {
      if (document.hidden) requestRef.current?.abort();
      else setRevision((v) => v + 1);
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  const shownAvailability: Record<FreeDrawFeature, FeatureStatus> = {
    guesser: !toggles.guesser
      ? "off"
      : mode === "prompt" && solved
        ? "solved"
        : !capabilities.guesser.available
          ? "unavailable"
          : availability.guesser === "off"
            ? "waiting"
            : availability.guesser,
    referee: !toggles.referee
      ? "off"
      : !capabilities.referee.available
        ? "unavailable"
        : availability.referee === "off"
          ? "waiting"
          : availability.referee,
    heatmap: !toggles.heatmap
      ? "off"
      : !capabilities.guesser.available
        ? "unavailable"
        : availability.guesser === "working"
          ? "working"
          : availability.guesser === "unavailable"
            ? "unavailable"
            : heatmap
              ? "ready"
              : "waiting",
  };
  return {
    canvasRef,
    settings,
    setSettings,
    canvasStatus,
    onStatusChange,
    onOperation,
    mode,
    setMode,
    prompt,
    setPrompt,
    labels,
    toggles,
    toggle,
    history,
    solved,
    heatmap,
    heatmapGuess,
    heatmapKey,
    warning,
    availability: shownAvailability,
    error,
    saveError,
    loading,
    clearHistory,
    restartGuesser,
    clearCanvas,
    randomPrompt,
  };
}
