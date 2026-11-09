import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, name: RegExp) {
  await page.goto("/review/");
  await page.getByRole("button", { name }).click();
  const canvas = page.getByLabel("Drawing canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await expect(canvas).toHaveAttribute("aria-busy", "false");
  return canvas;
}
async function position(page: Page, x: number, y: number) {
  const box = (await page.getByLabel("Drawing canvas").boundingBox())!;
  return { x: box.x + x * box.width / 1024, y: box.y + y * box.height / 768 };
}
async function clickAt(page: Page, x: number, y: number) {
  const p = await position(page, x, y); await page.mouse.click(p.x, p.y);
}
async function line(page: Page, a: [number, number], b: [number, number]) {
  const from = await position(page, ...a), to = await position(page, ...b);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
}
async function pixels(page: Page) {
  return page.getByLabel("Drawing canvas").evaluate(async (canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")!.getImageData(0, 0, 1024, 768).data;
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash));
  });
}
async function journal(page: Page) {
  return page.evaluate(() => new Promise<{ count: number; lastType: string | null }>((resolve, reject) => {
    const request = indexedDB.open("more-than-meets-drawing-journal", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction("journals", "readonly").objectStore("journals").getAll();
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { const entries = read.result.flat(); resolve({ count: entries.length, lastType: entries.at(-1)?.type ?? null }); db.close(); };
    };
  }));
}

test("restores identical pixels and does not echo replay operations", async ({ page }) => {
  const canvas = await fixture(page, /Drawing.*drawer/);
  await expect(canvas).toHaveAttribute("data-readonly", "false");
  await clickAt(page, 180, 180); // dot
  await line(page, [250, 250], [550, 250]);
  await page.getByRole("button", { name: "eraser", exact: true }).click();
  await clickAt(page, 350, 250);
  await page.getByRole("button", { name: "fill", exact: true }).click();
  await page.getByRole("button", { name: "Color #FF4343" }).click();
  await clickAt(page, 100, 100);
  await expect(canvas).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await journal(page)).lastType).toBe("history.undo");
  const beforeCount = (await journal(page)).count, before = await pixels(page);
  await page.reload();
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await expect(canvas).toHaveAttribute("data-readonly", "false");
  await expect(canvas).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => pixels(page)).toEqual(before);
  expect((await journal(page)).count).toBe(beforeCount);
  const prefix = await page.evaluate(() => new Promise<import("../src/contracts/drawing").CanvasOperation[]>((resolve, reject) => {
    const request = indexedDB.open("more-than-meets-drawing-journal", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction("journals").objectStore("journals").getAll();
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { resolve(read.result.flat()); db.close(); };
    };
  }));
  const expectedPng = await canvas.evaluate((element: HTMLCanvasElement) => {
    const flat = document.createElement("canvas");
    flat.width = element.width;
    flat.height = element.height;
    const context = flat.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, flat.width, flat.height);
    context.drawImage(element, 0, 0);
    return flat.toDataURL("image/png");
  });
  await page.goto("/review/canvas/");
  await expect(page.getByLabel("Drawing canvas")).toHaveAttribute("data-ready", "true");
  expect(await page.evaluate(operations => window.canvasReview!.renderPng(operations), prefix)).toBe(expectedPng);
});

test("guest cannot paint on the shared canvas", async ({ page }) => {
  const canvas = await fixture(page, /Drawing.*guesser/);
  await expect(canvas).toHaveAttribute("data-readonly", "true");
  const before = await pixels(page);
  await line(page, [200, 200], [500, 200]);
  expect(await pixels(page)).toEqual(before);
  await expect(page.getByRole("button", { name: "brush", exact: true })).toHaveCount(0);
});


test("local recovery closes an interrupted stored stroke", async ({ page }) => {
  const canvas = await fixture(page, /Drawing.*drawer/);
  await expect(canvas).toHaveAttribute("data-readonly", "false");
  await clickAt(page, 100, 100);
  await expect.poll(async () => (await journal(page)).lastType).toBe("stroke.end");
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("more-than-meets-drawing-journal", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction("journals", "readwrite");
      const store = tx.objectStore("journals"), cursor = store.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) { reject(new Error("No journal to seed")); return; }
        const at = 1234, actionId = "interrupted-test";
        entry.update([...entry.value,
          { type: "stroke.start", opId: "interrupted-start", actionId, at, settings: { tool: "brush", color: "#181321", size: 12 }, point: { x: 300, y: 300, time: 0 } },
          { type: "stroke.append", opId: "interrupted-append", actionId, at, points: [{ x: 400, y: 300, time: 20 }] },
        ]);
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await expect(canvas).toHaveAttribute("data-readonly", "false");
  await expect.poll(async () => (await journal(page)).lastType).toBe("stroke.end");
  // Atrament smooths a single 300->400 sample, so the rendered segment ends near 315.
  const pixel = await canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext("2d")!.getImageData(308, 300, 1, 1).data));
  expect(pixel[3]).toBeGreaterThan(0);
  const count = (await journal(page)).count;
  await clickAt(page, 500, 500);
  await expect.poll(async () => (await journal(page)).count).toBeGreaterThan(count);
});


test("an echo during a held pointer does not end the local stroke", async ({ page }) => {
  await page.goto("/review/canvas/");
  const canvas = page.getByLabel("Drawing canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  const start = await position(page, 150, 150), middle = await position(page, 300, 150), end = await position(page, 450, 150);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(middle.x, middle.y, { steps: 5 });
  await page.evaluate(() => window.canvasReview!.echo());
  expect(await page.evaluate(() => window.canvasReview!.operations().filter(op => op.type === "stroke.end").length)).toBe(0);
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  const operations = await page.evaluate(() => window.canvasReview!.operations());
  expect(operations.filter(op => op.type === "stroke.start")).toHaveLength(1);
  expect(operations.filter(op => op.type === "stroke.end")).toHaveLength(1);
  expect(operations.some(op => op.type === "stroke.append" && op.points.some(point => point.x > 400))).toBe(true);
});

test("unmount rejects replay queued behind a pending fill", async ({ page }) => {
  await page.addInitScript(() => {
    class PausedWorker {
      onmessage = null;
      onerror = null;
      postMessage() {}
      terminate() {}
    }
    window.Worker = PausedWorker as unknown as typeof Worker;
  });
  await page.goto("/review/canvas/");
  const canvas = page.getByLabel("Drawing canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Fill" }).click();
  await clickAt(page, 100, 100);
  await expect(canvas).toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => window.canvasReview!.replayAndUnmount());
  await expect(page.getByTestId("replay-outcome")).toHaveText("Canvas was disposed");
});

test("saved drawing viewer replays identical pixels at its own size", async ({ page }) => {
  await page.goto("/review/canvas/");
  const live = page.locator("main").getByLabel("Drawing canvas");
  await expect(live).toHaveAttribute("data-ready", "true");
  const box = (await live.boundingBox())!;
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5, { steps: 15 });
  await page.mouse.up();
  const hash = (canvas: typeof live) => canvas.evaluate(async (element: HTMLCanvasElement) => {
    const data = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  });
  const original = await hash(live);
  await page.getByRole("button", { name: "View saved drawings" }).click();
  const saved = page.getByRole("dialog").getByLabel("Drawing canvas");
  await expect(saved).toHaveAttribute("data-readonly", "true");
  await expect.poll(() => hash(saved)).toEqual(original);
  await expect.poll(() => hash(live)).toEqual(original);
});
