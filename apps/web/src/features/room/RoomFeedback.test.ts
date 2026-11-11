import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { RoomFeedback } from "./RoomFeedback";

it("labels pending guesses without assuming correctness", () => {
  const html = renderToStaticMarkup(createElement(RoomFeedback, { phase: "drawing", role: "guesser", pending: true }));
  expect(html).toContain("Checking your guess");
  expect(html).not.toContain("Correct!");
});
it("confirms a personal solve while others keep guessing", () => {
  const html = renderToStaticMarkup(createElement(RoomFeedback, { phase: "drawing", role: "guesser", pending: false, solved: true }));
  expect(html).toContain("Correct!");
  expect(html).toContain("The others are still guessing");
});
it("explains closing without revealing an answer or points", () => {
  const html = renderToStaticMarkup(createElement(RoomFeedback, { phase: "drawing", role: "guesser", pending: false, solved: true, closing: true, saving: "saving" }));
  expect(html).toContain("Saving the drawing and results");
  expect(html).not.toContain("The others are still guessing");
  expect(html).not.toContain("points");
});
it("keeps blocked saving visible and does not replace recap", () => {
  expect(renderToStaticMarkup(createElement(RoomFeedback, { phase: "drawing", pending: false, closing: true, saving: "blocked" }))).toContain("Saving is delayed");
  expect(renderToStaticMarkup(createElement(RoomFeedback, { phase: "result", pending: true, solved: true, closing: true }))).toBe("");
});
