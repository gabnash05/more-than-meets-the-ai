import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import type { CanvasOperation, DrawingPayload } from "../../../../packages/game-contracts/src/drawing";
import { MemoryGameStore } from "../store";
import { RoomEngine } from "./engine";
import type { PersistedRoom } from "./ports";

/** Start a two-player fixture and accept a complete stroke using the compact wire contract. */
async function drawingFixture(t: TestContext) {
  const store = new MemoryGameStore();
  const events: { type: string; reset?: boolean; operations?: CanvasOperation[] }[] = [];
  const engine = new RoomEngine({ store, eventSink: (id, event) => {
    if (id === "drawer") events.push(event as (typeof events)[number]);
  } });
  t.after(() => engine.shutdown());
  const profile = { name: "Drawer", avatar: { shape: "pebble", expression: "smile", color: "cyan" } } as const;
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Guesser" });
  await engine.connect(code, host.resumeToken, "drawer");
  await engine.connect(code, other.resumeToken, "guesser");
  let view = await engine.resume(code, host.resumeToken);
  assert.equal((await engine.command("drawer", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision })).ok, true);
  view = await engine.resume(code, host.resumeToken);
  const { generation, canvasId } = view.snapshot.game!;
  const word = view.privateState!.promptOptions![0].id;
  assert.equal((await engine.command("drawer", "room:choose-prompt", { requestId: "choose", generation, payload: { id: word } })).ok, true);
  const payload: DrawingPayload = { batchId: "batch", streamId: "stream", roomCode: code, canvasId, generation, clientSeq: [1, 2], operations: [
    { type: "stroke.start", opId: "start-op", actionId: "stroke", at: 1, clientSeq: 1, point: { x: 12.125, y: 30.5, time: 1, pressure: .25 }, settings: { tool: "brush", color: "#123456", size: 12 } },
    { type: "stroke.end", opId: "end-op", actionId: "stroke", at: 2, clientSeq: 2, point: { x: 40.125, y: 42.5, time: 2, pressure: .75 } },
  ] };
  assert.equal((await engine.command("drawer", "room:drawing", { requestId: "drawing", generation, payload })).ok, true);
  return { engine, store, host, code, generation, events, word };
}

test("metadata persistence excludes the drawing before cloning and owns its remaining nested state", async t => {
  const { engine, store, code, host, word, generation } = await drawingFixture(t);
  let persisted: PersistedRoom | undefined;
  const save = store.saveRoom.bind(store);
  t.mock.method(store, "saveRoom", async (room: PersistedRoom) => {
    persisted = room;
    await save(room);
  });
  const clone = globalThis.structuredClone;
  let fullHistoryClones = 0;
  // A command still needs one full rollback snapshot. Its metadata save must not
  // make a second copy of the same stroke only to throw that copy away.
  t.mock.method(globalThis, "structuredClone", <T>(value: T, options?: Parameters<typeof structuredClone>[1]): T => {
    if (value && typeof value === "object") {
      const game = (value as { game?: { groups?: { operations?: unknown[] }[] } }).game;
      if (game?.groups?.some(group => group.operations?.length)) fullHistoryClones++;
    }
    return clone(value, options);
  });
  assert.equal((await engine.command("guesser", "room:chat", { requestId: "chat", payload: { text: "1234567890" } })).ok, true);
  assert.equal(fullHistoryClones, 1, "only the command rollback copy should visit the drawing history");
  assert.ok(persisted);
  const state = persisted.state as {
    players: { profile: { name: string; avatar: { color: string } } }[];
    selectedPrompts: string[];
    game: { target: string; groups: { operations: unknown[]; sequence: number; undo: string[]; seenOps: string[]; streams: Record<string, number> }[] };
  };
  assert.equal(state.game.target, word);
  assert.deepEqual(state.selectedPrompts, [word]);
  const group = state.game.groups[0];
  assert.deepEqual(group.operations, []);
  assert.equal(group.sequence, 2);
  assert.deepEqual(group.undo, ["stroke"]);
  assert.deepEqual(group.seenOps, ["start-op", "end-op"]);
  assert.equal(group.streams.stream, 2);
  // A store may retain its input. Mutating that owned snapshot must not mutate
  // live identity, prompt history, or replay state through shallow aliases.
  state.players[0].profile.name = "Mutated stored name";
  state.players[0].profile.avatar.color = "red";
  state.selectedPrompts.push("not-a-real-choice");
  group.undo.length = 0;
  const live = await engine.resume(code, host.resumeToken);
  assert.equal(live.snapshot.players[0].profile.name, "Drawer");
  assert.equal(live.snapshot.players[0].profile.avatar.color, "cyan");
  assert.equal(live.snapshot.game!.sync!.sequence, 2);
  assert.equal((await engine.command("drawer", "room:drawing", { requestId: "undo", generation, payload: {
    batchId: "undo-batch", roomCode: code, canvasId: live.snapshot.game!.canvasId, generation, streamId: "stream", clientSeq: [3, 3],
    operations: [{ type: "history.undo", opId: "undo-op", actionId: "undo-action", at: 3, clientSeq: 3, targetActionId: "stroke" }],
  } })).ok, true, "mutating stored undo state must not corrupt live history");
  assert.equal((await engine.command("guesser", "room:chat", { requestId: "second-chat", payload: { text: "2468013579" } })).ok, true);
  assert.deepEqual(persisted.state.selectedPrompts, [word]);
});

test("failed metadata saves restore the exact accepted drawing prefix", async t => {
  const { engine, store, code, host, events } = await drawingFixture(t);
  assert.equal((await engine.command("drawer", "room:resync", { requestId: "before" })).ok, true);
  const before = structuredClone(events.findLast(event => event.type === "drawing" && event.reset)!.operations);
  const save = store.saveRoom.bind(store);
  let fail = true;
  t.mock.method(store, "saveRoom", async (room: PersistedRoom) => {
    if (fail) { fail = false; throw new Error("Test metadata outage"); }
    await save(room);
  });
  assert.equal((await engine.command("guesser", "room:chat", { requestId: "failed-chat", payload: { text: "0987654321" } })).ok, false);
  assert.equal((await engine.command("drawer", "room:resync", { requestId: "after" })).ok, true);
  assert.deepEqual(events.findLast(event => event.type === "drawing" && event.reset)!.operations, before);
  const view = await engine.resume(code, host.resumeToken);
  assert.equal(view.snapshot.game!.sync!.sequence, 2);
  assert.ok(!view.snapshot.chat.some(message => message.text === "0987654321"));
  assert.equal((await engine.command("guesser", "room:chat", { requestId: "retry-chat", payload: { text: "2468013579" } })).ok, true);
});
