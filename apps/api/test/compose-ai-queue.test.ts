import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(process.cwd(), "../..");

function composeAvailable(): boolean {
  const result = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  return result.status === 0;
}

function rendered(overlay: boolean, environment: NodeJS.ProcessEnv): Record<string, unknown> {
  const args = ["compose", "-f", "deploy/compose.ghcr.yaml"];
  if (overlay) args.push("-f", "deploy/compose.ghcr.guesser.yaml");
  args.push("config", "--format", "json");
  const result = spawnSync("docker", args, { cwd: root, env: environment, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function services(document: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return document.services as Record<string, Record<string, unknown>>;
}

test("Redis stays private to the optional Guesser overlay", async t => {
  if (!composeAvailable()) {
    t.skip("docker compose is not available locally");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "mtmai-compose-"));
  try {
    const secrets = join(directory, "ai-secrets");
    const artifacts = join(directory, "artifacts");
    mkdirSync(secrets);
    mkdirSync(artifacts);
    writeFileSync(join(directory, "api.env"), "");
    writeFileSync(join(directory, "postgres-password"), "test-only");
    writeFileSync(join(secrets, "ai-token"), "test-only-token-000000000000");
    writeFileSync(join(secrets, "redis-api-password"), "test-only-api");
    writeFileSync(join(secrets, "redis-worker-password"), "test-only-worker");
    writeFileSync(join(secrets, "redis-users.acl"), "user default off\n");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      IMAGE_TAG: "test",
      GUESSER_MODEL_ID: "guesser-vit-a-v1",
      WEB_ORIGINS: "https://example.test",
      API_ENV_FILE: join(directory, "api.env"),
      POSTGRES_SECRET_FILE: join(directory, "postgres-password"),
      AI_SECRETS_DIR: secrets,
      AI_ARTIFACT_DIR: artifacts,
    };

    const base = services(rendered(false, environment));
    assert.equal(base.redis, undefined);
    assert.equal(base.api.environment && (base.api.environment as Record<string, string>).GUESSER_PROVIDER, "unavailable");

    const overlay = services(rendered(true, environment));
    assert.ok(overlay.redis, "the Guesser overlay must define Redis");
    assert.equal(overlay.redis.ports, undefined, "Redis must not publish a host port");
    assert.equal(overlay.redis.image, "docker.io/library/redis:7-alpine");
    const api = overlay.api.environment as Record<string, string>;
    assert.equal(api.GUESSER_PROVIDER, "queue");
    assert.equal(api.AI_QUEUE_REDIS_URL, "redis://redis:6379/0");
    assert.equal(api.AI_QUEUE_REDIS_PASSWORD_FILE, "/run/mmtai-secrets/redis-api-password");
    assert.equal((overlay.api.depends_on as Record<string, unknown> | undefined)?.ai, undefined);
    const ai = overlay.ai.environment as Record<string, string>;
    assert.equal(ai.AI_QUEUE_WORKER, "1");
    assert.equal(ai.AI_QUEUE_REDIS_USERNAME, "worker");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
