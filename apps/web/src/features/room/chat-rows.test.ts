import { describe, expect, it } from "vitest";
import { chatRows } from "./chat-rows";

const players = [
  { id: "p1", profile: { name: "Ada" } },
  { id: "p2", profile: { name: "Grace" } },
];

describe("chatRows", () => {
  it("resolves each author once and keeps message order", () => {
    const rows = chatRows(
      [
        { id: "m1", playerId: "p1", text: "hello", at: 1 },
        { id: "m2", playerId: "p2", text: "hi", at: 2 },
      ],
      players,
    );
    expect(rows).toEqual([
      { id: "m1", name: "Ada", text: "hello", correct: false },
      { id: "m2", name: "Grace", text: "hi", correct: false },
    ]);
  });

  it("falls back to Room for an unknown author", () => {
    expect(chatRows([{ id: "m1", playerId: "gone", text: "hi", at: 1 }], players)[0].name).toBe("Room");
  });

  it("marks correct messages", () => {
    expect(chatRows([{ id: "m1", playerId: "p1", text: "Correct!", at: 1, kind: "correct" }], players)[0].correct).toBe(true);
  });
});
