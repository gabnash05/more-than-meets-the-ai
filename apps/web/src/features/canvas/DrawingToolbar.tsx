"use client";

import { useEffect } from "react";
import { CRAYON_COLORS } from "@/contracts/player";
import type { CanvasStatus, DrawingSettings } from "@/contracts/drawing";
import "./DrawingToolbar.css";

export interface DrawingToolbarProps {
  settings: DrawingSettings;
  onSettingsChange(settings: DrawingSettings): void;
  status: CanvasStatus;
  disabled?: boolean;
  onUndo(): void;
  onRedo(): void;
  onClear(): void;
}

export function DrawingToolbar({
  settings,
  onSettingsChange,
  status,
  disabled = false,
  onUndo,
  onRedo,
  onClear,
}: DrawingToolbarProps) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]"))
        return;
      if (disabled || status.busy) return;
      const key = event.key.toLowerCase();
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        (key === "z" || key === "y")
      ) {
        event.preventDefault();
        if (key === "y" || event.shiftKey) onRedo();
        else onUndo();
      } else if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        ["b", "e", "f"].includes(key)
      ) {
        onSettingsChange({
          ...settings,
          tool: ({ b: "brush", e: "eraser", f: "fill" } as const)[
            key as "b" | "e" | "f"
          ],
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, onRedo, onSettingsChange, onUndo, settings, status.busy]);

  return (
    <fieldset className="room-tools" disabled={disabled || status.busy}>
      <div className="room-tool-row">
        {(["brush", "eraser", "fill"] as const).map((tool) => (
          <button
            key={tool}
            type="button"
            className="room-button"
            aria-pressed={settings.tool === tool}
            onClick={() => onSettingsChange({ ...settings, tool })}
          >
            {tool}
          </button>
        ))}
        <button type="button" className="room-button" disabled={!status.canUndo} onClick={onUndo}>
          Undo
        </button>
        <button type="button" className="room-button" disabled={!status.canRedo} onClick={onRedo}>
          Redo
        </button>
        <button type="button" className="room-button" disabled={!status.hasInk} onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="room-tool-row room-palette">
        {["#181321", ...Object.values(CRAYON_COLORS), "#FFFFFF"].map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Color ${color}`}
            aria-pressed={settings.color.toUpperCase() === color}
            style={{ background: color }}
            onClick={() => onSettingsChange({ ...settings, color })}
          />
        ))}
        <label>
          Size{" "}
          <input
            type="range"
            min="2"
            max="40"
            value={settings.size}
            onChange={(event) => onSettingsChange({ ...settings, size: Number(event.target.value) })}
          />
        </label>
        <label>
          Custom color{" "}
          <input
            type="color"
            value={settings.color}
            onChange={(event) => onSettingsChange({ ...settings, color: event.target.value })}
          />
        </label>
      </div>
    </fieldset>
  );
}
