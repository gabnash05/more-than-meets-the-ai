import { test } from "node:test";
import { strict as assert } from "node:assert";
import { individualScores, speedPoints } from "./scoring";
test("human-only score boundaries and normalization", () => {
  assert.equal(speedPoints(0, 60000), 100);
  assert.equal(speedPoints(60000, 60000), 30);
  const result = individualScores(
    "drawer",
    ["a", "b"],
    [{ playerId: "a", elapsedMs: 0 }],
    60000,
  );
  assert.equal(result.a.guesserBase, 100);
  assert.equal(result.b.guesserBase, 0);
  assert.equal(result.drawer.drawerRecognition, 30);
  assert.equal(result.drawer.drawerBonus, 0);
});
