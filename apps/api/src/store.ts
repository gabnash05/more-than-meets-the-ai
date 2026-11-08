import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "./generated/prisma/client";
import type { DrawingRecord, FinalizedTurn, GameStore, PersistedRoom } from "./game/ports";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class PrismaGameStore implements GameStore {
  readonly db: PrismaClient;
  constructor(url: string) {
    if (!url) throw new Error("DATABASE_URL is required");
    this.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, connectionTimeoutMillis: 5000 }) });
  }
  async loadRooms(): Promise<PersistedRoom[]> {
    return (await this.db.room.findMany()).map(r => ({ code: r.code, state: r.state as Record<string, unknown> }));
  }
  async saveRoom(room: PersistedRoom): Promise<void> {
    const state = room.state as Prisma.InputJsonValue;
    await this.db.room.upsert({ where: { code: room.code }, create: { code: room.code, state }, update: { state } });
  }
  async appendDrawing(record: DrawingRecord): Promise<void> {
    const key = { roomCode: record.roomCode, canvasId: record.canvasId, generation: record.generation, sequence: record.sequence };
    const saved = await this.db.drawing.upsert({ where: { roomCode_canvasId_generation_sequence: key }, create: { ...key, operations: record.operations as Prisma.InputJsonValue }, update: {} });
    if (canonicalJson(saved.operations) !== canonicalJson(record.operations)) throw new Error("Conflicting drawing journal payload");
  }
  async loadDrawing(roomCode: string, canvasId: string, generation: number): Promise<DrawingRecord[]> {
    const rows = await this.db.drawing.findMany({ where: { roomCode, canvasId, generation }, orderBy: { sequence: "asc" } });
    return rows.map(row => ({ ...row, operations: row.operations as unknown[] }));
  }
  async finalizeTurn(record: FinalizedTurn): Promise<void> {
    await this.db.$transaction(async tx => {
      const existing = await tx.turnResult.findUnique({ where: { turnId_generation: { turnId: record.turnId, generation: record.generation } } });
      if (existing) {
        if (existing.roomCode !== record.room.code || canonicalJson(existing.results) !== canonicalJson(record.results)) {
          throw new Error("Conflicting finalized turn payload");
        }
        return;
      }
      await tx.turnResult.create({ data: { turnId: record.turnId, generation: record.generation, roomCode: record.room.code, results: record.results as Prisma.InputJsonValue } });
      const state = record.room.state as Prisma.InputJsonValue;
      await tx.room.upsert({ where: { code: record.room.code }, create: { code: record.room.code, state }, update: { state } });
    });
  }
  async close(): Promise<void> { await this.db.$disconnect(); }
}

/** Process-local store. Values are cloned so callers cannot mutate committed state. */
export class MemoryGameStore implements GameStore {
  private rooms = new Map<string, PersistedRoom>();
  private drawings = new Map<string, DrawingRecord[]>();
  private results = new Map<string, FinalizedTurn>();
  private key(room: string, canvas: string, generation: number) { return JSON.stringify([room, canvas, generation]); }
  async loadRooms() { return structuredClone([...this.rooms.values()]); }
  async saveRoom(room: PersistedRoom) { this.rooms.set(room.code, structuredClone(room)); }
  async appendDrawing(record: DrawingRecord) {
    const key = this.key(record.roomCode, record.canvasId, record.generation);
    const records = this.drawings.get(key) ?? [];
    const existing = records.find(item => item.sequence === record.sequence);
    if (existing) {
      if (canonicalJson(existing.operations) !== canonicalJson(record.operations)) throw new Error("Conflicting drawing journal payload");
      return;
    }
    if (record.sequence !== (records.at(-1)?.sequence ?? 0) + record.operations.length) throw new Error("Noncontiguous drawing journal");
    records.push(structuredClone(record));
    this.drawings.set(key, records);
  }
  async loadDrawing(roomCode: string, canvasId: string, generation: number) {
    return structuredClone(this.drawings.get(this.key(roomCode, canvasId, generation)) ?? []);
  }
  async finalizeTurn(record: FinalizedTurn) {
    const key = JSON.stringify([record.turnId, record.generation]);
    const existing = this.results.get(key);
    if (existing) {
      if (existing.room.code !== record.room.code || canonicalJson(existing.results) !== canonicalJson(record.results)) throw new Error("Conflicting finalized turn payload");
      return;
    }
    this.results.set(key, structuredClone(record));
    this.rooms.set(record.room.code, structuredClone(record.room));
  }
  clearArchive(code: string) {
    for (const [key, records] of this.drawings) if (records[0]?.roomCode === code) this.drawings.delete(key);
    for (const [key, result] of this.results) if (result.room.code === code) this.results.delete(key);
  }
  deleteRoom(code: string) { this.clearArchive(code); this.rooms.delete(code); }
}
