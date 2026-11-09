import "reflect-metadata";
import { Module, Controller, Post, Get, Body, Param, Headers, HttpException, Injectable, Inject, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WebSocketGateway, WebSocketServer, type OnGatewayInit, type OnGatewayConnection, type OnGatewayDisconnect } from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { RoomEngine } from "./game/engine";
import type { Inference } from "./ai/client";
import type { GameStore, GuesserProvider } from "./game/ports";
import { UnavailableGuesserProvider } from "./game/unavailable-provider";
import type { PlayerProfile } from "../../../packages/game-contracts/src/player";
import { MemoryGameStore, PrismaGameStore } from "./store";

export interface AppOptions { inference?: Inference; guesserProvider?: GuesserProvider; store?: GameStore; databaseUrl?: string; storeMode?: "memory" | "postgres"; origins: string[]; engineConfig?: { chooseMs?: number; drawMs?: number; recapMs?: number; graceMs?: number } }
const RUNTIME = Symbol("runtime");
class Runtime {
  server?: Server;
  readonly store: GameStore;
  readonly engine: RoomEngine;
  constructor(readonly options: AppOptions) {
    this.store = options.store ?? (options.storeMode === "memory" ? new MemoryGameStore() : new PrismaGameStore(options.databaseUrl ?? ""));
    this.engine = new RoomEngine({ inference: options.inference, guesserProvider: options.guesserProvider ?? new UnavailableGuesserProvider(), config: options.engineConfig, store: this.store, eventSink: (id, event) => this.server?.to(id).emit("room:event", event), disconnectSink: id => this.server?.sockets.sockets.get(id)?.disconnect(true) });
  }
  async close() { await this.engine.shutdown(); await this.options.inference?.close(); if (this.store instanceof PrismaGameStore) await this.store.close(); }
}
function errorBody(error: unknown) {
  if (error instanceof HttpException) return { status: error.getStatus(), code: "unauthorized", message: "Session is invalid." };
  const e = error as { code?: unknown; message?: unknown };
  if (typeof e?.code === "string" && typeof e.message === "string" && !e.code.startsWith("P")) {
    const status = e.code === "unauthorized" ? 401 : e.code === "not-found" ? 404 : 400;
    return { status, code: e.code, message: e.message };
  }
  console.error("Room service failure", error);
  return { status: 500, code: "internal", message: "Room service failed. Please retry." };
}
function httpError(error: unknown): never { const e = errorBody(error); throw new HttpException({ code: e.code, message: e.message }, e.status); }
@Controller("api")
class HealthController { @Get("health") health() { return { ready: true }; } }
@Controller("api/rooms")
class RoomsController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}
  @Post() async create(@Body() body: { profile: PlayerProfile }) { try { return await this.runtime.engine.create(body?.profile); } catch (e) { return httpError(e); } }
  @Post(":code/join") async join(@Param("code") code: string, @Body() body: { profile: PlayerProfile }) { try { return await this.runtime.engine.join(code, body?.profile); } catch (e) { return httpError(e); } }
  @Get(":code/interrupted/:canvasId/:generation") async interrupted(@Param("code") code: string, @Param("canvasId") canvasId: string, @Param("generation") generation: string, @Headers("authorization") authorization?: string) {
    try { if (!authorization?.startsWith("Bearer ")) throw new HttpException("Unauthorized", 401); const parsed = Number(generation); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpException("Invalid generation", 400); return await this.runtime.engine.interruptedSketch(code, authorization.slice(7), canvasId, parsed); } catch (e) { return httpError(e); }
  }
  @Get(":code/resume") async resume(@Param("code") code: string, @Headers("authorization") authorization?: string) { try { if (!authorization?.startsWith("Bearer ")) throw new HttpException("Unauthorized", 401); return await this.runtime.engine.resume(code, authorization.slice(7)); } catch (e) { return httpError(e); } }
}
@WebSocketGateway({ maxHttpBufferSize: 160000, cors: { origin: true } })
@Injectable()
class RoomGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}
  afterInit(server: Server) {
    this.runtime.server = server;
    server.engine.opts.allowRequest = (req, callback) => callback(null, !req.headers.origin || this.runtime.options.origins.includes(req.headers.origin));
    server.use(async (socket, next) => {
      try {
        const { code, token } = socket.handshake.auth;
        if (typeof code !== "string" || typeof token !== "string") return next(new Error("Unauthorized"));
        socket.data.session = await this.runtime.engine.connect(code, token, socket.id);
        next();
      } catch { next(new Error("Unauthorized")); }
    });
  }
  handleConnection(socket: Socket) {
    const session = socket.data.session as { snapshot: { code: string; players: { id: string; teamId?: string }[] }; playerId: string };
    void socket.join(`room:${session.snapshot.code}`);
    void socket.join(`player:${session.snapshot.code}:${session.playerId}`);
    const teamId = session.snapshot.players.find(player => player.id === session.playerId)?.teamId;
    if (teamId) void socket.join(`team:${session.snapshot.code}:${teamId}`);
    const names = ["room:settings", "room:move", "room:select-team", "room:start", "room:leave", "room:chat", "room:guess", "room:drawing", "room:resync", "room:choose-prompt", "room:retry-interrupted", "room:return-to-lobby"];
    for (const name of names) socket.on(name, async (envelope, ack) => {
      if (typeof ack !== "function") return;
      try { ack(await this.runtime.engine.command(socket.id, name, envelope)); }
      catch (error) { const e = errorBody(error); ack({ ok: false, code: e.code, message: e.message }); }
    });
  }
  handleDisconnect(socket: Socket) { void this.runtime.engine.disconnect(socket.id); }
}
export async function createApplication(options: AppOptions): Promise<{ app: INestApplication; close: () => Promise<void> }> {
  if (!options.origins.length || options.origins.some(origin => {
    try { const parsed = new URL(origin); return !["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin; }
    catch { return true; }
  })) throw new Error("WEB_ORIGINS must contain exact HTTP(S) origins");
  for (const [name, value] of Object.entries(options.engineConfig ?? {})) if (!Number.isSafeInteger(value) || value < 1 || value > 3600000) throw new Error(`Invalid engine duration: ${name}`);
  const runtime = new Runtime(options);
  await runtime.engine.initialize();
  @Module({ controllers: [RoomsController, HealthController], providers: [{ provide: RUNTIME, useValue: runtime }, RoomGateway] }) class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
  app.use((req: { headers: { origin?: string } }, res: { status(code: number): { json(value: unknown): void } }, next: () => void) => {
    if (req.headers.origin && !options.origins.includes(req.headers.origin)) { res.status(403).json({ code: "origin", message: "Origin is not allowed." }); return; }
    next();
  });
  app.enableCors({ origin: options.origins });
  await app.init();
  return { app, close: async () => { await app.close(); await runtime.close(); } };
}
