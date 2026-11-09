import { expect, test, type Page } from "@playwright/test";

async function journal(page: Page) {
  return page.evaluate(() => new Promise<{ type: string; clientSeq?: number }[]>((resolve, reject) => {
    const open = indexedDB.open("more-than-meets-drawing-journal", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction("journals", "readonly").objectStore("journals").getAll();
      read.onerror = () => reject(read.error);
      read.onsuccess = () => { resolve(read.result.flat()); db.close(); };
    };
  }));
}

test("persists a held stroke before release, flushes its tail, and stays idle", async ({ page }) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: "Drawing · drawer" }).click();
  const canvas = page.getByLabel("Drawing canvas");
  await expect(canvas).toHaveAttribute("data-readonly", "false");
  const box = (await canvas.boundingBox())!;
  expect(await journal(page)).toHaveLength(0);
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + 30 + i * 10, box.y + 30 + i * 5);
    await page.waitForTimeout(25);
  }
  await expect.poll(async () => (await journal(page)).length).toBeGreaterThan(0);
  expect((await journal(page)).some(op => op.type === "stroke.append")).toBe(true);
  await page.mouse.up();
  await expect.poll(async () => (await journal(page)).at(-1)?.type).toBe("stroke.end");
  const operations = await journal(page);
  expect(operations.map(op => op.clientSeq)).toEqual(operations.map((_, i) => i + 1));
  await page.waitForTimeout(150);
  expect(await journal(page)).toEqual(operations);
});
