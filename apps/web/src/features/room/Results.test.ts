import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DEFAULT_ROOM_SETTINGS, type RoomSnapshot } from "@/contracts/room";
import { DEFAULT_AVATAR } from "@/contracts/player";
import { RoundRecap } from "./Results";
import { AiRoundReview } from "./AiRoundReview";

function snapshot(): RoomSnapshot {
  return {
    code: "TEST",
    revision: 1,
    settings: DEFAULT_ROOM_SETTINGS,
    hostId: "a",
    phase: "result",
    teams: [],
    chat: [],
    players: ["a", "b"].map((id) => ({
      id,
      profile: { name: id === "a" ? "Alice" : "Bob", avatar: DEFAULT_AVATAR },
      connected: true,
      joinedAt: 0,
    })),
    game: {
      canvasId: "c",
      generation: 1,
      drawerId: "a",
      round: 1,
      hint: "",
      time: "",
      scores: {},
      result: {
        word: "cat",
        aiAnswers: [],
        aiCorrect: false,
        deltas: {},
        nextDrawerId: "b",
      },
    },
  };
}
function render(room: RoomSnapshot, seconds: number) {
  return renderToStaticMarkup(
    createElement(RoundRecap, {
      snapshot: room,
      playerId: "a",
      seconds,
      onReturn: () => {},
    }),
  );
}
it("shows the next drawer and countdown", () => {
  const html = render(snapshot(), 5);
  expect(html).toContain("Next drawer: Bob");
  expect(html).toContain("5s");
});
it("labels the final round countdown", () => {
  const room = snapshot();
  room.game!.round = room.settings.rounds;
  delete room.game!.result!.nextDrawerId;
  const html = render(room, 5);
  expect(html).toContain("Final standings");
  expect(html).toContain("5s");
  expect(html).not.toContain("Next drawer: Waiting");
});
it("explains blockers when countdown expires", () => {
  const room = snapshot();
  room.startBlockers = ["Not enough unused prompts remain."];
  const html = render(room, 0);
  expect(html).toContain("Waiting for players or host action");
  expect(html).not.toContain("0s");
});
it("does not invent a next drawer", () => {
  const room = snapshot();
  delete room.game!.result!.nextDrawerId;
  expect(render(room, 5)).toContain("Preparing the next round");
});

it("opens the completed AI review on the final round with all predictions visible", () => {
  const room = snapshot();
  room.phase = "finished";
  room.aiHistory = [
    {
      round: 1,
      word: "cat",
      drawerId: "a",
      aiBenchmark: {
        scoringVersion: "ai-benchmark-v1",
        status: "unsolved",
        points: 0,
        elapsedMs: null,
      },
      aiGuesses: [
        { answer: "earlier-attempt", confidence: 0.6, submitted: true },
      ],
    },
    {
      round: 2,
      word: "dog",
      drawerId: "b",
      aiBenchmark: {
        scoringVersion: "ai-benchmark-v1",
        status: "solved",
        points: 90,
        elapsedMs: 1000,
      },
      aiGuesses: [
        { answer: "latest-attempt", confidence: 0.4, submitted: false },
        { answer: "dog", confidence: 0.9, submitted: true },
      ],
    },
  ];
  const html = renderToStaticMarkup(
    createElement(AiRoundReview, { snapshot: room }),
  );
  expect(html).toContain("latest-attempt");
  expect(html).not.toContain("earlier-attempt");
  expect(html).toContain("Not submitted - low confidence");
  expect(html).toContain("90%");
  expect(html).toContain("Review AI round");
});
