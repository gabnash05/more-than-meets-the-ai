import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { io, type Socket } from "socket.io-client";
import { DEFAULT_AVATAR } from "../../../../packages/game-contracts/src/player";
import type { CanvasOperation, DrawingBatch } from "../../../../packages/game-contracts/src/drawing";
import type { RoomSession } from "../../../../packages/game-contracts/src/room";

const api = process.env.SMOKE_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3001}`;

async function session(path: string, init?: RequestInit): Promise<RoomSession> {
  const response = await fetch(`${api}/api/rooms${path}`, { signal: AbortSignal.timeout(10000), ...init });
  if (!response.ok) throw new Error(`Room bootstrap returned HTTP ${response.status}`);
  return response.json() as Promise<RoomSession>;
}

function profile(name: string): RequestInit {
  return {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: { name, avatar: DEFAULT_AVATAR } }),
  };
}

async function command(socket: Socket, name: string, data: object) {
  const ack = await socket.timeout(4000).emitWithAck(name, { requestId: randomUUID(), ...data }) as { ok: boolean; code?: string };
  if (!ack.ok) throw new Error(`${name} rejected (${ack.code ?? "unknown"})`);
}

function sketch(roomCode: string, canvasId: string, generation: number): DrawingBatch {
  const outlines = [
    [[315, 403], [331, 315], [383, 289], [399, 174], [471, 255], [550, 255], [627, 174], [645, 295], [690, 344], [710, 406], [689, 494], [610, 550], [519, 567], [430, 553], [354, 502], [315, 403]],
    [[405, 388], [424, 385]], [[600, 385], [620, 388]],
    [[491, 438], [518, 455], [544, 438], [491, 438]],
    [[518, 455], [518, 481], [487, 493]], [[518, 481], [548, 494]],
    [[454, 453], [332, 428]], [[456, 480], [326, 488]], [[570, 453], [694, 428]], [[568, 480], [701, 488]],
  ];
  const operations = outlines.flatMap(points => {
    const actionId = randomUUID();
    const base = () => ({ actionId, opId: randomUUID(), at: Date.now() });
    const coordinates = points.map(([x, y], index) => ({ x, y, time: index * 10 }));
    return [
      { ...base(), type: "stroke.start", point: coordinates[0], settings: { tool: "brush", color: "#101010", size: 22 } },
      { ...base(), type: "stroke.append", points: coordinates.slice(1) },
      { ...base(), type: "stroke.end", point: coordinates.at(-1)! },
    ] satisfies CanvasOperation[];
  }).map((operation, index) => ({ ...operation, clientSeq: index + 1 }));
  return {
    transport: "remote", batchId: randomUUID(), streamId: randomUUID(), roomCode, canvasId, generation,
    clientSeq: [1, operations.length], flushReason: "manual", targetIntervalMs: 100, elapsedMs: 100,
    operationCount: operations.length, pointCount: outlines.flat().length, byteCount: Buffer.byteLength(JSON.stringify(operations)), operations,
  };
}

async function main() {
  if (process.env.AI_SMOKE_TEST !== "1" || process.env.GUESSER_MODEL_ID !== "quickdraw-int8-smoke") {
    throw new Error("Enable the private INT8 smoke configuration first");
  }
  const url = new URL("/health/ready", process.env.AI_SERVICE_URL);
  const secret = readFileSync(process.env.AI_SECRET_FILE ?? "/run/mmtai-secrets/ai-token", "utf8").trim();
  const ready = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10000), redirect: "error" });
  if (!ready.ok) throw new Error("Inference readiness request failed");
  const { guesser } = await ready.json() as { guesser: { status: string; modelId: string; artifactRevision: string; labels: string[] } };
  if (guesser?.status !== "ready" || guesser.modelId !== "quickdraw-int8-smoke" || guesser.labels?.length !== 345) {
    throw new Error("The pinned Guesser is unavailable");
  }
  await delay(2750);
  const host = await session("", profile("Smoke host"));
  const code = host.snapshot.code;
  const guest = await session(`/${code}/join`, profile("Smoke guest"));
  const sockets = [host, guest].map(player => io(api, {
    autoConnect: false, transports: ["websocket"], auth: { code, token: player.resumeToken }, reconnection: false, timeout: 4000,
  }));
  const resume = (player: RoomSession) => session(`/${code}/resume`, { headers: { authorization: `Bearer ${player.resumeToken}` } });
  try {
    await Promise.all(sockets.map(socket => new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
      socket.connect();
    })));
    const lobby = await resume(host);
    await command(sockets[0], "room:settings", { expectedRevision: lobby.snapshot.revision, payload: { ...lobby.snapshot.settings, rounds: 1 } });
    await command(sockets[0], "room:start", { expectedRevision: (await resume(host)).snapshot.revision });
    const choosing = await resume(host);
    const generation = choosing.snapshot.game!.generation;
    await command(sockets[0], "room:choose-prompt", { generation, payload: { id: choosing.privateState!.promptOptions![0].id } });
    const drawing = await resume(host);
    await command(sockets[0], "room:drawing", { generation, payload: sketch(code, drawing.snapshot.game!.canvasId, generation) });
    await delay(15000);
    await command(sockets[1], "room:guess", { generation, payload: { text: drawing.privateState!.target! } });
    for (let i = 0; i < 12; i++) {
      const result = (await resume(guest)).snapshot.game?.result;
      if (result) {
        const labels = new Set(guesser.labels.map(label => label.toLowerCase()));
        if (!result.aiAnswers.some(label => labels.has(label.toLowerCase())) || result.aiBenchmark?.points == null) {
          throw new Error("The match finished without a mapped inference result");
        }
        console.log(`Mapped Guesser result accepted by NestJS at revision ${guesser.artifactRevision}.`);
        return;
      }
      await delay(500);
    }
    throw new Error("The match result was not committed");
  } finally {
    sockets.forEach(socket => socket.close());
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : "Smoke test failed");
  process.exitCode = 1;
});
