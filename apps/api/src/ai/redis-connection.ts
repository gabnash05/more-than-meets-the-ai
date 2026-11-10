import { createClient, type RedisClientType } from "redis";
import type { QueueConnection, QueueEntry } from "./redis-queue";

interface ConnectionOptions {
  url: string;
  username?: string;
  password?: string;
}

/**
 * node-redis adapter for the narrow queue connection boundary.
 *
 * The client reconnects in the background; individual operations surface the
 * current failure to the caller so readiness can fall back to "unavailable"
 * without stopping the game API.
 */
export class RedisQueueConnection implements QueueConnection {
  private client: RedisClientType;
  private connecting: Promise<void> | undefined;

  constructor(options: ConnectionOptions) {
    this.client = createClient({
      url: options.url,
      ...(options.username ? { username: options.username } : {}),
      ...(options.password ? { password: options.password } : {}),
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: attempts => Math.min(1000, attempts * 50),
      },
    }) as RedisClientType;
    this.client.on("error", () => {
      // Readiness refresh and submit errors carry the actionable failure.
    });
  }

  private async connected(): Promise<RedisClientType> {
    if (this.client.isOpen) return this.client;
    this.connecting ??= this.client.connect().then(() => undefined);
    try {
      await this.connecting;
    } catch (error) {
      this.connecting = undefined;
      throw error;
    }
    return this.client;
  }

  async setValue(key: string, value: string | Buffer, ttlMs: number) {
    const client = await this.connected();
    await client.set(key, value, { expiration: { type: "PX", value: Math.max(1, Math.ceil(ttlMs)) } });
  }

  async readText(key: string) {
    const client = await this.connected();
    return client.get(key);
  }

  async deleteKey(key: string) {
    const client = await this.connected();
    await client.del(key);
  }

  async append(stream: string, field: string, value: string) {
    const client = await this.connected();
    return client.xAdd(stream, "*", { [field]: value });
  }

  async ensureGroup(stream: string, group: string) {
    const client = await this.connected();
    try {
      await client.xGroupCreate(stream, group, "0", { MKSTREAM: true });
    } catch (error) {
      if (!String(error).includes("BUSYGROUP")) throw error;
    }
  }

  async readGroup(stream: string, group: string, consumer: string, blockMs: number): Promise<QueueEntry[]> {
    const client = await this.connected();
    const reply = await client.xReadGroup(group, consumer, [{ key: stream, id: ">" }], { BLOCK: blockMs, COUNT: 10 }) as
      { name: string; messages: { id: string; message: Record<string, unknown> }[] }[] | null;
    if (!reply) return [];
    return reply.flatMap(streamReply => streamReply.messages.map(message => ({
      id: message.id,
      fields: Object.fromEntries(Object.entries(message.message).map(([name, value]) => [name, String(value)])),
    })));
  }

  async acknowledge(stream: string, group: string, id: string) {
    const client = await this.connected();
    await client.xAck(stream, group, id);
  }

  async deleteEntry(stream: string, id: string) {
    const client = await this.connected();
    await client.xDel(stream, id);
  }

  async scanKeys(pattern: string) {
    const client = await this.connected();
    const keys: string[] = [];
    for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      for (const key of batch) keys.push(String(key));
    }
    return keys;
  }

  async close() {
    if (this.client.isOpen) await this.client.quit();
  }
}
