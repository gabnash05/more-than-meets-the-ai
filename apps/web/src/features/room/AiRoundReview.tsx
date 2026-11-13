"use client";

import { useState } from "react";
import type { RoomSnapshot } from "@/contracts/room";
import { AiPredictionHistory, isSubmitted } from "./AiCard";

export function AiRoundReview({ snapshot }: { snapshot: RoomSnapshot }) {
  const history = snapshot.aiHistory ?? [];
  const [selectedRound, setSelectedRound] = useState<number>();
  const selected =
    history.find((entry) => entry.round === selectedRound) ?? history.at(-1);
  if (!selected) return null;
  const drawer =
    snapshot.players.find((player) => player.id === selected.drawerId)?.profile
      .name ?? "Player";
  const guesses = selected.aiGuesses ?? [];
  const submissions = guesses.filter(isSubmitted).length;
  const outcome =
    selected.aiBenchmark.status === "solved"
      ? "Solved"
      : selected.aiBenchmark.status === "unsolved"
        ? "Not solved"
        : "Unavailable";
  return (
    <section
      className="room-ai-history"
      aria-label="Completed-round AI history"
    >
      <div className="room-ai-review-heading">
        <div>
          <p className="room-eyebrow">Review the AI</p>
          <h3>Completed-round AI history ({history.length})</h3>
        </div>
        <label>
          Round
          <select
            className="room-ai-round-select"
            aria-label="Review AI round"
            value={selected.round}
            onChange={(event) => setSelectedRound(Number(event.target.value))}
          >
            {history.map((entry) => (
              <option key={entry.round} value={entry.round}>
                Round {entry.round} · {entry.word}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="room-ai-review-summary">
        <div>
          <span>
            Round {selected.round} · drawn by {drawer}
          </span>
          <h4>{selected.word}</h4>
        </div>
        <strong>
          {outcome}
          {selected.aiBenchmark.points !== null
            ? ` · ${selected.aiBenchmark.points} points`
            : ""}
        </strong>
      </div>
      <p className="room-ai-review-counts">
        {guesses.length} predictions · {submissions} submitted ·{" "}
        {guesses.length - submissions} below threshold
      </p>
      <AiPredictionHistory guesses={guesses} word={selected.word} />
    </section>
  );
}
