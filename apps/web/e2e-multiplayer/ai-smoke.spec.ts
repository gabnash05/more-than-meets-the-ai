import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import type { RoomEvent } from "../../../packages/game-contracts/src/room";

const exec = promisify(execFile);
const origin = "http://127.0.0.1:8080";
const socketOrigin = "ws://127.0.0.1:8080";
const composeDir = fileURLToPath(new URL("../../../deploy/", import.meta.url));
const modelId = "quickdraw-int8-smoke";
const artifactRevision = "b02fde8d8732aed32bc9d8176c3dc4efda0333fb";

type Session = { page: Page; events: RoomEvent[] };
type Canvas = { canvasId: string; generation: number };
type InferenceEvent = Canvas & {
  event: "guesser_prediction" | "guesser_accepted";
  jobId: string;
  sequence: number;
  modelId: string;
  artifactRevision: string;
};

// The outline in the direct API smoke test, replayed with real pointer input here.
const catStrokes = [
  [[315, 403], [331, 315], [383, 289], [399, 174], [471, 255], [550, 255], [627, 174], [645, 295], [690, 344], [710, 406], [689, 494], [610, 550], [519, 567], [430, 553], [354, 502], [315, 403]],
  [[405, 388], [424, 385]], [[600, 385], [620, 388]],
  [[491, 438], [518, 455], [544, 438], [491, 438]],
  [[518, 455], [518, 481], [487, 493]], [[518, 481], [548, 494]],
  [[454, 453], [332, 428]], [[456, 480], [326, 488]], [[570, 453], [694, 428]], [[568, 480], [701, 488]],
];

function captureRoomEvents(page: Page): Session {
  const events: RoomEvent[] = [];
  page.on("websocket", socket => {
    const url = new URL(socket.url());
    if (url.origin !== socketOrigin || url.pathname !== "/socket.io/") return;
    socket.on("framereceived", ({ payload }) => {
      const frame = payload.toString();
      // Engine.IO message (4), Socket.IO event (2).
      if (!frame.startsWith("42")) return;
      const [name, event] = JSON.parse(frame.slice(2)) as [string, RoomEvent];
      if (name === "room:event") events.push(event);
    });
  });
  return { page, events };
}

function snapshots(session: Session) {
  return session.events.filter(event => event.type === "snapshot");
}

function sameCanvas(left: Canvas, right: Canvas) {
  return left.canvasId === right.canvasId && left.generation === right.generation;
}

function containsValue(value: unknown, text: string): boolean {
  if (typeof value === "string") return value === text;
  return value !== null && typeof value === "object" &&
    Object.values(value).some(child => containsValue(child, text));
}

function compose(...args: string[]) {
  return exec("docker", ["compose", "--profile", "ai", ...args], {
    cwd: composeDir, timeout: 20_000, windowsHide: true,
  });
}

async function acceptedPrediction(session: Session, canvas: Canvas) {
  const { stdout, stderr } = await compose("logs", "--no-color", "--no-log-prefix", "--since", "10m", "api", "ai");
  const events = (stdout + "\n" + stderr).split(/\r?\n/).flatMap(line => {
    const start = line.indexOf("{");
    if (start === -1) return [];
    try {
      const event = JSON.parse(line.slice(start)) as InferenceEvent;
      return sameCanvas(event, canvas) && event.modelId === modelId && event.artifactRevision === artifactRevision ? [event] : [];
    } catch {
      return [];
    }
  });
  return events.find(event => event.event === "guesser_prediction" && event.sequence > 0 &&
    events.some(ack => ack.event === "guesser_accepted" && ack.jobId === event.jobId && ack.sequence === event.sequence) &&
    session.events.some(ink => ink.type === "drawing" && !ink.reset && sameCanvas(ink, canvas) && ink.sequence === event.sequence));
}

