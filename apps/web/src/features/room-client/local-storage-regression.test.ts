import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DEFAULT_AVATAR } from "@/contracts/player";
import { LocalRoomClient } from "./local";
import { loadLocalCredential, loadLocalRoomSession } from "./storage";

const profile = { name: "Test", avatar: DEFAULT_AVATAR };
describe("local room persistence", () => {
  it("rejects stale writes from another local client without overwriting the room", async () => {
    const first = new LocalRoomClient();
    const created = await first.create(profile);
    const second = new LocalRoomClient();
    await second.resume(created.snapshot.code, created.resumeToken);
    await first.sendChat("first");
    await expect(second.sendChat("stale")).rejects.toMatchObject({
      code: "stale",
      retryable: true,
    });
    const stored = await loadLocalRoomSession(created.snapshot.code);
    expect(stored?.snapshot.chat.map((message) => message.text)).toEqual([
      "first",
    ]);
    expect(
      second.getSession()?.snapshot.chat.map((message) => message.text),
    ).toEqual(["first"]);
  });
  it("removes associated credentials when a room closes", async () => {
    const client = new LocalRoomClient();
    const created = await client.create(profile);
    await client.leave();
    expect(await loadLocalRoomSession(created.snapshot.code)).toBeNull();
    expect(await loadLocalCredential(created.resumeToken)).toBeNull();
  });
});
