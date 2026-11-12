import { expect, test } from "@playwright/test";

test("desktop guesser focuses once and result chat stays available", async ({ page }) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: /^Drawing.*guesser$/ }).click();
  await expect(page.getByRole("textbox", { name: "Your guess", exact: true })).toBeFocused();
  await page.getByRole("button", { name: /Room REVIEW/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: /Room REVIEW/ })).toBeFocused();
  await page.goto("/review/");
  await page.getByRole("button", { name: /^Result.*missed$/ }).click();
  const composer = page.getByRole("textbox", { name: "Message the room", exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill("next round please");
  await composer.press("Enter");
  await expect(page.getByTestId("room-chat")).toContainText("next round please");
});

test("phone canvas and composer stay visible without automatic keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/review/");
  await page.getByRole("button", { name: /^Drawing.*guesser$/ }).click();
  const input = page.getByRole("textbox", { name: "Your guess", exact: true });
  await expect(input).not.toBeFocused();
  const canvas = page.getByTestId("drawing-canvas");
  await expect(canvas).toHaveCSS("touch-action", "pan-y pinch-zoom");
  const [board, composer] = await Promise.all([canvas.boundingBox(), input.boundingBox()]);
  expect(board!.y).toBeGreaterThanOrEqual(0);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(844);
});

test("final history reuses the complete prediction view", async ({ page }) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: /^Synthetic AI final.*zero$/ }).click();
  await expect(page).toHaveURL(/\/room\/\?code=REVIEW$/);
  await page.getByText("Completed-round AI history (1)", { exact: true }).click();
  await page.locator(".room-ai-history details summary").click();
  await expect(page.getByRole("list", { name: "All AI predictions" })).toBeVisible();
  await expect(page.getByText("Not submitted - low confidence", { exact: true })).toBeVisible();
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const history = page.getByRole("list", { name: "All AI predictions" });
    await expect.poll(() => history.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
    const listBox = (await history.boundingBox())!;
    const reasonBox = (await page.getByText("Not submitted - low confidence", { exact: true }).boundingBox())!;
    expect(reasonBox.y).toBeGreaterThanOrEqual(listBox.y);
    expect(reasonBox.y + reasonBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 360) await page.locator(".room-ai-history").screenshot({ path: "../../.cache/game-ux-ai-fairness/history-readable-360.png" });
  }
});

test("local countdown precedes word selection and runs once", async ({ page }) => {
  await page.clock.install();
  await page.goto("/review/");
  await page.getByRole("button", { name: /^Lobby.*host$/ }).click();
  await page.getByRole("button", { name: /^Start match/ }).first().click();
  await expect(page.getByRole("heading", { name: "Get ready!" })).toBeVisible();
  await expect(page.getByRole("button", { name: "cat (local demo)", exact: true })).toHaveCount(0);
  await page.clock.fastForward(3000);
  await page.getByRole("button", { name: "cat (local demo)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Get ready!" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message the room", exact: true })).toBeDisabled();
});

test("viewport keyboard collapse retains draft and visible canvas", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/review/");
  await page.getByRole("button", { name: /^Drawing.*guesser$/ }).click();
  const input = page.getByRole("textbox", { name: "Your guess", exact: true });
  await input.fill("my unfinished guess");
  await input.evaluate(element => { element.dataset.originalComposer = "true"; });
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 430 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator(".room-screen")).toHaveClass(/keyboard-open/);
  await expect(input).toHaveAttribute("data-original-composer", "true");
  await expect(input).toHaveValue("my unfinished guess");
  await expect(page.locator(".room-teams")).toBeHidden();
  const canvas = await page.getByTestId("drawing-canvas").boundingBox();
  const composer = await input.boundingBox();
  expect(canvas!.height).toBeGreaterThan(80);
  expect(canvas!.y).toBeGreaterThanOrEqual(0);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(430);
});


test("local closing chat rejects the secret but accepts general conversation", async ({ page }) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: /^Drawing.*drawer$/ }).click();
  await expect(page.getByTestId("drawing-canvas")).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("more-than-meets-room-demo", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("rooms", "readwrite");
      const store = transaction.objectStore("rooms");
      const get = store.get("REVIEW");
      get.onsuccess = () => {
        const room = get.result;
        room.snapshot.game.closing = true;
        store.put(room, "REVIEW");
      };
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
  await page.reload();
  const input = page.getByRole("textbox", { name: "Message the room", exact: true });
  await expect(input).toBeEnabled();
  await input.fill("It is CAT");
  await input.press("Enter");
  await expect(page.locator(".room-error[role=alert]")).toContainText("That message contains the answer");
  await input.fill("good round everyone");
  await input.press("Enter");
  await expect(page.getByTestId("room-chat")).toContainText("good round everyone");
});
