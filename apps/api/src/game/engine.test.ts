import { PROMPTS } from "./prompts";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { RoomEngine as ProductionRoomEngine } from "./engine";
class RoomEngine extends ProductionRoomEngine {
  constructor(options: ConstructorParameters<typeof ProductionRoomEngine>[0]) { super({ ...options, config: { ...options.config, startMs: 0 } }); }
}
import type {
  GameStore,
  PersistedRoom,
  DrawingRecord,
  FinalizedTurn,
} from "./ports";
class MemoryStore implements GameStore {
  rooms = new Map<string, PersistedRoom>();
  drawings: DrawingRecord[] = [];
  async loadRooms() {
    return [...this.rooms.values()].map((r) => structuredClone(r));
  }
  async saveRoom(room: PersistedRoom) {
    this.rooms.set(room.code, structuredClone(room));
  }
  async appendDrawing(record: DrawingRecord) {
    this.drawings.push(structuredClone(record));
  }
  async loadDrawing(code: string, canvas: string, generation: number) {
    return this.drawings.filter(
      (r) =>
        r.roomCode === code &&
        r.canvasId === canvas &&
        r.generation === generation,
    );
  }
  async finalizeTurn(turn: FinalizedTurn) {
    await this.saveRoom(turn.room);
  }
}
const profile = {
  name: "Player",
  avatar: { shape: "pebble", expression: "smile", color: "cyan" },
} as const;
test("independent solves, prompt secrecy and request deduplication", async () => {
  const engine = new RoomEngine({
    store: new MemoryStore(),
    eventSink: () => {},
  });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const second = await engine.join(code, { ...profile, name: "Two" });
  const third = await engine.join(code, { ...profile, name: "Three" });
  await engine.connect(code, host.resumeToken, "one");
  await engine.connect(code, second.resumeToken, "two");
  await engine.connect(code, third.resumeToken, "three");
  let latest = await engine.resume(code, host.resumeToken);
  const start = {
    requestId: "start",
    expectedRevision: latest.snapshot.revision,
  };
  assert.equal((await engine.command("one", "room:start", start)).ok, true);
  assert.equal((await engine.command("one", "room:start", start)).ok, true);
  assert.equal(
    (await engine.command("one", "room:start", { ...start, payload: "other" }))
      .code,
    "request-conflict",
  );
  latest = await engine.resume(code, host.resumeToken);
  const option = latest.privateState!.promptOptions![0].id;
  const generation = latest.snapshot.game!.generation;
  assert.equal(
    (await engine.resume(code, second.resumeToken)).privateState!.promptOptions,
    undefined,
  );
  assert.equal(
    (
      await engine.command("one", "room:choose-prompt", {
        requestId: "choose",
        generation,
        payload: { id: option },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await engine.resume(code, second.resumeToken)).privateState!.target,
    undefined,
  );
  assert.equal(
    (
      await engine.command("two", "room:guess", {
        requestId: "guess-one",
        generation,
        payload: { text: option },
      })
    ).ok,
    true,
  );
  const afterFirstSolve = await engine.resume(code, third.resumeToken);
  assert.equal(afterFirstSolve.snapshot.phase, "drawing");
  assert.equal(afterFirstSolve.snapshot.game?.closing, false);
  assert.equal(afterFirstSolve.privateState?.target, undefined);
  assert.equal(
    (
      await engine.command("three", "room:guess", {
        requestId: "guess-two",
        generation,
        payload: { text: option },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await engine.resume(code, third.resumeToken)).snapshot.phase,
    "result",
  );
  assert.equal((await engine.command("one", "room:drawing", { requestId: "late-drawing", generation, payload: {} })).code, "expired");
  await engine.shutdown();
});
test("disconnect closes a live stroke and restart exposes only its saved journal", async () => {
  const store = new MemoryStore();
  const engine = new RoomEngine({ store, eventSink: () => {} });
  const host = await engine.create(profile);
  const other = await engine.join(host.snapshot.code, {
    ...profile,
    name: "Other",
  });
  await engine.connect(host.snapshot.code, host.resumeToken, "drawer");
  await engine.connect(host.snapshot.code, other.resumeToken, "guesser");
  const lobby = await engine.resume(host.snapshot.code, host.resumeToken);
  assert.equal(
    (
      await engine.command("drawer", "room:start", {
        requestId: "start",
        expectedRevision: lobby.snapshot.revision,
      })
    ).ok,
    true,
  );
  const choosing = await engine.resume(host.snapshot.code, host.resumeToken);
  const game = choosing.snapshot.game!;
  await engine.command("drawer", "room:choose-prompt", {
    requestId: "choose",
    generation: game.generation,
    payload: { id: choosing.privateState!.promptOptions![0].id },
  });
  const operation = {
    type: "stroke.start",
    opId: "op",
    actionId: "action",
    at: 1,
    settings: { tool: "brush", color: "#123456", size: 12 },
    point: { x: 3, y: 4, time: 1 },
    clientSeq: 1,
  };
  const result = await engine.command("drawer", "room:drawing", {
    requestId: "drawing",
    generation: game.generation,
    payload: {
      roomCode: host.snapshot.code,
      canvasId: game.canvasId,
      generation: game.generation,
      streamId: "stream",
      clientSeq: [1, 1],
      operations: [operation],
    },
  });
  assert.equal(result.ok, true);
  await engine.connect(host.snapshot.code, host.resumeToken, "drawer-new");
  assert.equal(
    (await engine.command("drawer", "room:resync", { requestId: "old-lease" }))
      .code,
    "unauthorized",
  );
  await engine.disconnect("drawer-new");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    store.drawings
      .flatMap((record) => record.operations)
      .map((op) => (op as { type: string }).type),
    ["stroke.start", "stroke.end"],
  );
  await engine.shutdown();
  const recovered = new RoomEngine({ store, eventSink: () => {} });
  await recovered.initialize();
  assert.equal(
    (await recovered.resume(host.snapshot.code, other.resumeToken)).snapshot
      .phase,
    "interrupted",
  );
  const sketch = await recovered.interruptedSketch(
    host.snapshot.code,
    other.resumeToken,
    game.canvasId,
    game.generation,
  );
  assert.equal(sketch.sequence, 2);
  assert.equal(sketch.operations.length, 2);
  await assert.rejects(() =>
    recovered.interruptedSketch(
      host.snapshot.code,
      "invalid",
      game.canvasId,
      game.generation,
    ),
  );
  const copiedStore = new MemoryStore();
  copiedStore.rooms = new Map(
    [...store.rooms].map(([key, room]) => [key, structuredClone(room)]),
  );
  copiedStore.drawings = structuredClone(store.drawings);
  const escaped = new RoomEngine({ store: copiedStore, eventSink: () => {} });
  await escaped.initialize();
  await escaped.connect(host.snapshot.code, host.resumeToken, "escape-host");
  await escaped.connect(host.snapshot.code, other.resumeToken, "escape-other");
  const escapeView = await escaped.resume(host.snapshot.code, host.resumeToken);
  assert.equal(escapeView.snapshot.canReturnToLobby, true);
  assert.equal(
    (
      await escaped.command("escape-other", "room:return-to-lobby", {
        requestId: "not-host",
        expectedRevision: escapeView.snapshot.revision,
      })
    ).code,
    "forbidden",
  );
  assert.equal(
    (
      await escaped.command("escape-host", "room:return-to-lobby", {
        requestId: "return",
        expectedRevision: escapeView.snapshot.revision,
      })
    ).ok,
    true,
  );
  const lobbyAfterEscape = await escaped.resume(
    host.snapshot.code,
    host.resumeToken,
  );
  assert.equal(lobbyAfterEscape.snapshot.phase, "lobby");
  assert.equal(
    lobbyAfterEscape.snapshot.interruptedSketches![0].canvasId,
    game.canvasId,
  );
  assert.equal(
    (
      await escaped.interruptedSketch(
        host.snapshot.code,
        host.resumeToken,
        game.canvasId,
        game.generation,
      )
    ).sequence,
    2,
  );
  await escaped.shutdown();
  await recovered.connect(host.snapshot.code, host.resumeToken, "new-drawer");
  await recovered.connect(host.snapshot.code, other.resumeToken, "new-guesser");
  const interrupted = await recovered.resume(
    host.snapshot.code,
    host.resumeToken,
  );
  assert.equal(
    (
      await recovered.command("new-drawer", "room:retry-interrupted", {
        requestId: "retry",
        expectedRevision: interrupted.snapshot.revision,
      })
    ).ok,
    true,
  );
  const retried = await recovered.resume(host.snapshot.code, host.resumeToken);
  assert.equal(retried.snapshot.game!.round, game.round);
  assert.equal(retried.snapshot.game!.drawerId, game.drawerId);
  assert.ok(retried.snapshot.game!.generation > game.generation);
  assert.equal(
    (
      await recovered.command("new-drawer", "room:choose-prompt", {
        requestId: "stale",
        generation: game.generation,
        payload: { id: "apple" },
      })
    ).code,
    "stale-generation",
  );
  await recovered.shutdown();
});

test("two configured rounds finish and the host can return to the lobby", async () => {
  const engine = new RoomEngine({
    store: new MemoryStore(),
    eventSink: () => {},
    config: { chooseMs: 1000, drawMs: 1000, recapMs: 10 },
  });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "one");
  await engine.connect(code, other.resumeToken, "two");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("one", "room:settings", {
    requestId: "settings",
    expectedRevision: view.snapshot.revision,
    payload: { ...view.snapshot.settings, rounds: 2 },
  });
  view = await engine.resume(code, host.resumeToken);
  await engine.command("one", "room:start", {
    requestId: "start",
    expectedRevision: view.snapshot.revision,
  });
  for (let round = 1; round <= 2; round++) {
    const drawerToken = round === 1 ? host.resumeToken : other.resumeToken;
    const drawer = round === 1 ? "one" : "two";
    const guesser = round === 1 ? "two" : "one";
    view = await engine.resume(code, drawerToken);
    assert.equal(view.snapshot.game!.round, round);
    const generation = view.snapshot.game!.generation;
    assert.equal(
      (
        await engine.command(drawer, "room:choose-prompt", {
          requestId: `choose-${round}`,
          generation,
          payload: { id: view.privateState!.promptOptions![0].id },
        })
      ).ok,
      true,
    );
    const secret = (await engine.resume(code, drawerToken)).privateState!
      .target!;
    assert.equal(
      (
        await engine.command(guesser, "room:guess", {
          requestId: `guess-${round}`,
          generation,
          payload: { text: secret },
        })
      ).ok,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  view = await engine.resume(code, host.resumeToken);
  assert.equal(view.snapshot.phase, "finished");
  assert.equal(view.snapshot.finalStandings!.length, 2);
  assert.equal(
    (
      await engine.command("one", "room:return-to-lobby", {
        requestId: "return",
        expectedRevision: view.snapshot.revision,
      })
    ).ok,
    true,
  );
  assert.equal(
    (await engine.resume(code, host.resumeToken)).snapshot.phase,
    "lobby",
  );
  await engine.shutdown();
});
test.skip("team challenges keep canvases private and close independently (deferred)", async () => {
  const sent = new Map<string, unknown[]>();
  const engine = new RoomEngine({
    store: new MemoryStore(),
    eventSink: (id, event) => sent.set(id, [...(sent.get(id) ?? []), event]),
  });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  await engine.connect(code, host.resumeToken, "one");
  let view = await engine.resume(code, host.resumeToken);
  assert.equal(
    (
      await engine.command("one", "room:settings", {
        requestId: "team",
        expectedRevision: view.snapshot.revision,
        payload: { ...view.snapshot.settings, mode: "team" },
      })
    ).ok,
    true,
  );
  const players = [host];
  for (let i = 2; i <= 4; i++) {
    const p = await engine.join(code, { ...profile, name: `P${i}` });
    players.push(p);
    await engine.connect(code, p.resumeToken, `p${i}`);
  }
  view = await engine.resume(code, host.resumeToken);
  assert.equal(
    (
      await engine.command("one", "room:start", {
        requestId: "start",
        expectedRevision: view.snapshot.revision,
      })
    ).ok,
    true,
  );
  const chooser = await engine.resume(code, host.resumeToken);
  const generation = chooser.snapshot.game!.generation;
  assert.equal(
    (
      await engine.command("one", "room:choose-prompt", {
        requestId: "pick",
        generation,
        payload: { id: chooser.privateState!.promptOptions![0].id },
      })
    ).ok,
    true,
  );
  const team1 = await engine.resume(code, players[2].resumeToken);
  const team2 = await engine.resume(code, players[1].resumeToken);
  assert.notEqual(team1.snapshot.game!.canvasId, team2.snapshot.game!.canvasId);
  assert.equal(team1.privateState!.target, undefined);
  const word = (await engine.resume(code, host.resumeToken)).privateState!
    .target!;
  assert.equal(
    (
      await engine.command("p3", "room:guess", {
        requestId: "solve",
        generation,
        payload: { text: word },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await engine.resume(code, players[1].resumeToken)).snapshot.phase,
    "drawing",
  );
  assert.equal(
    (
      await engine.command("p3", "room:guess", {
        requestId: "again",
        generation,
        payload: { text: word },
      })
    ).ok,
    false,
  );
  await engine.shutdown();
});

test.skip("default team play enforces minima and rotates the shared-target chooser (deferred)", async () => {
  const engine = new RoomEngine({
    store: new MemoryStore(),
    eventSink: () => {},
    config: { recapMs: 10 },
  });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  await engine.connect(code, host.resumeToken, "one");
  let view = await engine.resume(code, host.resumeToken);
  assert.equal(
    (
      await engine.command("one", "room:settings", {
        requestId: "settings",
        expectedRevision: view.snapshot.revision,
        payload: { ...view.snapshot.settings, mode: "team", rounds: 2 },
      })
    ).ok,
    true,
  );
  view = await engine.resume(code, host.resumeToken);
  assert.equal(
    (
      await engine.command("one", "room:start", {
        requestId: "too-soon",
        expectedRevision: view.snapshot.revision,
      })
    ).code,
    "not-ready",
  );
  const players = [host];
  for (let i = 2; i <= 4; i++) {
    const player = await engine.join(code, { ...profile, name: `P${i}` });
    players.push(player);
    await engine.connect(code, player.resumeToken, `p${i}`);
  }
  view = await engine.resume(code, host.resumeToken);
  assert.equal(
    (
      await engine.command("one", "room:start", {
        requestId: "start",
        expectedRevision: view.snapshot.revision,
      })
    ).ok,
    true,
  );
  view = await engine.resume(code, host.resumeToken);
  assert.equal(view.snapshot.game!.choosingPlayerId, host.playerId);
  const generation = view.snapshot.game!.generation;
  const target = view.privateState!.promptOptions![0].id;
  assert.equal(
    (await engine.resume(code, players[1].resumeToken)).privateState!
      .promptOptions,
    undefined,
  );
  assert.equal(
    (
      await engine.command("one", "room:choose-prompt", {
        requestId: "pick",
        generation,
        payload: { id: target },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await engine.resume(code, host.resumeToken)).privateState!.target,
    target,
  );
  assert.equal(
    (await engine.resume(code, players[1].resumeToken)).privateState!.target,
    target,
  );
  assert.equal(
    (await engine.resume(code, players[2].resumeToken)).privateState!.target,
    undefined,
  );
  assert.equal(
    (await engine.resume(code, players[3].resumeToken)).privateState!.target,
    undefined,
  );
  await engine.command("p3", "room:guess", {
    requestId: "solve1",
    generation,
    payload: { text: target },
  });
  await engine.command("p4", "room:guess", {
    requestId: "solve2",
    generation,
    payload: { text: target },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const secondChooser = await engine.resume(code, players[3].resumeToken);
  assert.equal(secondChooser.snapshot.phase, "choosing");
  assert.equal(
    secondChooser.snapshot.game!.choosingPlayerId,
    players[3].playerId,
  );
  assert.equal(secondChooser.privateState!.promptOptions!.length, 3);
  assert.equal(
    (await engine.resume(code, players[2].resumeToken)).privateState!
      .promptOptions,
    undefined,
  );
  await engine.shutdown();
});

test("drawer rotation follows the original order after a departure", async () => {
  const engine = new RoomEngine({
    store: new MemoryStore(),
    eventSink: () => {},
    config: { graceMs: 10, drawMs: 40, recapMs: 60 },
  });
  const a = await engine.create(profile);
  const code = a.snapshot.code;
  const b = await engine.join(code, { ...profile, name: "B" });
  const c = await engine.join(code, { ...profile, name: "C" });
  await engine.connect(code, a.resumeToken, "a");
  await engine.connect(code, b.resumeToken, "b");
  await engine.connect(code, c.resumeToken, "c");
  let view = await engine.resume(code, a.resumeToken);
  await engine.command("a", "room:settings", {
    requestId: "settings",
    expectedRevision: view.snapshot.revision,
    payload: { ...view.snapshot.settings, rounds: 2 },
  });
  view = await engine.resume(code, a.resumeToken);
  await engine.command("a", "room:start", {
    requestId: "start",
    expectedRevision: view.snapshot.revision,
  });
  view = await engine.resume(code, a.resumeToken);
  const generation = view.snapshot.game!.generation;
  await engine.command("a", "room:choose-prompt", {
    requestId: "pick",
    generation,
    payload: { id: view.privateState!.promptOptions![0].id },
  });
  assert.equal(
    (await engine.command("a", "room:leave", { requestId: "leave" })).ok,
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  view = await engine.resume(code, b.resumeToken);
  assert.equal(view.snapshot.phase, "result");
  assert.equal(view.snapshot.game!.result!.nextDrawerId, b.playerId);
  await new Promise((resolve) => setTimeout(resolve, 70));
  view = await engine.resume(code, b.resumeToken);
  assert.equal(view.snapshot.phase, "choosing");
  assert.equal(view.snapshot.game!.drawerId, b.playerId);
  await engine.shutdown();
});
test("only the host can return from a blocked finalized result", async () => {
  const engine = new RoomEngine({
    store: new MemoryStore(),
    eventSink: () => {},
    config: { recapMs: 10000 },
  });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "host");
  await engine.connect(code, other.resumeToken, "other");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("host", "room:settings", {
    requestId: "settings",
    expectedRevision: view.snapshot.revision,
    payload: { ...view.snapshot.settings, rounds: 2 },
  });
  view = await engine.resume(code, host.resumeToken);
  await engine.command("host", "room:start", {
    requestId: "start",
    expectedRevision: view.snapshot.revision,
  });
  view = await engine.resume(code, host.resumeToken);
  const generation = view.snapshot.game!.generation;
  const answer = view.privateState!.promptOptions![0].id;
  assert.equal(
    (
      await engine.command("host", "room:return-to-lobby", {
        requestId: "early",
        expectedRevision: view.snapshot.revision,
      })
    ).code,
    "forbidden",
  );
  await engine.command("host", "room:choose-prompt", {
    requestId: "pick",
    generation,
    payload: { id: answer },
  });
  await engine.command("other", "room:guess", {
    requestId: "solve",
    generation,
    payload: { text: answer },
  });
  view = await engine.resume(code, host.resumeToken);
  assert.equal(
    (
      await engine.command("other", "room:return-to-lobby", {
        requestId: "not-host",
        expectedRevision: view.snapshot.revision,
      })
    ).code,
    "forbidden",
  );
  assert.equal(
    (
      await engine.command("host", "room:return-to-lobby", {
        requestId: "not-blocked",
        expectedRevision: view.snapshot.revision,
      })
    ).code,
    "forbidden",
  );
  await engine.disconnect("other");
  view = await engine.resume(code, host.resumeToken);
  assert.equal(
    (
      await engine.command("host", "room:return-to-lobby", {
        requestId: "return",
        expectedRevision: view.snapshot.revision,
      })
    ).ok,
    true,
  );
  assert.equal(
    (await engine.resume(code, host.resumeToken)).snapshot.phase,
    "lobby",
  );
  await engine.shutdown();
});


test("synthetic AI results commit once and remain separate from human standings", async () => {
  let now = 1000;
  const store = new MemoryStore();
  const engine = new RoomEngine({ store, eventSink: () => {}, clock: () => now });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const second = await engine.join(code, { ...profile, name: "Two" });
  await engine.connect(code, host.resumeToken, "ai-host");
  await engine.connect(code, second.resumeToken, "ai-two");
  let view = await engine.resume(code, host.resumeToken);
  assert.deepEqual(view.snapshot.aiBenchmark, { totalPoints: null, scoredRounds: 0, solvedRounds: 0, completedRounds: 0 });
  assert.equal((await engine.command("ai-host", "room:settings", { requestId: "team", expectedRevision: view.snapshot.revision, payload: { ...view.snapshot.settings, mode: "team" } })).code, "unsupported-mode");
  assert.equal((await engine.command("ai-host", "room:start", { requestId: "start-ai", expectedRevision: view.snapshot.revision })).ok, true);
  view = await engine.resume(code, host.resumeToken);
  const word = view.privateState!.promptOptions![0].id;
  const generation = view.snapshot.game!.generation;
  assert.equal((await engine.command("ai-host", "room:choose-prompt", { requestId: "choose-ai", generation, payload: { id: word } })).ok, true);
  for (const confidence of [undefined, 0.5, 0.49]) {
    const low = await engine.reserveGuesserObservation(code);
    assert.equal(await engine.acceptGuesserResult(code, low, { jobId: low.jobId, status: "answer", answer: word, confidence }), true);
  }
  assert.equal((await engine.resume(code, host.resumeToken)).snapshot.game!.result, undefined);
  assert.equal((await engine.resume(code, host.resumeToken)).privateState!.aiGuess, undefined);
  assert.equal((await engine.resume(code, second.resumeToken)).snapshot.game!.result, undefined);
  const job = await engine.reserveGuesserObservation(code);
  now += 12000;
  assert.equal(await engine.acceptGuesserResult(code, job, { jobId: "wrong", status: "answer", confidence: 0.8, answer: word }), false);
  assert.equal(await engine.acceptGuesserResult(code, job, { jobId: job.jobId, status: "answer", confidence: 0.8, answer: word }), true);
  assert.equal(await engine.acceptGuesserResult(code, job, { jobId: job.jobId, status: "answer", confidence: 0.8, answer: word }), false);
  assert.equal((await engine.command("ai-two", "room:guess", { requestId: "human-solve", generation, payload: { text: word } })).ok, true);
  view = await engine.resume(code, host.resumeToken);
  assert.deepEqual(view.snapshot.game!.result!.aiBenchmark, { scoringVersion: "ai-benchmark-v1", status: "solved", points: 86, elapsedMs: 12000 });
  assert.deepEqual(view.snapshot.aiBenchmark, { totalPoints: 86, scoredRounds: 1, solvedRounds: 1, completedRounds: 1 });
  assert.deepEqual(view.snapshot.aiHistory?.[0].aiGuesses?.map(guess => guess.submitted), [false, false, false, true]);
  assert.deepEqual(view.snapshot.game!.result!.aiGuesses?.map(guess => guess.submitted), [false, false, false, true]);
  const restored = new RoomEngine({ store, eventSink: () => {}, clock: () => now });
  await restored.initialize();
  assert.deepEqual((await restored.resume(code, host.resumeToken)).snapshot.aiBenchmark, view.snapshot.aiBenchmark);
  await restored.shutdown();
  await engine.shutdown();
});

test("live multiplayer predictions stay private while the drawer keeps attention maps", async () => {
  const now = 1000;
  const store = new MemoryStore();
  const engine = new RoomEngine({ store, eventSink: () => {}, clock: () => now });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const second = await engine.join(code, { ...profile, name: "Two" });
  await engine.connect(code, host.resumeToken, "heat-host");
  await engine.connect(code, second.resumeToken, "heat-two");
  let view = await engine.resume(code, host.resumeToken);
  assert.equal((await engine.command("heat-host", "room:start", { requestId: "start-heat", expectedRevision: view.snapshot.revision })).ok, true);
  view = await engine.resume(code, host.resumeToken);
  const word = view.privateState!.promptOptions![0].id;
  const generation = view.snapshot.game!.generation;
  assert.equal((await engine.command("heat-host", "room:choose-prompt", { requestId: "choose-heat", generation, payload: { id: word } })).ok, true);

  const heatmap = {
    grid: Array.from({ length: 196 }, (_, index) => index % 256),
    frame: { x: 0, y: 0, width: 1024, height: 768 },
    content: { x: 100, y: 100, width: 800, height: 600 },
  };
  const alternatives = PROMPTS.filter(prompt => prompt !== word)
    .slice(0, 2)
    .map((answer, index) => ({ answer, confidence: index === 0 ? 0.12 : 0.05 }));
  const job = await engine.reserveGuesserObservation(code);
  // A sub-threshold confidence keeps the round unsolved, so the same turn can be
  // probed again in the assertions below.
  assert.equal(await engine.acceptGuesserResult(code, job, { jobId: job.jobId, status: "answer", answer: word, confidence: 0.4, heatmap, alternatives }), true);
  view = await engine.resume(code, host.resumeToken);
  assert.deepEqual(view.snapshot.game!.aiHeatmap, heatmap);
  // No multiplayer viewer, including the drawer, receives live answer text.
  assert.equal(view.privateState!.aiGuess, undefined);
  assert.equal(view.snapshot.game!.result, undefined);
  // Other viewers also cannot use the model's attention map as an oracle.
  const outsider = await engine.resume(code, second.resumeToken);
  assert.equal(outsider.privateState!.aiGuess, undefined);
  assert.equal(outsider.snapshot.game!.result, undefined);
  assert.equal(outsider.snapshot.game!.aiHeatmap, undefined);

  // An unavailable answer clears the map instead of leaving it on screen.
  const next = await engine.reserveGuesserObservation(code);
  assert.equal(await engine.acceptGuesserResult(code, next, { jobId: next.jobId, status: "unavailable", reason: "provider-unavailable" }), true);
  view = await engine.resume(code, host.resumeToken);
  assert.equal(view.snapshot.game!.aiHeatmap, undefined);
  await engine.shutdown();
});

test("synthetic wrong and unavailable AI results distinguish zero from null", async () => {
  for (const status of ["answer", "unavailable"] as const) {
    const engine = new RoomEngine({ store: new MemoryStore(), eventSink: () => {} });
    const host = await engine.create(profile);
    const code = host.snapshot.code;
    const other = await engine.join(code, { ...profile, name: "Other" });
    await engine.connect(code, host.resumeToken, "host");
    await engine.connect(code, other.resumeToken, "other");
    let view = await engine.resume(code, host.resumeToken);
    await engine.command("host", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
    view = await engine.resume(code, host.resumeToken);
    const word = view.privateState!.promptOptions![0].id;
    const generation = view.snapshot.game!.generation;
    await engine.command("host", "room:choose-prompt", { requestId: "choose", generation, payload: { id: word } });
    const job = await engine.reserveGuesserObservation(code);
    const result = status === "answer" ? { jobId: job.jobId, status, answer: PROMPTS.find(prompt => prompt !== word)!, confidence: 0.8 } as const : { jobId: job.jobId, status } as const;
    assert.equal(await engine.acceptGuesserResult(code, job, result), true);
    await engine.command("other", "room:guess", { requestId: "solve", generation, payload: { text: word } });
    view = await engine.resume(code, host.resumeToken);
    assert.equal(view.snapshot.game!.result!.aiBenchmark!.points, status === "answer" ? 0 : null);
    assert.equal(view.snapshot.aiBenchmark!.scoredRounds, status === "answer" ? 1 : 0);
    assert.equal(view.snapshot.aiBenchmark!.completedRounds, 1);
    assert.equal(await engine.acceptGuesserResult(code, job, result), false);
    await engine.shutdown();
  }
});


test("synthetic AI jobs reject changed bindings and late results without scoring", async () => {
  let now = 1000;
  const engine = new RoomEngine({ store: new MemoryStore(), eventSink: () => {}, clock: () => now });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "bound-host");
  await engine.connect(code, other.resumeToken, "bound-other");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("bound-host", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
  view = await engine.resume(code, host.resumeToken);
  const word = view.privateState!.promptOptions![0].id;
  const generation = view.snapshot.game!.generation;
  await engine.command("bound-host", "room:choose-prompt", { requestId: "choose", generation, payload: { id: word } });
  const job = await engine.reserveGuesserObservation(code);
  const answer = { jobId: job.jobId, status: "answer", confidence: 0.8, answer: word } as const;
  assert.equal(await engine.acceptGuesserResult(code, { ...job, sequence: job.sequence + 1 }, answer), false);
  assert.equal(await engine.acceptGuesserResult(code, { ...job, generation: job.generation - 1 }, answer), false);
  now = job.deadlineAt;
  assert.equal(await engine.acceptGuesserResult(code, job, answer), false);
  await engine.shutdown();
});


test("host reconnect after grace transfers to longest connected player", async () => {
  let now = 1000;
  const engine = new RoomEngine({ store: new MemoryStore(), eventSink: () => {}, clock: () => now, config: { graceMs: 30000 } });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "old-host");
  now += 10;
  await engine.connect(code, other.resumeToken, "other");
  await engine.disconnect("old-host");
  now += 30001;
  await engine.connect(code, host.resumeToken, "returned-host");
  assert.equal((await engine.resume(code, host.resumeToken)).snapshot.hostId, other.playerId);
  await engine.shutdown();
});


test("legacy room hydration preserves committed prompt coverage without inventing AI scores", async () => {
  for (const [phase, round, expected] of [["lobby", 0, 0], ["result", 3, 3], ["finished", 3, 3], ["interrupted", 3, 2], ["choosing", 3, 2], ["drawing", 3, 2]] as const) {
    const store = new MemoryStore();
    const original = new RoomEngine({ store, eventSink: () => {} });
    const host = await original.create(profile);
    const code = host.snapshot.code;
    const saved = store.rooms.get(code)!;
    saved.state.phase = phase;
    saved.state.round = round;
    delete saved.state.aiBenchmark;
    // A missing game is sufficient to verify the legacy phase-based coverage default.
    const restored = new RoomEngine({ store, eventSink: () => {} });
    await restored.initialize();
    assert.deepEqual((await restored.resume(code, host.resumeToken)).snapshot.aiBenchmark, { totalPoints: null, scoredRounds: 0, solvedRounds: 0, completedRounds: expected });
    await restored.shutdown();
    await original.shutdown();
  }
});

test("a player leaving during choosing is excluded from the frozen guesser roster", async () => {
  const engine = new RoomEngine({ store: new MemoryStore(), eventSink: () => {} });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  const leaving = await engine.join(code, { ...profile, name: "Leaving" });
  await engine.connect(code, host.resumeToken, "drawer");
  await engine.connect(code, other.resumeToken, "guesser");
  await engine.connect(code, leaving.resumeToken, "leaving");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("drawer", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
  view = await engine.resume(code, host.resumeToken);
  const word = view.privateState!.promptOptions![0].id;
  const generation = view.snapshot.game!.generation;
  assert.equal((await engine.command("leaving", "room:leave", { requestId: "leave" })).ok, true);
  await engine.command("drawer", "room:choose-prompt", { requestId: "choose", generation, payload: { id: word } });
  await engine.command("guesser", "room:guess", { requestId: "solve", generation, payload: { text: word } });
  view = await engine.resume(code, host.resumeToken);
  assert.equal(view.snapshot.phase, "result");
  const components = view.snapshot.game!.result!.components;
  assert.equal(components[host.playerId].drawerRecognition, Math.round(60 * components[other.playerId].guesserBase / 100));
  await engine.shutdown();
});

test("synthetic AI failure differs from normal cancellation of a pending job", async () => {
  for (const scenario of ["failure", "cancel", "pending-only"] as const) {
    const engine = new RoomEngine({ store: new MemoryStore(), eventSink: () => {} });
    const host = await engine.create(profile);
    const code = host.snapshot.code;
    const other = await engine.join(code, { ...profile, name: "Other" });
    await engine.connect(code, host.resumeToken, "drawer");
    await engine.connect(code, other.resumeToken, "guesser");
    let view = await engine.resume(code, host.resumeToken);
    await engine.command("drawer", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
    view = await engine.resume(code, host.resumeToken);
    const word = view.privateState!.promptOptions![0].id;
    const generation = view.snapshot.game!.generation;
    await engine.command("drawer", "room:choose-prompt", { requestId: "choose", generation, payload: { id: word } });
    if (scenario !== "pending-only") {
      const wrong = await engine.reserveGuesserObservation(code);
      assert.equal(await engine.acceptGuesserResult(code, wrong, { jobId: wrong.jobId, status: "answer", answer: PROMPTS.find(prompt => prompt !== word)!, confidence: 0.8 }), true);
    }
    const pending = await engine.reserveGuesserObservation(code);
    if (scenario === "failure") assert.equal(await engine.acceptGuesserResult(code, pending, { jobId: pending.jobId, status: "unavailable", reason: "synthetic failure" }), true);
    await engine.command("guesser", "room:guess", { requestId: "solve", generation, payload: { text: word } });
    view = await engine.resume(code, host.resumeToken);
    assert.equal(view.snapshot.game!.result!.aiBenchmark!.points, scenario === "cancel" ? 0 : null);
    assert.equal(view.snapshot.aiBenchmark!.scoredRounds, scenario === "cancel" ? 1 : 0);
    assert.equal(await engine.acceptGuesserResult(code, pending, { jobId: pending.jobId, status: "answer", confidence: 0.8, answer: word }), false);
    await engine.shutdown();
  }
});


test("archive backpressure preserves a contiguous durable prefix and recovers", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  class DelayedStore extends MemoryStore {
    calls: number[] = [];
    override async appendDrawing(record: DrawingRecord) {
      this.calls.push(record.sequence);
      if (record.sequence === 1) await gate;
      await super.appendDrawing(record);
    }
  }
  const store = new DelayedStore();
  const engine = new RoomEngine({ store, eventSink: () => {} });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "drawer");
  await engine.connect(code, other.resumeToken, "guesser");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("drawer", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
  view = await engine.resume(code, host.resumeToken);
  const generation = view.snapshot.game!.generation;
  await engine.command("drawer", "room:choose-prompt", { requestId: "choose", generation, payload: { id: view.privateState!.promptOptions![0].id } });
  const canvasId = view.snapshot.game!.canvasId;
  const draw = (n: number) => engine.command("drawer", "room:drawing", { requestId: `draw-${n}`, generation, payload: { roomCode: code, canvasId, generation, streamId: "stream", clientSeq: [n,n], operations: [{ type: "canvas.clear", opId: `op-${n}`, actionId: `action-${n}`, at: n, clientSeq: n }] } });
  for (let n = 1; n <= 128; n++) assert.equal((await draw(n)).ok, true);
  assert.equal((await draw(129)).code, "saving-unavailable");
  view = await engine.resume(code, host.resumeToken);
  assert.equal(view.snapshot.game!.sync!.sequence, 128);
  assert.equal(view.snapshot.game!.sync!.durableSequence, 0);
  assert.deepEqual(store.calls, [1]);
  release();
  for (let n = 0; n < 100 && store.drawings.length < 128; n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(store.drawings.map((row) => row.sequence), Array.from({ length: 128 }, (_, i) => i + 1));
  assert.equal((await draw(129)).ok, true);
  for (let n = 0; n < 100 && store.drawings.length < 129; n++) await new Promise((resolve) => setTimeout(resolve, 5));
  view = await engine.resume(code, host.resumeToken);
  assert.equal(view.snapshot.game!.sync!.durableSequence, 129);
  assert.equal(store.drawings.length, 129);
  await engine.shutdown();
});


test("synthetic AI ledger counts committed partial coverage and excludes an interrupted generation", async () => {
  const store = new MemoryStore();
  const engine = new RoomEngine({ store, eventSink: () => {}, config: { recapMs: 10 } });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "one");
  await engine.connect(code, other.resumeToken, "two");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("one", "room:settings", { requestId: "settings", expectedRevision: view.snapshot.revision, payload: { ...view.snapshot.settings, rounds: 4 } });
  view = await engine.resume(code, host.resumeToken);
  await engine.command("one", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
  let firstPoints = 0;
  for (let round = 1; round <= 4; round++) {
    for (let attempt = 0; attempt < 100; attempt++) {
      view = await engine.resume(code, round % 2 ? host.resumeToken : other.resumeToken);
      if (view.snapshot.phase === "choosing" && view.snapshot.game!.round === round) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(view.snapshot.phase, "choosing");
    assert.equal(view.snapshot.game!.round, round);
    const drawer = round % 2 ? "one" : "two";
    const guesser = round % 2 ? "two" : "one";
    const word = view.privateState!.promptOptions![0].id;
    const generation = view.snapshot.game!.generation;
    await engine.command(drawer, "room:choose-prompt", { requestId: `choose-${round}`, generation, payload: { id: word } });
    const job = await engine.reserveGuesserObservation(code);
    if (round === 2) await engine.acceptGuesserResult(code, job, { jobId: job.jobId, status: "answer", answer: PROMPTS.find(prompt => prompt !== word)!, confidence: 0.8 });
    else if (round === 3) await engine.acceptGuesserResult(code, job, { jobId: job.jobId, status: "unavailable", reason: "synthetic failure" });
    else await engine.acceptGuesserResult(code, job, { jobId: job.jobId, status: "answer", confidence: 0.8, answer: word });
    if (round === 4) {
      const recovered = new RoomEngine({ store, eventSink: () => {} });
      await recovered.initialize();
      const interrupted = await recovered.resume(code, host.resumeToken);
      assert.equal(interrupted.snapshot.phase, "interrupted");
      assert.deepEqual(interrupted.snapshot.aiBenchmark, { totalPoints: firstPoints, scoredRounds: 2, solvedRounds: 1, completedRounds: 3 });
      await recovered.shutdown();
      break;
    }
    assert.equal((await engine.command(guesser, "room:guess", { requestId: `solve-${round}`, generation, payload: { text: word } })).ok, true);
    view = await engine.resume(code, host.resumeToken);
    if (round === 1) firstPoints = view.snapshot.game!.result!.aiBenchmark!.points!;
  }
  await engine.shutdown();
});


test("disconnect after drawing deadline does not create a new grace period", async () => {
  let now = 1000;
  const engine = new RoomEngine({ store: new MemoryStore(), eventSink: () => {}, clock: () => now });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "drawer");
  await engine.connect(code, other.resumeToken, "guesser");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("drawer", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
  view = await engine.resume(code, host.resumeToken);
  await engine.command("drawer", "room:choose-prompt", { requestId: "choose", generation: view.snapshot.game!.generation, payload: { id: view.privateState!.promptOptions![0].id } });
  view = await engine.resume(code, host.resumeToken);
  now = view.snapshot.game!.deadlineAt! + 1;
  await engine.disconnect("guesser");
  assert.equal((await engine.resume(code, host.resumeToken)).snapshot.game!.pause, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await engine.resume(code, host.resumeToken)).snapshot.phase, "result");
  await engine.shutdown();
});


test("guesser disconnect leaves the drawer stroke active", async () => {
  const store = new MemoryStore();
  const events: unknown[] = [];
  const engine = new RoomEngine({ store, eventSink: (_connection, event) => events.push(event) });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "drawer");
  await engine.connect(code, other.resumeToken, "guesser");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("drawer", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
  view = await engine.resume(code, host.resumeToken);
  const generation = view.snapshot.game!.generation;
  const canvasId = view.snapshot.game!.canvasId;
  await engine.command("drawer", "room:choose-prompt", { requestId: "choose", generation, payload: { id: view.privateState!.promptOptions![0].id } });
  const start = { type: "stroke.start", opId: "start-op", actionId: "stroke", at: 1, clientSeq: 1, point: { x: 1, y: 2, time: 1 }, settings: { tool: "brush", color: "#123456", size: 2 } };
  const batch = (streamId: string, sequence: number, operation: object) => ({ roomCode: code, canvasId, generation, streamId, clientSeq: [sequence, sequence], operations: [operation] });
  assert.equal((await engine.command("drawer", "room:drawing", { requestId: "start-stroke", generation, payload: batch("old", 1, start) })).ok, true);
  await engine.disconnect("guesser");
  const tail = { type: "stroke.append", opId: "tail", actionId: "stroke", at: 2, clientSeq: 2, points: [{ x: 2, y: 3, time: 2 }] };
  assert.equal((await engine.command("drawer", "room:drawing", { requestId: "tail", generation, payload: batch("old", 2, tail) })).ok, true);
  assert.ok(!events.some((event) => { const e = event as { type?: string; operations?: { type: string }[] }; return e.type === "drawing" && e.operations?.some((op) => op.type === "stroke.end"); }));
  await engine.connect(code, other.resumeToken, "guesser-again");
  const next = { type: "stroke.end", opId: "end-op", actionId: "stroke", at: 3, clientSeq: 3, point: { x: 2, y: 3, time: 3 } };
  assert.equal((await engine.command("drawer", "room:drawing", { requestId: "new-stroke", generation, payload: batch("old", 3, next) })).ok, true);
  for (let n = 0; n < 100 && store.drawings.length < 3; n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(store.drawings.flatMap((row) => row.operations).map((op) => (op as { type: string }).type), ["stroke.start", "stroke.append", "stroke.end"]);
  await engine.shutdown();
});


test("fresh twenty-prompt match never reoffers selected manual or automatic targets", async () => {
  assert.equal(PROMPTS.length, 348);
  assert.equal(new Set(PROMPTS).size, 348);
  const store = new MemoryStore();
  const engine = new RoomEngine({ store, eventSink: () => {}, config: { chooseMs: 15, recapMs: 5 } });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "one");
  await engine.connect(code, other.resumeToken, "two");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("one", "room:settings", { requestId: "settings20", expectedRevision: view.snapshot.revision, payload: { ...view.snapshot.settings, rounds: 20 } });
  view = await engine.resume(code, host.resumeToken);
  await engine.command("one", "room:start", { requestId: "start20", expectedRevision: view.snapshot.revision });
  const selected = new Set<string>();
  for (let round = 1; round <= 20; round++) {
    const drawer = round % 2 ? "one" : "two";
    const guesser = round % 2 ? "two" : "one";
    const drawerToken = round % 2 ? host.resumeToken : other.resumeToken;
    for (let i = 0; i < 100; i++) {
      view = await engine.resume(code, drawerToken);
      if (view.snapshot.phase === "choosing" && view.snapshot.game!.round === round) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(view.snapshot.phase, "choosing");
    const choices = view.privateState!.promptOptions!.map((item) => item.id);
    assert.equal(new Set(choices).size, 3);
    assert.ok(choices.every((word) => !selected.has(word)));
    const generation = view.snapshot.game!.generation;
    if (round % 2) {
      const request = { requestId: `choice-${round}`, generation, payload: { id: choices[0] } };
      assert.equal((await engine.command(drawer, "room:choose-prompt", request)).ok, true);
      assert.equal((await engine.command(drawer, "room:choose-prompt", request)).ok, true);
    } else {
      for (let i = 0; i < 100; i++) {
        view = await engine.resume(code, drawerToken);
        if (view.snapshot.phase === "drawing") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    view = await engine.resume(code, drawerToken);
    const target = view.privateState!.target!;
    assert.ok(choices.includes(target));
    selected.add(target);
    assert.equal((store.rooms.get(code)!.state.selectedPrompts as string[]).length, round);
    assert.equal((await engine.command(guesser, "room:guess", { requestId: `solve-${round}`, generation, payload: { text: target } })).ok, true);
  }
  assert.equal(selected.size, 20);
  await engine.shutdown();
});

test("interrupted selected prompt remains excluded across restart and new match resets history", async () => {
  const store = new MemoryStore();
  const engine = new RoomEngine({ store, eventSink: () => {} });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "one");
  await engine.connect(code, other.resumeToken, "two");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("one", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
  view = await engine.resume(code, host.resumeToken);
  const target = view.privateState!.promptOptions![0].id;
  await engine.command("one", "room:choose-prompt", { requestId: "choose", generation: view.snapshot.game!.generation, payload: { id: target } });
  const recovered = new RoomEngine({ store, eventSink: () => {} });
  await recovered.initialize();
  await recovered.connect(code, host.resumeToken, "host2");
  await recovered.connect(code, other.resumeToken, "other2");
  view = await recovered.resume(code, host.resumeToken);
  assert.equal(view.snapshot.phase, "interrupted");
  await recovered.command("host2", "room:retry-interrupted", { requestId: "retry", expectedRevision: view.snapshot.revision });
  view = await recovered.resume(code, host.resumeToken);
  assert.ok(view.privateState!.promptOptions!.every((p) => p.id !== target));
  assert.deepEqual(store.rooms.get(code)!.state.selectedPrompts, [target]);
  const again = new RoomEngine({ store, eventSink: () => {} });
  await again.initialize();
  await again.connect(code, host.resumeToken, "host3");
  await again.connect(code, other.resumeToken, "other3");
  view = await again.resume(code, host.resumeToken);
  await again.command("host3", "room:return-to-lobby", { requestId: "lobby", expectedRevision: view.snapshot.revision });
  view = await again.resume(code, host.resumeToken);
  await again.command("host3", "room:start", { requestId: "new", expectedRevision: view.snapshot.revision });
  assert.deepEqual(store.rooms.get(code)!.state.selectedPrompts, []);
  await again.shutdown(); await recovered.shutdown(); await engine.shutdown();
});

test("exhausted prompts block retry and let only host leave interrupted game", async () => {
  const store = new MemoryStore();
  const engine = new RoomEngine({ store, eventSink: () => {} });
  const host = await engine.create(profile);
  const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "one"); await engine.connect(code, other.resumeToken, "two");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("one", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
  store.rooms.get(code)!.state.selectedPrompts = PROMPTS.slice(0, -2);
  const recovered = new RoomEngine({ store, eventSink: () => {} });
  await recovered.initialize();
  await recovered.connect(code, host.resumeToken, "host2"); await recovered.connect(code, other.resumeToken, "other2");
  view = await recovered.resume(code, host.resumeToken);
  assert.ok(view.snapshot.startBlockers!.includes("Not enough unused prompts remain."));
  assert.equal(view.snapshot.canReturnToLobby, true);
  assert.equal((await recovered.command("host2", "room:retry-interrupted", { requestId: "retry", expectedRevision: view.snapshot.revision })).code, "prompts-exhausted");
  assert.equal((await recovered.command("other2", "room:return-to-lobby", { requestId: "unauthorized", expectedRevision: view.snapshot.revision })).code, "forbidden");
  assert.equal((await recovered.command("host2", "room:return-to-lobby", { requestId: "lobby", expectedRevision: view.snapshot.revision })).ok, true);
  view = await recovered.resume(code, host.resumeToken);
  assert.ok(!view.snapshot.startBlockers!.includes("Not enough unused prompts remain."));
  assert.equal((await recovered.command("host2", "room:start", { requestId: "fresh", expectedRevision: view.snapshot.revision })).ok, true);
  assert.deepEqual(store.rooms.get(code)!.state.selectedPrompts, []);
  await recovered.shutdown(); await engine.shutdown();
});


test("legacy interrupted state preserves absent history and excludes its known interrupted target", async () => {
  const store = new MemoryStore();
  const engine = new RoomEngine({ store, eventSink: () => {} });
  const host = await engine.create(profile); const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "one"); await engine.connect(code, other.resumeToken, "two");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("one", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
  view = await engine.resume(code, host.resumeToken);
  const target = view.privateState!.promptOptions![0].id;
  await engine.command("one", "room:choose-prompt", { requestId: "choose", generation: view.snapshot.game!.generation, payload: { id: target } });
  delete store.rooms.get(code)!.state.selectedPrompts;
  const recovered = new RoomEngine({ store, eventSink: () => {} }); await recovered.initialize();
  await recovered.connect(code, host.resumeToken, "host2"); await recovered.connect(code, other.resumeToken, "other2");
  view = await recovered.resume(code, host.resumeToken);
  await recovered.command("host2", "room:retry-interrupted", { requestId: "retry", expectedRevision: view.snapshot.revision });
  view = await recovered.resume(code, host.resumeToken);
  assert.ok(view.privateState!.promptOptions!.every((option) => option.id !== target));
  assert.equal(store.rooms.get(code)!.state.selectedPrompts, undefined);
  await recovered.shutdown(); await engine.shutdown();
});

test("exhaustion allows host to leave committed result but never active drawing", async () => {
  const store = new MemoryStore(); const engine = new RoomEngine({ store, eventSink: () => {} });
  const host = await engine.create(profile); const code = host.snapshot.code;
  const other = await engine.join(code, { ...profile, name: "Other" });
  await engine.connect(code, host.resumeToken, "one"); await engine.connect(code, other.resumeToken, "two");
  let view = await engine.resume(code, host.resumeToken);
  await engine.command("one", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
  view = await engine.resume(code, host.resumeToken);
  const target = view.privateState!.promptOptions![0].id; const generation = view.snapshot.game!.generation;
  await engine.command("one", "room:choose-prompt", { requestId: "choose", generation, payload: { id: target } });
  view = await engine.resume(code, host.resumeToken);
  assert.equal(view.snapshot.canReturnToLobby, false);
  assert.equal((await engine.command("one", "room:return-to-lobby", { requestId: "active", expectedRevision: view.snapshot.revision })).code, "forbidden");
  await engine.command("two", "room:guess", { requestId: "solve", generation, payload: { text: target } });
  store.rooms.get(code)!.state.selectedPrompts = PROMPTS.slice(0, -2);
  const recovered = new RoomEngine({ store, eventSink: () => {} }); await recovered.initialize();
  await recovered.connect(code, host.resumeToken, "host2"); await recovered.connect(code, other.resumeToken, "other2");
  view = await recovered.resume(code, host.resumeToken);
  assert.equal(view.snapshot.phase, "result"); assert.equal(view.snapshot.canReturnToLobby, true);
  assert.ok(view.snapshot.startBlockers!.includes("Not enough unused prompts remain."));
  assert.equal((await recovered.resume(code, other.resumeToken)).snapshot.canReturnToLobby, false);
  await recovered.shutdown(); await engine.shutdown();
});

test("archive progress coalesces snapshots while drawing remains immediate", async () => {
  const store = new MemoryStore();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const append = store.appendDrawing.bind(store);
  store.appendDrawing = async record => { await gate; await append(record); };
  const events: { type: string; snapshot?: { game?: { sync?: { durableSequence: number } } } }[] = [];
  const engine = new RoomEngine({ store, eventSink: (id, event) => { if (id === "drawer") events.push(event); } });
  try {
    const host = await engine.create(profile);
    const code = host.snapshot.code;
    const other = await engine.join(code, { ...profile, name: "Other" });
    await engine.connect(code, host.resumeToken, "drawer");
    await engine.connect(code, other.resumeToken, "guesser");
    let view = await engine.resume(code, host.resumeToken);
    await engine.command("drawer", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
    view = await engine.resume(code, host.resumeToken);
    const { generation, canvasId } = view.snapshot.game!;
    await engine.command("drawer", "room:choose-prompt", { requestId: "choose", generation, payload: { id: view.privateState!.promptOptions![0].id } });
    events.length = 0;
    for (let n = 1; n <= 30; n++) {
      const ack = await engine.command("drawer", "room:drawing", { requestId: `draw-${n}`, generation, payload: {
        roomCode: code, canvasId, generation, streamId: "burst", clientSeq: [n, n],
        operations: [{ type: "canvas.clear", opId: `op-${n}`, actionId: `action-${n}`, at: n, clientSeq: n }],
      } });
      assert.equal(ack.ok, true);
    }
    assert.equal(events.filter(event => event.type === "drawing").length, 30);
    release();
    await new Promise(resolve => setTimeout(resolve, 300));
    const snapshots = events.filter(event => event.type === "snapshot");
    assert.ok(snapshots.length <= 2, `received ${snapshots.length} progress snapshots`);
    assert.equal(snapshots.at(-1)?.snapshot?.game?.sync?.durableSequence, 30);
  } finally {
    release();
    await engine.shutdown();
  }
});

test("last solve closes an accepted held stroke before committing the result", async () => {
  const store = new MemoryStore();
  const events: { type: string; operations?: { type: string }[] }[] = [];
  const engine = new RoomEngine({ store, eventSink: (id, event) => { if (id === "drawer") events.push(event); } });
  try {
    const host = await engine.create(profile);
    const code = host.snapshot.code;
    const other = await engine.join(code, { ...profile, name: "Other" });
    await engine.connect(code, host.resumeToken, "drawer");
    await engine.connect(code, other.resumeToken, "guesser");
    let view = await engine.resume(code, host.resumeToken);
    await engine.command("drawer", "room:start", { requestId: "start", expectedRevision: view.snapshot.revision });
    view = await engine.resume(code, host.resumeToken);
    const { generation, canvasId } = view.snapshot.game!;
    const word = view.privateState!.promptOptions![0].id;
    await engine.command("drawer", "room:choose-prompt", { requestId: "choose", generation, payload: { id: word } });
    const batch = (sequence: number, operation: object) => ({ roomCode: code, canvasId, generation, streamId: "held", clientSeq: [sequence, sequence], operations: [operation] });
    const start = { type: "stroke.start", opId: "held-start", actionId: "held-action", at: 1, clientSeq: 1, point: { x: 1, y: 1, time: 1 }, settings: { tool: "brush", color: "#123456", size: 2 } };
    assert.equal((await engine.command("drawer", "room:drawing", { requestId: "held-start", generation, payload: batch(1, start) })).ok, true);
    assert.equal((await engine.command("guesser", "room:guess", { requestId: "solve", generation, payload: { text: word } })).ok, true);
    const tail = { type: "stroke.append", opId: "held-tail", actionId: "held-action", at: 2, clientSeq: 2, points: [{ x: 2, y: 2, time: 2 }] };
    assert.equal((await engine.command("drawer", "room:drawing", { requestId: "held-tail", generation, payload: batch(2, tail) })).code, "expired");
    for (let n = 0; n < 100 && !store.drawings.some(row => row.operations.some(op => op.type === "stroke.end")); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(events.some(event => event.type === "drawing" && event.operations?.some(op => op.type === "stroke.end")));
    assert.deepEqual(store.drawings.flatMap(row => row.operations).map(op => op.type), ["stroke.start", "stroke.end"]);
  } finally { await engine.shutdown(); }
});


test("starting countdown is shared, protects selection and returns to lobby on lost eligibility", async () => {
  const engine = new ProductionRoomEngine({ store: new MemoryStore(), eventSink: () => {}, config: { startMs: 40 } });
  try {
    const host = await engine.create(profile);
    const code = host.snapshot.code;
    const guest = await engine.join(code, { ...profile, name: "Guest" });
    await engine.connect(code, host.resumeToken, "start-host");
    await engine.connect(code, guest.resumeToken, "start-guest");
    const lobby = await engine.resume(code, host.resumeToken);
    assert.equal((await engine.command("start-host", "room:start", { requestId: "start-countdown", expectedRevision: lobby.snapshot.revision })).ok, true);
    const hostView = await engine.resume(code, host.resumeToken);
    const guestView = await engine.resume(code, guest.resumeToken);
    assert.equal(hostView.snapshot.phase, "starting");
    assert.equal(hostView.snapshot.startDeadlineAt, guestView.snapshot.startDeadlineAt);
    assert.equal(hostView.snapshot.game, undefined);
    assert.equal(hostView.privateState?.promptOptions, undefined);
    assert.equal((await engine.command("start-guest", "room:chat", { requestId: "chat", payload: { text: "hello" } })).ok, true);
    await engine.disconnect("start-guest");
    assert.equal((await engine.resume(code, host.resumeToken)).snapshot.phase, "lobby");
    await engine.connect(code, guest.resumeToken, "start-guest-2");
    const ready = await engine.resume(code, host.resumeToken);
    assert.equal((await engine.command("start-host", "room:start", { requestId: "start-again", expectedRevision: ready.snapshot.revision })).ok, true);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal((await engine.resume(code, host.resumeToken)).snapshot.phase, "choosing");
  } finally { await engine.shutdown(); }
});

test("individual disconnects preserve deadlines, sessions, solves, and reject late AI results", async () => {
  let now = 1000;
  const engine = new RoomEngine({ store: new MemoryStore(), eventSink: () => {}, clock: () => now,
    config: { chooseMs: 10000, drawMs: 10000, recapMs: 1000, graceMs: 30000 } });
  try {
    const host = await engine.create(profile);
    const code = host.snapshot.code;
    const other = await engine.join(code, { ...profile, name: "Other" });
    const third = await engine.join(code, { ...profile, name: "Third" });
    await engine.connect(code, host.resumeToken, "cont-host");
    await engine.connect(code, other.resumeToken, "cont-other");
    await engine.connect(code, third.resumeToken, "cont-third");
    const lobby = await engine.resume(code, host.resumeToken);
    assert.deepEqual(lobby.snapshot.chat, []);
    assert.equal((await engine.command("cont-host", "room:start", { requestId: "cont-start", expectedRevision: lobby.snapshot.revision })).ok, true);
    const choice = await engine.resume(code, host.resumeToken);
    const generation = choice.snapshot.game!.generation;
    const target = choice.privateState!.promptOptions![0].id;
    await engine.command("cont-host", "room:choose-prompt", { requestId: "cont-choose", generation, payload: { id: target } });
    const initial = await engine.resume(code, other.resumeToken);
    const deadline = initial.snapshot.game!.deadlineAt;
    const observation = await engine.reserveGuesserObservation(code);
    assert.equal((await engine.command("cont-other", "room:guess", { requestId: "cont-solve", generation, payload: { text: target } })).ok, true);
    await engine.disconnect("cont-third");
    now += 7000;
    const withOfflineGuesser = await engine.resume(code, other.resumeToken);
    assert.equal(withOfflineGuesser.snapshot.game!.deadlineAt, deadline);
    assert.notEqual(withOfflineGuesser.snapshot.game!.hint, initial.snapshot.game!.hint);
    await engine.connect(code, third.resumeToken, "cont-third-again");
    assert.equal(await engine.acceptGuesserResult(code, observation, { jobId: observation.jobId, status: "answer", answer: target, confidence: 1 }), false);
    await engine.disconnect("cont-host");
    const rejoined = await engine.connect(code, host.resumeToken, "cont-host-again");
    assert.equal(rejoined.privateState!.role, "drawer");
    assert.equal(rejoined.snapshot.game!.deadlineAt, deadline);
    await engine.connect(code, host.resumeToken, "cont-host-replacement");
    await engine.disconnect("cont-host-again");
    assert.equal((await engine.command("cont-third-again", "room:leave", { requestId: "cont-leave" })).ok, true);
    await assert.rejects(() => engine.resume(code, third.resumeToken));
    await engine.disconnect("cont-third-again");
    const afterLeave = await engine.resume(code, host.resumeToken);
    assert.deepEqual(afterLeave.snapshot.chat.filter(message => message.kind === "system").map(message => message.text), [
      "Third disconnected.", "Third reconnected.", "Player disconnected.", "Player reconnected.", "Third left.",
    ]);
    assert.equal(afterLeave.snapshot.players.find(player => player.id === third.playerId)?.left, true);
    assert.equal(afterLeave.snapshot.game!.deadlineAt, deadline);
    now = deadline!;
    assert.equal((await engine.command("cont-other", "room:guess", { requestId: "cont-late", generation, payload: { text: target } })).code, "expired");
    await engine.connect(code, other.resumeToken, "cont-other-replacement");
    for (let attempt = 0; attempt < 25; attempt++) {
      if ((await engine.resume(code, host.resumeToken)).snapshot.phase === "result") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const result = (await engine.resume(code, host.resumeToken)).snapshot.game!.result!;
    assert.ok(result.components![other.playerId].guesserBase > 0);
    assert.equal(result.components![third.playerId].guesserBase, 0);
  } finally { await engine.shutdown(); }
});

test("an offline chooser keeps the original deadline and an offline seat can guess on return", async () => {
  let now = 1000;
  const engine = new RoomEngine({ store: new MemoryStore(), eventSink: () => {}, clock: () => now,
    config: { chooseMs: 15000, drawMs: 60000 } });
  try {
    const host = await engine.create(profile);
    const code = host.snapshot.code;
    const first = await engine.join(code, { ...profile, name: "First" });
    const second = await engine.join(code, { ...profile, name: "Second" });
    await engine.connect(code, host.resumeToken, "auto-host");
    await engine.connect(code, first.resumeToken, "auto-first");
    const lobby = await engine.resume(code, host.resumeToken);
    await engine.command("auto-host", "room:start", { requestId: "auto-start", expectedRevision: lobby.snapshot.revision });
    const choosing = await engine.resume(code, host.resumeToken);
    await engine.disconnect("auto-host");
    const beforeExpiry = await engine.resume(code, first.resumeToken);
    assert.equal(beforeExpiry.snapshot.phase, "choosing");
    assert.equal(beforeExpiry.snapshot.game!.deadlineAt, choosing.snapshot.game!.deadlineAt);
    now = choosing.snapshot.game!.deadlineAt!;
    await engine.connect(code, first.resumeToken, "auto-first-replacement");
    for (let attempt = 0; attempt < 25; attempt++) {
      if ((await engine.resume(code, first.resumeToken)).snapshot.phase === "drawing") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const drawing = await engine.resume(code, first.resumeToken);
    assert.equal(drawing.snapshot.phase, "drawing");
    assert.equal(drawing.snapshot.game!.deadlineAt, now + 60000);
    assert.equal(drawing.privateState!.target, undefined);
    const rejoined = await engine.connect(code, second.resumeToken, "auto-second");
    assert.equal(rejoined.privateState!.role, "guesser");
    const expected = choosing.privateState!.promptOptions![0].id;
    assert.equal((await engine.command("auto-second", "room:guess", {
      requestId: "auto-solve", generation: drawing.snapshot.game!.generation, payload: { text: expected },
    })).ok, true);
    assert.equal((await engine.resume(code, second.resumeToken)).snapshot.players.find(player => player.id === second.playerId)?.solved, true);
  } finally { await engine.shutdown(); }
});

test("recap waits for existing humans and resumes when one reconnects", async () => {
  const engine = new RoomEngine({ store: new MemoryStore(), eventSink: () => {}, config: { recapMs: 30, drawMs: 5000 } });
  try {
    const host = await engine.create(profile);
    const code = host.snapshot.code;
    const guest = await engine.join(code, { ...profile, name: "Guest" });
    await engine.connect(code, host.resumeToken, "wait-host");
    await engine.connect(code, guest.resumeToken, "wait-guest");
    let state = await engine.resume(code, host.resumeToken);
    await engine.command("wait-host", "room:start", { requestId: "wait-start", expectedRevision: state.snapshot.revision });
    state = await engine.resume(code, host.resumeToken);
    const generation = state.snapshot.game!.generation;
    const target = state.privateState!.promptOptions![0].id;
    await engine.command("wait-host", "room:choose-prompt", { requestId: "wait-choose", generation, payload: { id: target } });
    await engine.command("wait-guest", "room:guess", { requestId: "wait-solve", generation, payload: { text: target } });
    await engine.disconnect("wait-guest");
    await new Promise(resolve => setTimeout(resolve, 60));
    state = await engine.resume(code, host.resumeToken);
    assert.equal(state.snapshot.phase, "result");
    assert.equal(state.snapshot.waitingForPlayers, true);
    assert.equal(state.snapshot.canReturnToLobby, true);
    await engine.connect(code, guest.resumeToken, "wait-guest-back");
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await engine.resume(code, guest.resumeToken);
    assert.equal(state.snapshot.phase, "choosing");
    assert.equal(state.snapshot.game!.drawerId, guest.playerId);
  } finally { await engine.shutdown(); }
});
