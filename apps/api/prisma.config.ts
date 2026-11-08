import "dotenv/config";
import { defineConfig } from "prisma/config";

const postgres = (process.env.ROOM_STORE ?? "postgres") === "postgres";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: postgres ? (process.env.DATABASE_URL ?? "") : "" },
});
