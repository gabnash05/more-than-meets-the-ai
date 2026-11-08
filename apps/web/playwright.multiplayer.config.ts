import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e-multiplayer", testIgnore: "**/*.later.spec.ts", workers: 1, timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: process.env.ROOM_TEST_BASE_URL ?? "http://127.0.0.1:3100", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
});
