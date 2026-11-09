import type { Browser, Page } from "playwright";
import type { CanvasOperation } from "../../../../packages/game-contracts/src/drawing";

export class ChromiumRenderer {
  private browser?: Browser;
  private page?: Promise<Page>;
  private queue: Promise<unknown> = Promise.resolve();
  private prefix?: { key: string; png: Promise<Buffer | null> };
  private closed = false;

  constructor(private url: URL) {}

  private async open() {
    const { chromium } = await import("playwright");
    if (!this.browser?.isConnected()) this.browser = await chromium.launch({ timeout: 5000 });
    if (this.closed) {
      await this.browser.close();
      throw new Error("Renderer closed");
    }
    const page = await this.browser.newPage({ serviceWorkers: "block" });
    try {
      await page.route("**/*", route => {
        const request = new URL(route.request().url());
        return request.origin === this.url.origin && (request.pathname === this.url.pathname || request.pathname.startsWith("/_next/static/") || request.pathname.startsWith("/design/"))
          ? route.continue()
          : route.abort();
      });
      await page.goto(this.url.href, { waitUntil: "domcontentloaded", timeout: 5000 });
      await page.waitForFunction(() => "canvasReview" in window, undefined, { timeout: 5000 });
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  warm() {
    this.page ??= this.open().catch(error => {
      this.page = undefined;
      throw error;
    });
    return this.page;
  }

  render(key: string, operations: CanvasOperation[]): Promise<Buffer | null> {
    if (this.prefix?.key === key) return this.prefix.png;
    const png = this.queue.then(async () => {
      if (this.closed) throw new Error("Renderer closed");
      const page = await this.warm();
      const timer = setTimeout(() => { void page.close().catch(() => {}); }, 2500);
      try {
        const data = await page.evaluate(async ops => {
          const view = window as unknown as { canvasReview: { renderPng(prefix: CanvasOperation[]): Promise<string | null> } };
          return view.canvasReview.renderPng(ops);
        }, operations);
        if (!data) return null;
        const bytes = Buffer.from(data.slice("data:image/png;base64,".length), "base64");
        if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("Rendered canvas exceeds limit");
        return bytes;
      } catch (error) {
        this.page = undefined;
        await page.close().catch(() => {});
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
    this.queue = png.catch(() => {
      if (this.prefix?.png === png) this.prefix = undefined;
    });
    this.prefix = { key, png };
    return png;
  }

  async close() {
    this.closed = true;
    await this.browser?.close();
  }
}
