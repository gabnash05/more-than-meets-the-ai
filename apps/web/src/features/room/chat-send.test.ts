import { describe, expect, it } from "vitest";
import { beginChatSend, restoreChatDraft } from "./chat-send";

describe("beginChatSend", () => {
  it("clears the draft immediately so the composer stays responsive", () => {
    expect(beginChatSend("hello", false)).toEqual({ text: "hello", draft: "" });
  });

  it("trims the outgoing text", () => {
    expect(beginChatSend("  hi there  ", false)).toEqual({ text: "hi there", draft: "" });
  });

  it("ignores an empty draft", () => {
    expect(beginChatSend("   ", false)).toBeNull();
  });

  it("refuses a second send while one is in flight", () => {
    expect(beginChatSend("hello", true)).toBeNull();
  });
});

describe("restoreChatDraft", () => {
  it("restores the failed text when the composer is still empty", () => {
    expect(restoreChatDraft("", "hello")).toBe("hello");
  });

  it("keeps whatever the user has already typed instead", () => {
    expect(restoreChatDraft("next message", "hello")).toBe("next message");
  });
});
