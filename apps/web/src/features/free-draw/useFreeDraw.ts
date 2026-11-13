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

type Role = "guesser" | "referee";
const MIN_INTERVAL = 500;
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
  const [loading, setLoading] = useState(true);
  const [labels, setLabels] = useState<string[]>([]);
  const sessionRef = useRef<FreeDrawSession | undefined>(undefined);
  const runRef = useRef(createUuid());
  const revisionRef = useRef(0);
  const requests = useRef<Partial<Record<Role, AbortController>>>({});
  const lastDispatch = useRef<Partial<Record<Role, number>>>({});
  const activeStroke = useRef(false);
  const mounted = useRef(false);
  const capturedFrame = useRef<
    { key: string; promise: Promise<Blob> } | undefined
  >(undefined);
  const cancelRequests = useCallback((role?: Role) => {
    if (role) requests.current[role]?.abort();
    else
      Object.values(requests.current).forEach((controller) =>
        controller?.abort(),
      );
  }, []);
  const retryAt = useRef<Record<string, number>>({});
  const successRevision = useRef<
    Partial<Record<"guesser" | "referee", number>>
  >({});
  const guessLoggedRevision = useRef<number | undefined>(undefined);
  const retryDelay = useRef<Record<string, number>>({
    guesser: 1000,
    referee: 1000,
  });
  const epoch = useRef({ guesser: 0, referee: 0, heatmap: 0 });
  const warningTimer = useRef<number | undefined>(undefined);
  const canvasStatusRef = useRef(emptyStatus);

  const invalidate = useCallback(
    (resetSuccess = true) => {
      epoch.current = {
        guesser: epoch.current.guesser + 1,
        referee: epoch.current.referee + 1,
        heatmap: epoch.current.heatmap + 1,
      };
      if (resetSuccess) {
        successRevision.current = {};
        guessLoggedRevision.current = undefined;
        retryAt.current = {};
        retryDelay.current = { guesser: 1000, referee: 1000 };
        capturedFrame.current = undefined;
      }
      if (warningTimer.current !== undefined)
        window.clearTimeout(warningTimer.current);
      warningTimer.current = undefined;
      setWarning(undefined);
      cancelRequests();
    },
    [cancelRequests],
  );
  useEffect(() => {
    let live = true;
    mounted.current = true;
    const root = apiRoot();
    let disposed = false;
    const disposeSession = () => {
      if (disposed) return;
      disposed = true;
      cancelRequests();
      const session = sessionRef.current;
      if (session)
        void fetch(`${root}/api/free-draw/sessions/current`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.token}` },
          keepalive: true,
        }).catch(() => {});
      sessionRef.current = undefined;
    };
    const removeLegacyDb = () => {
      if (!globalThis.indexedDB) return;
      try {
        indexedDB.deleteDatabase("mmtai-free-draw");
      } catch {
        /* best-effort legacy cleanup */
      }
    };
    removeLegacyDb();
    const onPageHide = () => disposeSession();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
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
    void poll();
    return () => {
      live = false;
      mounted.current = false;
      window.clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", visible);
      pollController?.abort();
      cancelRequests();
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      disposeSession();
    };
  }, [cancelRequests]);

  const onOperation = useCallback((operation: CanvasOperation) => {
    revisionRef.current++;
    if (operation.type === "stroke.start") activeStroke.current = true;
    if (operation.type === "stroke.end" || operation.type === "canvas.clear")
      activeStroke.current = false;
  }, []);
  const onStatusChange = useCallback((status: CanvasStatus) => {
    canvasStatusRef.current = status;
    setCanvasStatus(status);
    if (!status.busy) setLoading(false);
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
        cancelRequests("referee");
        if (toggles.referee) {
          if (warningTimer.current !== undefined)
            window.clearTimeout(warningTimer.current);
          warningTimer.current = undefined;
          setWarning(undefined);
        }
      } else {
        epoch.current.guesser++;
        epoch.current.heatmap++;
        cancelRequests("guesser");
        successRevision.current.guesser = undefined;
      }
      setToggles((prev) => ({ ...prev, [feature]: !prev[feature] }));
    },
    [toggles.referee, cancelRequests],
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
    const capture = (key: string) => {
      if (capturedFrame.current?.key === key)
        return capturedFrame.current.promise;
      const promise = canvasRef.current!.capturePNG();
      capturedFrame.current = { key, promise };
      return promise;
    };
    const clearWarning = () => {
      if (warningTimer.current !== undefined)
        window.clearTimeout(warningTimer.current);
      warningTimer.current = undefined;
      setWarning(undefined);
    };
    const fail = (role: Role, busy: boolean) => {
      const delay = busy
        ? Math.min(2000, Math.max(250, (retryDelay.current[role] ?? 1000) / 4))
        : (retryDelay.current[role] ?? 1000);
      retryAt.current[role] = Date.now() + delay;
      retryDelay.current[role] = Math.min(
        busy ? 8000 : 10000,
        Math.max(1000, delay * 2),
      );
      setAvailability((previous) => ({
        ...previous,
        [role]: busy ? "waiting" : "unavailable",
      }));
      if (role === "referee") clearWarning();
    };
    const infer = async (role: Role, session: FreeDrawSession) => {
      const controller = new AbortController();
      requests.current[role] = controller;
      const roleEpoch = epoch.current[role];
      const observation: FreeDrawObservation = {
        runId: runRef.current,
        revision: revisionRef.current,
        requestId: createUuid(),
        roles: [role],
      };
      const current = () =>
        mounted.current &&
        !controller.signal.aborted &&
        epoch.current[role] === roleEpoch &&
        runRef.current === observation.runId &&
        sessionRef.current === session;
      setAvailability((previous) => ({ ...previous, [role]: "working" }));
      try {
        const blob = await capture(
          `${observation.runId}:${observation.revision}`,
        );
        if (!current() || document.hidden) return;
        lastDispatch.current[role] = Date.now();
        const response = await boundedFetch(
          `${apiRoot()}/api/free-draw/infer`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.token}`,
              "Content-Type": "image/png",
              "x-free-draw-observation": JSON.stringify(observation),
            },
            body: blob,
          },
          controller.signal,
        );
        if (!current()) return;
        if (response.status === 401 || response.status === 404) {
          sessionRef.current = undefined;
          throw new Error("session-expired");
        }
        if (response.status === 429) {
          fail(role, true);
          return;
        }
        if (!response.ok) throw new Error("provider-unavailable");
        const result = (await response.json()) as FreeDrawResult;
        if (!current()) return;
        if (
          result.sessionId !== session.sessionId ||
          result.runId !== observation.runId ||
          result.revision !== observation.revision ||
          result.requestId !== observation.requestId ||
          result.roles.length !== 1 ||
          result.roles[0] !== role
        )
          throw new Error("invalid-result-binding");
        const outcome = result.outcomes[role];
        if (!outcome || outcome.status === "unavailable") {
          fail(role, false);
          return;
        }
        successRevision.current[role] = observation.revision;
        retryAt.current[role] = 0;
        retryDelay.current[role] = 1000;
        setError("");
        setAvailability((previous) => ({ ...previous, [role]: "ready" }));
        if (role === "guesser") {
          if (outcome.status === "answer") {
            if (toggles.heatmap) {
              setHeatmap(outcome.heatmap);
              setHeatmapGuess(
                outcome.heatmap
                  ? { answer: outcome.answer, confidence: outcome.confidence }
                  : undefined,
              );
              setHeatmapKey(observation.runId);
            }
            if (
              toggles.guesser &&
              (mode === "free" || Boolean(prompt)) &&
              !solved &&
              guessLoggedRevision.current !== observation.revision
            ) {
              const prediction = predictionFromAnswer({
                id: observation.requestId,
                answer: outcome.answer,
                confidence: outcome.confidence,
                mode,
                prompt,
              });
              guessLoggedRevision.current = observation.revision;
              setHistory((previous) => [...previous, prediction]);
              if (prediction.correct) setSolved(true);
            }
          } else if (outcome.status === "pass") {
            setHeatmap(undefined);
            setHeatmapGuess(undefined);
          }
        } else if (outcome.status === "evidence" && outcome.scores[0] >= 0.3) {
          clearWarning();
          setWarning({ confidence: outcome.scores[0] });
          warningTimer.current = window.setTimeout(() => {
            warningTimer.current = undefined;
            setWarning(undefined);
          }, 3000);
        } else clearWarning();
      } catch (error) {
        if (
          current() &&
          !(error instanceof DOMException && error.name === "AbortError")
        )
          fail(role, false);
      } finally {
        if (requests.current[role] === controller)
          delete requests.current[role];
      }
    };
    const tick = () => {
      if (
        !mounted.current ||
        !shouldAnalyze({
          loading,
          hidden: document.hidden,
          busy: canvasStatusRef.current.busy,
          hasInk: canvasStatusRef.current.hasInk || activeStroke.current,
          inFlight: false,
        })
      )
        return;
      const session = sessionRef.current;
      if (!session || !canvasRef.current) return;
      const now = Date.now();
      const roles = planRoles({
        toggles,
        mode,
        prompt,
        solved,
        capabilities: session.capabilities,
        successfulRevision: successRevision.current,
        revision: revisionRef.current,
        retryAt: retryAt.current,
        now,
      });
      for (const role of roles) {
        const cadence =
          role === "guesser"
            ? Math.max(500, session.capabilities.minIntervalMs)
            : Math.max(1000, session.capabilities.refereeMinIntervalMs ?? 1000);
        if (
          !requests.current[role] &&
          now >= (lastDispatch.current[role] ?? 0) + cadence
        )
          void infer(role, session);
      }
    };
    // A short tick coalesces pointer samples without rerendering React for each point.
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [loading, toggles, mode, prompt, solved, capabilities]);

  useEffect(() => {
    const hidden = () => {
      if (document.hidden) cancelRequests();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [cancelRequests]);
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
    saveError: "",
    loading,
    clearHistory,
    restartGuesser,
    clearCanvas,
    randomPrompt,
  };
}
