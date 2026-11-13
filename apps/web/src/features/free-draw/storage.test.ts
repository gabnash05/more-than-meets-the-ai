import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { loadFreeDraw, saveFreeDraw, type FreeDrawSaved } from "./storage";

const value: FreeDrawSaved = {
  bitmap: new Blob(["png-bytes"], { type: "image/png" }),
  metadata: {
    settings: { tool: "brush", color: "#123456", size: 8 },
    mode: "prompt",
    prompt: "cat",
    toggles: { guesser: true, referee: false, heatmap: true },
  },
};

describe("free draw persistence", () => {
  it("round trips the latest bitmap and controls metadata", async () => {
    await saveFreeDraw(value, 100);
    const restored = await loadFreeDraw();
    expect(restored?.metadata).toEqual(value.metadata);
    expect(restored?.bitmap.type).toBe("image/png");
    expect(await restored?.bitmap.text()).toBe("png-bytes");
  });

  it("rejects visibly when browser storage is blocked", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveFreeDraw(value, 101)).rejects.toThrow(
      "Browser storage is unavailable.",
    );
    vi.unstubAllGlobals();
  });
});
