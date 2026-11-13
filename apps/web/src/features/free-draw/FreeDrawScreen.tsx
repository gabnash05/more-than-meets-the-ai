"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import DrawingCanvas from "@/features/canvas/DrawingCanvas";
import { DrawingToolbar } from "@/features/canvas/DrawingToolbar";
import { HeatmapOverlay } from "@/features/canvas/HeatmapOverlay";
import { RefereeWarningBadge } from "@/features/canvas/RefereeWarningBadge";
import { useFreeDraw } from "./useFreeDraw";
import type {
  FeatureStatus,
  FreeDrawController,
  FreeDrawFeature,
} from "./types";
import "./free-draw.css";

const rowHeight = 72;
const overscan = 3;
type FreeDrawView = Omit<FreeDrawController, "canvasRef">;

function PromptPicker({ controller }: { controller: FreeDrawView }) {
  const [query, setQuery] = useState(controller.prompt);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const options = useMemo(
    () =>
      controller.labels.filter((label) =>
        label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    [controller.labels, query],
  );
  useEffect(() => {
    if (open)
      list.current
        ?.querySelector<HTMLElement>(`#fd-option-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  function choose(label: string) {
    controller.setPrompt(label);
    setQuery(label);
    setOpen(false);
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((value) => Math.min(options.length - 1, value + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((value) => Math.max(0, value - 1));
    } else if (event.key === "Enter" && open && options[active]) {
      event.preventDefault();
      choose(options[active]);
    } else if (event.key === "Escape") {
      setOpen(false);
      setQuery(controller.prompt);
    }
  }
  return (
    <div className="fd-prompt-picker" ref={root}>
      <label htmlFor="fd-prompt">Choose a prompt</label>
      <div className="fd-prompt-entry">
        <input
          id="fd-prompt"
          disabled={controller.loading}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="fd-prompt-options"
          aria-activedescendant={
            open && options[active] ? `fd-option-${active}` : undefined
          }
          value={open ? query : controller.prompt}
          placeholder="Search drawing prompts"
          onFocus={() => {
            setQuery(controller.prompt);
            setOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={keyDown}
        />
        <button
          type="button"
          aria-label="Choose a random prompt"
          disabled={controller.loading}
          onClick={() => {
            controller.randomPrompt();
            setOpen(false);
          }}
        >
          Random
        </button>
      </div>
      {open && (
        <ul
          ref={list}
          className="fd-prompt-options"
          id="fd-prompt-options"
          role="listbox"
          aria-label="Drawing prompts"
        >
          {options.length ? (
            options.map((label, index) => (
              <li
                key={label}
                id={`fd-option-${index}`}
                role="option"
                aria-selected={controller.prompt === label}
                className={index === active ? "is-active" : ""}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(label)}
              >
                {label}
                {controller.availability.guesser === "unavailable" && (
                  <span>AI unavailable</span>
                )}
              </li>
            ))
          ) : (
            <li className="fd-no-options">No matching prompts</li>
          )}
        </ul>
      )}
      <span className="fd-selected-prompt" aria-live="polite">
        {controller.prompt
          ? `Prompt: ${controller.prompt}`
          : "No prompt selected"}
      </span>
    </div>
  );
}

function History({ controller }: { controller: FreeDrawView }) {
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [visibleRows, setVisibleRows] = useState(8);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setVisibleRows(Math.max(1, Math.ceil(element.clientHeight / rowHeight))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const predictions = controller.history;
  const start = Math.min(
    Math.max(0, predictions.length - 1),
    Math.max(0, Math.floor(scrollTop / rowHeight) - overscan),
  );
  const end = Math.min(predictions.length, start + visibleRows + overscan * 2);
  useEffect(() => {
    if (pinned.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [predictions.length]);
  return (
    <section className="fd-panel fd-history" aria-labelledby="fd-history-title">
      <div className="fd-panel-heading">
        <div>
          <p className="fd-eyebrow">Every prediction</p>
          <h2 id="fd-history-title">Guess history</h2>
        </div>
        <button
          type="button"
          className="fd-text-button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Collapse history" : "Expand history"}
        </button>
        <button
          type="button"
          className="fd-text-button"
          onClick={() => {
            controller.clearHistory();
            pinned.current = true;
            setScrollTop(0);
            if (viewport.current) viewport.current.scrollTop = 0;
          }}
          disabled={!predictions.length}
        >
          Clear history
        </button>
      </div>
      <p className="fd-history-count" aria-live="polite">
        {predictions.length
          ? `Showing ${start + 1}–${end} of ${predictions.length} predictions`
          : "No predictions yet"}
      </p>
      <div className="fd-history-head" aria-hidden="true">
        <span>#</span>
        <span>Guess</span>
        <span>Conf.</span>
        <span>Status</span>
      </div>
      <div
        className="fd-history-viewport"
        ref={viewport}
        style={{ height: expanded ? "85vh" : "65vh" }}
        tabIndex={0}
        role="list"
        aria-label={`Prediction history, ${predictions.length} entries`}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            24;
          setScrollTop(element.scrollTop);
        }}
      >
        <div
          style={{
            height: predictions.length * rowHeight,
            position: "relative",
          }}
        >
          {predictions.slice(start, end).map((prediction, offset) => {
            const index = start + offset;
            const status = !prediction.submitted
              ? "Below threshold"
              : controller.mode === "prompt"
                ? prediction.correct
                  ? "Correct"
                  : "Incorrect"
                : "Submitted";
            return (
              <div
                role="listitem"
                aria-posinset={index + 1}
                aria-setsize={predictions.length}
                className="fd-history-row"
                key={prediction.id}
                style={{
                  position: "absolute",
                  top: index * rowHeight,
                  height: rowHeight,
                }}
              >
                <span className="fd-history-index">#{index + 1}</span>
                <span className="fd-history-answer" title={prediction.answer}>
                  {prediction.answer}
                </span>
                <span className="fd-history-confidence">
                  {Math.round(prediction.confidence * 100)}%
                </span>
                <span
                  className={`fd-history-status ${status === "Correct" ? "is-correct" : ""}`}
                >
                  {status}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

const statusLabels: Record<FeatureStatus, string> = {
  off: "Off",
  waiting: "Waiting",
  working: "Working",
  ready: "Ready",
  unavailable: "Unavailable",
  solved: "Guessed it",
};
function FeatureStatusLine({
  name,
  status,
}: {
  name: string;
  status: FeatureStatus;
}) {
  return (
    <span className="fd-feature-status" aria-live="polite">
      <span>{name}</span>
      <strong>{statusLabels[status]}</strong>
    </span>
  );
}

function Workspace() {
  const { canvasRef, ...controller } = useFreeDraw();
  const [canvasError, setCanvasError] = useState("");
  const drawingDisabled = controller.loading || controller.canvasStatus.busy;
  return (
    <main className="fd-screen">
      <header className="fd-header">
        <Link className="fd-back" href="/" aria-label="Back to home">
          ← <span>Home</span>
        </Link>
        <div className="fd-brand">
          <img src="/design/assets/more-than-meets-the-ai-icon.png" alt="" />
          <strong>
            More Than
            <br />
            Meets the AI
          </strong>
        </div>
        <span className="fd-header-mode">Free Draw</span>
      </header>
      <div className="fd-layout">
        <section className="fd-panel fd-mode-panel" aria-labelledby="fd-mode-title">
          <p className="fd-eyebrow">Start with a blank page or a target</p>
          <h2 id="fd-mode-title">Drawing mode</h2>
          <div className="fd-mode" role="group" aria-label="Drawing mode">
            <button type="button" disabled={controller.loading} aria-pressed={controller.mode === "free"} onClick={() => controller.setMode("free")}>No prompt</button>
            <button type="button" disabled={controller.loading} aria-pressed={controller.mode === "prompt"} onClick={() => controller.setMode("prompt")}>Choose a prompt</button>
          </div>
          {controller.mode === "prompt" && <PromptPicker controller={controller} />}
        </section>
        <section className="fd-workspace" aria-label="Drawing workspace">
          <div className="fd-workspace-heading">
            <div>
              <p className="fd-eyebrow">Free Draw</p>
              <h1>Make your mark.</h1>
            </div>
          </div>
          <div className="fd-board-wrap">
            <div className={`fd-board${controller.warning ? " room-board-warning" : ""}`} aria-label="Drawing surface">
              <DrawingCanvas
                ref={canvasRef}
                settings={controller.settings}
                onOperation={controller.onOperation}
                onStatusChange={controller.onStatusChange}
                onError={setCanvasError}
                readOnly={drawingDisabled}
              />
              {controller.toggles.heatmap && (
                <HeatmapOverlay
                  heatmap={controller.heatmap}
                  guess={controller.heatmapGuess}
                  drawing={controller.heatmapKey}
                  maxHistoryFrames={6}
                />
              )}
              {controller.warning && (
                <RefereeWarningBadge confidence={controller.warning.confidence} />
              )}
              {controller.solved && (
                <p className="fd-solved" role="status">
                  Guessed it! Your drawing is still open.
                </p>
              )}
              {controller.loading && (
                <p className="fd-canvas-loading" role="status">
                  Preparing your canvas…
                </p>
              )}
              {canvasError && (
                <p className="fd-canvas-error" role="alert">
                  {canvasError}
                </p>
              )}
            </div>
            <div
              className={`fd-heatmap-caption ${controller.toggles.heatmap && controller.heatmap ? "is-visible" : ""}`}
            >
              <span aria-hidden="true" className="fd-gradient" />
              Where the AI looked — attention, not its reasoning.
            </div>
          </div>
          <DrawingToolbar
            settings={controller.settings}
            onSettingsChange={controller.setSettings}
            status={controller.canvasStatus}
            disabled={controller.loading}
            onUndo={() => canvasRef.current?.undo()}
            onRedo={() => canvasRef.current?.redo()}
            onClear={controller.clearCanvas}
          />
        </section>
        <aside className="fd-sidebar">
          <section
            className="fd-panel fd-ai-panel"
            aria-labelledby="fd-ai-title"
          >
            <p className="fd-eyebrow">Your sketch, their turn</p>
            <h2 id="fd-ai-title">AI insights</h2>
            <div className="fd-toggles">
              {(["guesser", "referee", "heatmap"] as FreeDrawFeature[]).map(
                (feature) => (
                  <button
                    key={feature}
                    type="button"
                    disabled={controller.loading}
                    aria-pressed={controller.toggles[feature]}
                    onClick={() => controller.toggle(feature)}
                  >
                    <span>
                      {feature === "guesser"
                        ? "Guesser"
                        : feature === "referee"
                          ? "Referee"
                          : "Heatmap"}
                    </span>
                    <span>{controller.toggles[feature] ? "On" : "Off"}</span>
                  </button>
                ),
              )}
            </div>
            <div className="fd-status-slots">
              <FeatureStatusLine
                name="Guesser"
                status={controller.availability.guesser}
              />
              <FeatureStatusLine
                name="Referee"
                status={controller.availability.referee}
              />
              <FeatureStatusLine
                name="Attention map"
                status={controller.availability.heatmap}
              />
            </div>
            <p className="fd-confidence-note">
              Guesses submit above 50% confidence.
            </p>
            {controller.error && (
              <p className="fd-controller-error" role="alert">
                {controller.error}
              </p>
            )}
            {controller.saveError && (
              <p className="fd-controller-error" role="alert">
                {controller.saveError}
              </p>
            )}
            <button
              type="button"
              className="fd-restart"
              disabled={controller.loading}
              onClick={controller.restartGuesser}
            >
              Restart Guesser
            </button>
          </section>
          <History controller={controller} />
        </aside>
      </div>
    </main>
  );
}

export default function FreeDrawScreen() {
  return <Workspace />;
}
