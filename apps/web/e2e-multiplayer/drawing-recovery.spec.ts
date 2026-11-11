import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, type Page } from "@playwright/test";
import { io, type Socket } from "socket.io-client";
import { DEFAULT_AVATAR } from "../../../packages/game-contracts/src/player";
import type { CanvasOperation, SequencedOperation } from "../../../packages/game-contracts/src/drawing";
import type { RoomSession } from "../../../packages/game-contracts/src/room";

async function pixels(page: Page) {
  return page.getByLabel("Drawing canvas").evaluate(async (canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  });
}

// Synthetic protocol stress: hold a real fill to create a replay backlog.
test("multiplayer replay overflow resyncs once and restores every pixel", async ({ browser, baseURL }) => {
  const api = process.env.ROOM_TEST_API_URL ?? "http://127.0.0.1:3001";
  const context = await browser.newContext();
  const referenceContext = await browser.newContext();
  let socket: Socket | undefined;
  const errors: string[] = [];
  try {
    await context.addInitScript(() => {
      const state = { held: 0, resyncs: 0, release: () => {} };
      (window as Window & { recoveryProbe?: typeof state }).recoveryProbe = state;
      const NativeWorker = window.Worker;
      class HeldWorker extends NativeWorker {
        postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
          const job = message as { data?: unknown; width?: number; height?: number };
          if (state.held === 0 && job.data instanceof Uint8ClampedArray && job.width === 1024 && job.height === 768) {
            state.held++;
            state.release = () => { state.release = () => {}; super.postMessage(message, transfer as Transferable[]); };
            return;
          }
          super.postMessage(message, transfer as Transferable[]);
        }
      }
      window.Worker = HeldWorker;
      const NativeSocket = window.WebSocket;
      class CountingSocket extends NativeSocket {
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (typeof data === "string" && data.includes('"room:resync"')) state.resyncs++;
          super.send(data);
        }
      }
      window.WebSocket = CountingSocket;
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    const response = await fetch(`${api}/api/rooms`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: "Stress drawer", avatar: DEFAULT_AVATAR } }),
    });
    expect(response.ok).toBe(true);
    const host = await response.json() as RoomSession;
    const code = host.snapshot.code;
    const resume = async () => {
      const result = await fetch(`${api}/api/rooms/${code}/resume`, { headers: { authorization: `Bearer ${host.resumeToken}` } });
      if (!result.ok) throw new Error(`Resume returned HTTP ${result.status}`);
      return result.json() as Promise<RoomSession>;
    };
    socket = io(api, { transports: ["websocket"], auth: { code, token: host.resumeToken }, reconnection: false });
    await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("connect_error", reject); });
    await page.goto(new URL(`/?code=${code}`, baseURL).href);
    await page.getByLabel("Your name").fill("Stress guesser");
    await page.getByRole("button", { name: "Join room →" }).click();
    await expect(page).toHaveURL(/room\/\?code=/);
    // HTTP admission precedes the guest's socket handshake; start only once both
    // authenticated connections are ready, not merely present in the roster.
    await expect.poll(async () => (await resume()).snapshot.players.filter(player => player.connected).length).toBe(2);
    const command = async (name: string, request: object) => socket!.timeout(5000).emitWithAck(name, request) as Promise<{ ok: boolean; code?: string }>;
    const start = await command("room:start", { requestId: randomUUID(), expectedRevision: (await resume()).snapshot.revision });
    expect(start.ok, `Start acknowledgement: ${JSON.stringify(start)}; blockers: ${JSON.stringify((await resume()).snapshot.startBlockers)}`).toBe(true);
    const choosing = await resume();
    const generation = choosing.snapshot.game!.generation;
    const option = choosing.privateState!.promptOptions![0];
    expect((await command("room:choose-prompt", { requestId: randomUUID(), generation, payload: { id: option.id } })).ok).toBe(true);
    const canvasId = (await resume()).snapshot.game!.canvasId;
    const input = page.getByLabel("Your guess");
    await expect(input).toBeEnabled();
    const baseline = await page.evaluate(() => (window as unknown as Window & { recoveryProbe: { resyncs: number } }).recoveryProbe.resyncs);
    const streamId = randomUUID();
    const operations: SequencedOperation[] = [];
    const send = async (operation: CanvasOperation) => {
      const seq = operations.length + 1;
      const sequenced = { ...operation, clientSeq: seq };
      const request = { requestId: randomUUID(), generation, payload: { batchId: randomUUID(), streamId, roomCode: code, canvasId, generation, clientSeq: [seq, seq], operations: [sequenced] } };
      for (let attempt = 0; attempt < 100; attempt++) {
        const ack = await command("room:drawing", request);
        if (ack.ok) { operations.push(sequenced); return; }
        if (ack.code !== "saving-unavailable") throw new Error(`Drawing rejected: ${ack.code}`);
        await delay(30);
      }
      throw new Error("Drawing remained unavailable while saving");
    };
    const base = (actionId: string) => ({ opId: randomUUID(), actionId, at: Date.now() });
    const point = (x: number, y: number, time = 0) => ({ x, y, time });
    await send({ ...base(randomUUID()), type: "fill", point: point(0, 0), color: "#0000ff", tolerance: 0 });
    await expect.poll(() => page.evaluate(() => (window as unknown as Window & { recoveryProbe: { held: number } }).recoveryProbe.held)).toBe(1);
    const action = randomUUID();
    await send({ ...base(action), type: "stroke.start", point: point(100, 100), settings: { tool: "brush", color: "#000000", size: 8 } });
    for (let i = 0; i < 600; i++) await send({ ...base(action), type: "stroke.append", points: [point(100 + i % 300, 100 + Math.floor(i / 300), i + 1)] });
    await send({ ...base(action), type: "stroke.end", point: point(399, 101, 601) });
    await send({ ...base(randomUUID()), type: "fill", point: point(0, 0), color: "#ff0000", tolerance: 0 });
    await expect.poll(() => page.evaluate(() => (window as unknown as Window & { recoveryProbe: { resyncs: number } }).recoveryProbe.resyncs)).toBe(baseline + 1);
    // Guesser input is intentionally independent of canvas replay readiness.
    // The renderer must remain busy until the held fill and reset actually apply.
    await expect(page.getByLabel("Drawing canvas")).toHaveAttribute("aria-busy", "true");
    await page.evaluate(() => (window as unknown as Window & { recoveryProbe: { release(): void } }).recoveryProbe.release());
    await expect(page.getByLabel("Drawing canvas")).toHaveAttribute("aria-busy", "false");
    await expect(input).toBeEnabled();
    const reference = await referenceContext.newPage();
    await reference.goto(new URL("/review/canvas/", baseURL).href);
    await expect(reference.getByLabel("Drawing canvas")).toHaveAttribute("data-ready", "true");
    await reference.evaluate(ops => window.canvasReview!.hydrate(ops), operations);
    const expected = await pixels(reference);
    await expect.poll(() => pixels(page)).toEqual(expected);
    await delay(1000);
    expect(await pixels(page)).toEqual(expected);
    expect(await page.evaluate(() => (window as unknown as Window & { recoveryProbe: { resyncs: number } }).recoveryProbe.resyncs)).toBe(baseline + 1);
    await expect(page.getByText(option.label, { exact: true })).toHaveCount(0);
    await expect(page.getByText("Could not restore the drawing. Please retry.")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    for (const page of context.pages()) await page.evaluate(() => (window as Window & { recoveryProbe?: { release(): void } }).recoveryProbe?.release()).catch(() => {});
    socket?.close();
    await Promise.all([context.close(), referenceContext.close()]);
  }
});
