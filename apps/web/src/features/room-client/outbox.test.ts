import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { DrawingBatch } from "@/contracts/drawing";
import { deleteDrawingEnvelope, loadDrawingEnvelopes, saveDrawingEnvelope } from "./outbox";

describe("remote drawing outbox", () => {
  it("persists the complete retry envelope until acknowledged", async () => {
    const envelope = {
      requestId: crypto.randomUUID(), playerId: "player", order: 1,
      expectedRevision: 4, generation: 2,
      payload: { roomCode: "ABC123", canvasId: "canvas", generation: 2, batchId: "batch", operations: [] } as unknown as DrawingBatch,
    };
    await saveDrawingEnvelope(envelope);
    expect(await loadDrawingEnvelopes()).toContainEqual(envelope);
    await deleteDrawingEnvelope(envelope.requestId);
    expect(await loadDrawingEnvelopes()).not.toContainEqual(envelope);
  });
});
