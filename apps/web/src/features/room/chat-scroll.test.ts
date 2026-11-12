import { describe, expect, it } from "vitest";
import { isPinnedToBottom, shouldFollow } from "./chat-scroll";

describe("isPinnedToBottom", () => {
  it("is pinned when the viewport is at the end", () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
  });

  it("is still pinned within the threshold", () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 585, clientHeight: 400 })).toBe(true);
  });

  it("is not pinned when the reader scrolled up", () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false);
  });

  it("treats a viewport shorter than its content as unpinned", () => {
    expect(isPinnedToBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 400 })).toBe(true);
  });
});

describe("shouldFollow", () => {
  it("follows when the reader is already at the bottom", () => {
    expect(shouldFollow({ pinned: true })).toBe(true);
  });

  it("follows your own message even after you scrolled away", () => {
    expect(shouldFollow({ pinned: false, latestAuthorId: "me", viewerId: "me" })).toBe(true);
  });

  it("stays put for someone else's message while you read history", () => {
    expect(shouldFollow({ pinned: false, latestAuthorId: "them", viewerId: "me" })).toBe(false);
  });

  it("stays put when the viewer is unknown", () => {
    expect(shouldFollow({ pinned: false, latestAuthorId: "them" })).toBe(false);
  });
});
