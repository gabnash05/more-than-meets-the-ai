"use client";

import "./RefereeWarning.css";

export function RefereeWarningBadge({ confidence }: { confidence: number }) {
  return (
    <div className="room-referee-warning" role="status" data-testid="referee-warning">
      <strong>Writing detected by referee</strong>
      <span>{Math.round(confidence * 100)}% confidence</span>
    </div>
  );
}
