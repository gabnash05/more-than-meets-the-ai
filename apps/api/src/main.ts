import "dotenv/config";
import { createApplication } from "./app";
import { configuredInference } from "./ai/client";
async function main() {
  const origins = (process.env.WEB_ORIGINS ?? "http://localhost:3000,http://localhost:3100,http://127.0.0.1:3100").split(",").map(value => value.trim());
  const duration = (name: string, fallback: number) => process.env[name] === undefined ? fallback : Number(process.env[name]);
  const engineConfig = { chooseMs: duration("GAME_CHOOSE_MS", 15000), drawMs: duration("GAME_DRAW_MS", 60000), recapMs: duration("GAME_RECAP_MS", 8000), graceMs: duration("GAME_GRACE_MS", 30000) };
  const storeMode = process.env.ROOM_STORE ?? "postgres";
  if (storeMode !== "memory" && storeMode !== "postgres") throw new Error("ROOM_STORE must be memory or postgres");
  const service = await createApplication({ inference: configuredInference(), databaseUrl: process.env.DATABASE_URL, storeMode, origins, engineConfig });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void service.close().finally(() => process.exit()); });
  await service.app.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? "127.0.0.1");
}
void main().catch(error => { console.error("Backend startup failed", error); process.exitCode = 1; });
