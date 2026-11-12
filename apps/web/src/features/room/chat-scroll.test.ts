import { describe, expect, it } from "vitest";
import { isPinnedToBottom } from "./chat-scroll";

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
