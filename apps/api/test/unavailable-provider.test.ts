import { test } from "node:test";
import assert from "node:assert/strict";
import { UnavailableGuesserProvider } from "../src/game/unavailable-provider";

test("unavailable provider returns a result bound to the observation job", async () => {
  const provider = new UnavailableGuesserProvider();
  const result = await provider.guess({ jobId: "job-1", turnId: "turn-1", deadlineAt: 123, canvasId: "canvas-1", generation: 2, sequence: 3, hint: "_" });
  assert.deepEqual(result, { jobId: "job-1", status: "unavailable", reason: "provider-unavailable" });
});
