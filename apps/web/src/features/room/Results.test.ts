import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DEFAULT_ROOM_SETTINGS, type RoomSnapshot } from "@/contracts/room";
import { DEFAULT_AVATAR } from "@/contracts/player";
import { RoundRecap } from "./Results";

function snapshot(): RoomSnapshot {
  return {
    code: "TEST", revision: 1, settings: DEFAULT_ROOM_SETTINGS, hostId: "a", phase: "result", teams: [], chat: [],
    players: ["a", "b"].map(id => ({ id, profile: { name: id === "a" ? "Alice" : "Bob", avatar: DEFAULT_AVATAR }, connected: true, joinedAt: 0 })),
    game: { canvasId: "c", generation: 1, drawerId: "a", round: 1, hint: "", time: "", scores: {}, result: { word: "cat", aiAnswers: [], aiCorrect: false, deltas: {}, nextDrawerId: "b" } },
  };
}
function render(room: RoomSnapshot, seconds: number) {
  return renderToStaticMarkup(createElement(RoundRecap, { snapshot: room, playerId: "a", seconds, onReturn: () => {} }));
}
it("shows the next drawer and countdown", () => {
  const html = render(snapshot(), 5);
  expect(html).toContain("Next drawer: Bob"); expect(html).toContain("5s");
});
it("labels the final round countdown", () => {
  const room = snapshot(); room.game!.round = room.settings.rounds; delete room.game!.result!.nextDrawerId;
  const html = render(room, 5);
  expect(html).toContain("Final standings"); expect(html).toContain("5s"); expect(html).not.toContain("Next drawer: Waiting");
});
it("explains blockers when countdown expires", () => {
  const room = snapshot(); room.startBlockers = ["Not enough unused prompts remain."];
  const html = render(room, 0);
  expect(html).toContain("Waiting for players or host action"); expect(html).not.toContain("0s");
});
it("does not invent a next drawer", () => {
  const room = snapshot(); delete room.game!.result!.nextDrawerId;
  expect(render(room, 5)).toContain("Preparing the next round");
});
