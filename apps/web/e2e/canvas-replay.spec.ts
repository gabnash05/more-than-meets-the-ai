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
  const busyTransitions = await canvas.evaluate(async (element: HTMLCanvasElement) => {
    let transitions = 0;
    const observer = new MutationObserver(records => {
      transitions += records.filter(record => record.attributeName === "aria-busy" && record.oldValue === "false").length;
    });
    observer.observe(element, { attributes: true, attributeOldValue: true, attributeFilter: ["aria-busy"] });
    await window.canvasReview!.echo();
    await new Promise(resolve => setTimeout(resolve, 0));
    observer.disconnect();
    return transitions;
  });
  expect(busyTransitions).toBe(0);
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

test("a burst replays exact pixels once and reset separates batches", async ({ page }) => {
  await page.goto("/review/canvas/");
  const canvas = page.getByLabel("Drawing canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await line(page, [150, 150], [450, 300]);
  await page.getByRole("button", { name: "Fill" }).click();
  await clickAt(page, 80, 80);
  await expect(canvas).toHaveAttribute("aria-busy", "false");
  const operations = await page.evaluate(() => window.canvasReview!.operations());
  const canonical = await pixels(page);
  await page.evaluate(() => window.canvasReview!.hydrate([]));
  const cycles = await canvas.evaluate(async (element: HTMLCanvasElement, ops) => {
    let count = 0;
    const observer = new MutationObserver(records => {
      count += records.filter(record => record.attributeName === "aria-busy" && record.oldValue === "false").length;
    });
    observer.observe(element, { attributes: true, attributeOldValue: true, attributeFilter: ["aria-busy"] });
    await Promise.all(ops.map(op => window.canvasReview!.apply([op])));
    await new Promise(resolve => setTimeout(resolve, 0));
    observer.disconnect();
    return count;
  }, operations);
  expect(cycles).toBe(1);
  expect(await pixels(page)).toEqual(canonical);
  await page.evaluate(async ops => {
    const first = window.canvasReview!.apply(ops);
    const reset = window.canvasReview!.hydrate([]);
    const last = window.canvasReview!.apply(ops);
    await Promise.all([first, reset, last]);
  }, operations);
  expect(await pixels(page)).toEqual(canonical);
});

test("incremental replay progresses without animation frames", async ({ page }) => {
  await page.goto("/review/canvas/");
  const canvas = page.getByLabel("Drawing canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await line(page, [150, 150], [450, 300]);
  const operations = await page.evaluate(() => window.canvasReview!.operations());
  const expected = await pixels(page);
  await page.evaluate(() => { window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {}; });
  await page.evaluate(() => window.canvasReview!.hydrate([]));
  await page.evaluate(ops => Promise.all(ops.map(op => window.canvasReview!.apply([op]))), operations);
  expect(await pixels(page)).toEqual(expected);
});

test("coalesced pointer samples preserve every point within the server operation limit", async ({ page }) => {
  await page.goto("/review/canvas/");
  const canvas = page.getByLabel("Drawing canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await canvas.evaluate(element => document.addEventListener("pointerdown", event => {
    (element as HTMLCanvasElement).dataset.testPointerId = String(event.pointerId);
  }, { capture: true, once: true }));
  const from = await position(page, 100, 100);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  const expected = await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const pointerId = Number((element as HTMLCanvasElement).dataset.testPointerId);
    const samples = Array.from({ length: 600 }, (_, index) => new PointerEvent("pointermove", {
      pointerId, buttons: 1, pressure: .4,
      clientX: rect.x + (100 + index / 2) * rect.width / 1024,
      clientY: rect.y + (100 + index / 4) * rect.height / 768,
    }));
    const event = new PointerEvent("pointermove", { pointerId, buttons: 1, bubbles: true });
    Object.defineProperty(event, "getCoalescedEvents", { value: () => samples });
    element.dispatchEvent(event);
    return samples.map(sample => ({ x: (sample.clientX - rect.x) * 1024 / rect.width, y: (sample.clientY - rect.y) * 768 / rect.height, pressure: sample.pressure }));
  });
  await page.mouse.up();
  const operations = await page.evaluate(() => window.canvasReview!.operations());
  const appends = operations.filter(op => op.type === "stroke.append");
  expect(appends.every(op => op.points.length <= 512)).toBe(true);
  expect(appends.flatMap(op => op.points).slice(0, 600).map(({ x, y, pressure }) => ({ x, y, pressure }))).toEqual(expected);
  const original = await pixels(page);
  await page.evaluate(ops => window.canvasReview!.hydrate(ops), operations);
  expect(await pixels(page)).toEqual(original);
});

test("overflow requires a full replay and restores exact pixels", async ({ page }) => {
  await page.goto("/review/canvas/");
  const canvas = page.getByLabel("Drawing canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await line(page, [150, 150], [450, 300]);
  const operations = await page.evaluate(() => window.canvasReview!.operations());
  const expected = await pixels(page);
  const outcomes = await page.evaluate(async ops => {
    // All calls are submitted synchronously, before a frame can drain the queue.
    const calls = Array.from({ length: 600 }, (_, index) => window.canvasReview!.apply([{ ...ops[0], opId: `overflow-${index}` }]));
    return (await Promise.allSettled(calls)).map(result => result.status === "rejected" ? result.reason.name : "resolved");
  }, operations);
  expect(outcomes.every(outcome => outcome === "ReplayQueueOverflowError")).toBe(true);
  await expect(page.evaluate(() => window.canvasReview!.apply([]))).rejects.toThrow("authoritative reset");
  await page.evaluate(ops => window.canvasReview!.hydrate(ops), operations);
  await expect(canvas).toHaveAttribute("aria-busy", "false");
  expect(await pixels(page)).toEqual(expected);
});
