import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredRefereeId } from "../src/ai/client";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const keys = ["REFEREE_PROVIDER", "REFEREE_MODEL_ID", "AI_TEST_FIXTURES"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a real Referee bundle is enabled without fixture mode", () => {
  withEnv({ REFEREE_PROVIDER: "http", REFEREE_MODEL_ID: "referee-vit-a-v1", AI_TEST_FIXTURES: "0" }, () => {
    assert.equal(configuredRefereeId(), "referee-vit-a-v1");
  });
});

test("the fixture stays gated behind AI_TEST_FIXTURES", () => {
  withEnv({ REFEREE_PROVIDER: "http", REFEREE_MODEL_ID: "referee-fixture-v1", AI_TEST_FIXTURES: "0" }, () => {
    assert.equal(configuredRefereeId(), undefined);
  });
  withEnv({ REFEREE_PROVIDER: "http", REFEREE_MODEL_ID: "referee-fixture-v1", AI_TEST_FIXTURES: "1" }, () => {
    assert.equal(configuredRefereeId(), "referee-fixture-v1");
  });
});

test("Referee remains disabled when its provider is unavailable", () => {
  withEnv({ REFEREE_PROVIDER: "unavailable", REFEREE_MODEL_ID: "referee-vit-a-v1", AI_TEST_FIXTURES: "0" }, () => {
    assert.equal(configuredRefereeId(), undefined);
  });
});