async function chooseRound(players: Session[], round: number) {
  const choosing = (player: Session) => snapshots(player).at(-1);
  const isDrawer = (player: Session) => {
    const event = choosing(player);
    return event?.snapshot.phase === "choosing" && event.snapshot.game?.round === round &&
      event.privateState?.promptOptions?.length === 3;
  };
  await expect.poll(() => players.filter(isDrawer).length).toBe(1);
  const drawer = players.find(isDrawer)!;
  const guesser = players.find(player => player !== drawer)!;
  const choice = drawer.page.locator(".room-result-overlay button").first();
  const target = (await choice.textContent())!.trim();
  await choice.click();
  await expect(drawer.page.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
  const live = () => snapshots(guesser).at(-1);
  await expect.poll(() => live()?.snapshot.phase).toBe("drawing");
  const game = live()!.snapshot.game!;
  return { drawer, guesser, target, canvas: { canvasId: game.canvasId, generation: game.generation } };
}

async function draw(page: Page, strokes: number[][][]) {
  const bounds = (await page.getByLabel("Drawing canvas").boundingBox())!;
  const move = ([x, y]: number[]) => page.mouse.move(bounds.x + x * bounds.width / 1024, bounds.y + y * bounds.height / 768, { steps: 2 });
  for (const stroke of strokes) {
    await move(stroke[0]);
    await page.mouse.down();
    for (const point of stroke.slice(1)) await move(point);
    await page.mouse.up();
  }
}

async function solve(guesser: Session, target: string) {
  const input = guesser.page.getByLabel("Your guess");
  await input.fill(target);
  await input.press("Enter");
}

test("real Guesser reveals a mapped prediction through Nginx and humans finish after worker loss", async ({ browser, baseURL }, testInfo) => {
  test.skip(process.env.ROOM_TEST_AI_SMOKE !== "1", "Opt in to the local Compose AI acceptance test.");
  expect(baseURL).toBe(origin);
  expect(process.env.COMPOSE_PROJECT_NAME, "Use a dedicated smoke project.").toMatch(/^mmtai-ai-smoke(?:-[a-z0-9-]+)?$/);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  let restoreWorker = false;
  try {
    const [host, guest] = await Promise.all(contexts.map(async context => captureRoomEvents(await context.newPage())));
    const players = [host, guest];
    await host.page.goto(origin);
    await host.page.getByLabel("Your name").fill("Smoke Host");
    await host.page.getByRole("button", { name: /Create a room/ }).click();
    await expect(host.page).toHaveURL(/room\/\?code=/);
    const code = new URL(host.page.url()).searchParams.get("code");
    await guest.page.goto(origin + "/?code=" + code);
    await guest.page.getByLabel("Your name").fill("Smoke Guest");
    await guest.page.getByRole("button", { name: "Join room →" }).click();
    await expect(host.page.locator(".room-person")).toHaveCount(2);
    await host.page.getByRole("combobox", { name: "Prompt rounds" }).click();
    await host.page.getByRole("option", { name: "2 rounds", exact: true }).click();
    await host.page.getByRole("button", { name: /Start match/ }).first().click();

    const first = await chooseRound(players, 1);
    const firstCard = first.guesser.page.getByTestId("ai-card");
    await expect(firstCard.getByRole("status", { name: "AI waiting" })).toBeVisible();
    await first.drawer.page.getByRole("slider", { name: /Size/ }).fill("22");
    await draw(first.drawer.page, catStrokes);
    let evidence: InferenceEvent | undefined;
    await expect.poll(async () => {
      evidence = await acceptedPrediction(first.guesser, first.canvas);
      return evidence?.jobId;
    }, { timeout: 25_000 }).toBeTruthy();
    const beforeReveal = (player: Session) => snapshots(player).filter(({ snapshot }) =>
      snapshot.phase === "drawing" && snapshot.game && sameCanvas(snapshot.game, first.canvas));
    expect(beforeReveal(first.guesser).some(({ snapshot }) => snapshot.game?.aiStatus === "guessing")).toBe(true);
    for (const player of players) {
      expect(beforeReveal(player).length).toBeGreaterThan(0);
      for (const event of beforeReveal(player)) expect(event.snapshot.game?.result).toBeUndefined();
      await expect(player.page.getByTestId("ai-final-answer")).toHaveCount(0);
    }
    for (const event of beforeReveal(first.guesser)) {
      expect(event.privateState?.target).toBeUndefined();
      expect(event.privateState?.promptOptions).toBeUndefined();
    }

    await solve(first.guesser, first.target);
    const firstResult = () => snapshots(first.guesser).find(({ snapshot }) =>
      snapshot.phase === "result" && snapshot.game && sameCanvas(snapshot.game, first.canvas))?.snapshot.game?.result;
    await expect.poll(firstResult).toBeDefined();
    const result = firstResult()!;
    expect(result.aiAnswers).toHaveLength(1);
    expect(result.aiBenchmark?.points).toEqual(expect.any(Number));
    const [answer] = result.aiAnswers;
    await Promise.all(players.map(async player => {
      await expect(player.page.getByTestId("ai-final-answer").locator("strong")).toHaveText(answer);
      for (const event of beforeReveal(player)) expect(containsValue(event.snapshot, answer)).toBe(false);
    }));
    await testInfo.attach("model-to-recap", {
      body: JSON.stringify({ ...evidence, revealedAnswer: answer }),
      contentType: "application/json",
    });

    const second = await chooseRound(players, 2);
    restoreWorker = true;
    await compose("stop", "-t", "0", "ai");
    await draw(second.drawer.page, [[[315, 315], [640, 480]]]);
    await expect(second.guesser.page.getByTestId("ai-card").getByText("AI unavailable", { exact: true })).toBeVisible();
    await solve(second.guesser, second.target);
    await Promise.all(players.map(async ({ page }) => {
      await expect(page.getByRole("heading", { name: "Final standings" })).toBeVisible();
      await expect(page.getByLabel("Final results")).toContainText("1 / 2 rounds scored");
    }));
    const secondResult = snapshots(second.guesser).find(({ snapshot }) =>
      snapshot.phase === "result" && snapshot.game && sameCanvas(snapshot.game, second.canvas))?.snapshot.game?.result;
    expect(secondResult?.aiBenchmark).toMatchObject({ status: "unavailable", points: null });
    const humanDeltas = Object.values(secondResult!.deltas);
    expect(humanDeltas).toHaveLength(2);
    for (const points of humanDeltas) expect(points).toBeGreaterThan(0);
  } finally {
    try {
      if (restoreWorker) await compose("start", "ai");
    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  }
});
