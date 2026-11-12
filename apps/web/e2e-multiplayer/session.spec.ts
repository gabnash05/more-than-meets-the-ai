import { expect, test, type Page } from "@playwright/test";

async function pixels(page: Page) {
  return page.getByLabel("Drawing canvas").evaluate(async (canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  });
}

test("two players choose privately, share ink, restore, finish and return", async ({ browser }) => {
  const hostContext = await browser.newContext(), guestContext = await browser.newContext();
  const host = await hostContext.newPage(), guest = await guestContext.newPage();
  await host.goto("/");
  await host.getByLabel("Your name").fill("Alex");
  await host.getByRole("button", { name: /Create a room/ }).click();
  await expect(host).toHaveURL(/room\/\?code=/);
  const code = new URL(host.url()).searchParams.get("code")!;
  await guest.goto(`/?code=${code}`);
  await guest.getByLabel("Your name").fill("Bea");
  await guest.getByRole("button", { name: "Join room →" }).click();
  await expect(host.getByText("Bea", { exact: true })).toBeVisible();
  await host.getByRole("combobox", { name: "Prompt rounds" }).click();
  await host.getByRole("option", { name: "2 rounds", exact: true }).click();
  await host.getByRole("button", { name: /Start match/ }).first().click();
  await Promise.all([host, guest].map(page => expect(page.getByLabel("Match countdown")).toBeVisible()));
  const words: string[] = [];
  for (let round = 0; round < 2; round++) {
    await expect.poll(async () => (await host.getByRole("heading", { name: "Choose a word" }).count()) + (await guest.getByRole("heading", { name: "Choose a word" }).count())).toBe(1);
    const drawer = await host.getByRole("heading", { name: "Choose a word" }).isVisible() ? host : guest;
    const guesser = drawer === host ? guest : host;
    const choices = drawer.locator(".room-result-overlay button");
    await expect(choices).toHaveCount(3);
    const word = (await choices.first().textContent())!.trim();
    words.push(word);
    for (const text of await choices.allTextContents()) await expect(guesser.locator(".room-result-overlay")).not.toContainText(text);
    const boardBox = (await drawer.locator(".room-board").boundingBox())!;
    const overlayBox = (await drawer.locator(".room-result-overlay").boundingBox())!;
    expect(overlayBox.x).toBeGreaterThanOrEqual(boardBox.x);
    expect(overlayBox.x + overlayBox.width).toBeLessThanOrEqual(boardBox.x + boardBox.width);
    if (round === 0) await drawer.screenshot({ path: ".cache/verification/choosing-desktop.png" });
    await choices.first().focus();
    await drawer.keyboard.press("Enter");
    await expect(drawer.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
    if (round === 0) {
      await drawer.screenshot({ path: ".cache/verification/drawing-desktop.png" });
      const box = (await drawer.getByLabel("Drawing canvas").boundingBox())!;
      const blank = await pixels(guesser);
      await drawer.mouse.move(box.x + box.width * .2, box.y + box.height * .2);
      await drawer.mouse.down();
      await drawer.mouse.move(box.x + box.width * .6, box.y + box.height * .6, { steps: 12 });
      await expect.poll(() => pixels(guesser)).not.toEqual(blank);
      await drawer.mouse.up();
      await expect.poll(() => pixels(guesser)).toEqual(await pixels(drawer));
      const before = await pixels(drawer);
      await guesser.reload();
      await expect(guesser.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "true");
      await expect.poll(() => pixels(guesser)).toEqual(before);
      await expect(guesser.locator(".room-person")).toHaveCount(2);
      await drawer.reload();
      await expect(drawer.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
      await expect.poll(() => pixels(drawer)).toEqual(before);
      await expect(drawer.locator(".room-person")).toHaveCount(2);
      const restoredBox = (await drawer.getByLabel("Drawing canvas").boundingBox())!;
      await drawer.mouse.move(restoredBox.x + restoredBox.width * .7, restoredBox.y + restoredBox.height * .2);
      await drawer.mouse.down();
      await drawer.mouse.move(restoredBox.x + restoredBox.width * .8, restoredBox.y + restoredBox.height * .6, { steps: 8 });
      await drawer.mouse.up();
      await expect.poll(() => pixels(guesser)).toEqual(await pixels(drawer));
      expect(await pixels(drawer)).not.toEqual(before);
    }
    await guesser.getByLabel("Your guess").fill(word);
    await guesser.getByLabel("Your guess").press("Enter");
    if (round === 0) await expect(host.getByText("Round complete", { exact: true }).first()).toBeVisible();
  }
  await expect(host.getByRole("heading", { name: "Final standings" })).toBeVisible();
  await expect(guest.getByRole("heading", { name: "Final standings" })).toBeVisible();
  const checkHistory = async (page: Page) => {
    const history = page.locator(".room-ai-history");
    await expect(history.locator(":scope > summary")).toHaveText("Completed-round AI history (2)");
    await history.locator(":scope > summary").click();
    const entries = history.locator(":scope > details");
    await expect(entries).toHaveCount(2);
    for (const [index, word] of words.entries()) {
      const entry = entries.nth(index);
      await expect(entry.locator("summary")).toContainText(`Round ${index + 1}`);
      await expect(entry.locator("summary")).toContainText(word);
      await expect(entry.locator("summary")).toContainText("Unavailable");
      await entry.locator("summary").click();
      await expect(entry.getByText("No recorded predictions")).toBeVisible();
    }
  };
  await checkHistory(host);
  await host.reload();
  await expect(host.getByRole("heading", { name: "Final standings" })).toBeVisible();
  await checkHistory(host);
  await host.screenshot({ path: ".cache/verification/final-desktop.png" });
  await guest.setViewportSize({ width: 360, height: 800 });
  const finalResults = guest.getByLabel("Final results");
  await expect(finalResults).toBeVisible();
  await expect(guest.locator(".room-board")).toBeHidden();
  expect(await finalResults.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
  expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await guest.screenshot({ path: ".cache/verification/final-phone.png" });
  await host.getByRole("button", { name: "Return to lobby" }).click();
  await expect(guest.getByText("Get the crew together.")).toBeVisible();
  await expect(host.locator(".room-person")).toHaveCount(2);
  await expect(host.locator(".room-person b").filter({ hasText: "0 pts" })).toHaveCount(2);
  await host.getByRole("button", { name: /Start match/ }).first().click();
  await expect(host.getByRole("heading", { name: "Round 1 / 2" })).toBeVisible();
  await expect.poll(async () => (await host.getByRole("heading", { name: "Choose a word" }).count()) + (await guest.getByRole("heading", { name: "Choose a word" }).count())).toBe(1);
  const nextDrawer = await host.getByRole("heading", { name: "Choose a word" }).isVisible() ? host : guest;
  const nextGuesser = nextDrawer === host ? guest : host;
  const nextChoices = nextDrawer.locator(".room-result-overlay button");
  await expect(nextChoices).toHaveCount(3);
  for (const word of await nextChoices.allTextContents()) await expect(nextGuesser.locator(".room-result-overlay")).not.toContainText(word);
  await nextChoices.first().click();
  await expect(nextDrawer.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
  const empty = await nextDrawer.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 1024; canvas.height = 768;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  });
  await expect.poll(() => pixels(nextDrawer)).toEqual(empty);
  await expect.poll(() => pixels(nextGuesser)).toEqual(empty);
  await hostContext.close(); await guestContext.close();
});

test("word choice fits a narrow viewport and works with the keyboard", async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage(), guest = await guestContext.newPage();
  await host.goto("/");
  await host.getByLabel("Your name").fill("Mobile");
  await host.getByRole("button", { name: /Create a room/ }).click();
  await expect(host).toHaveURL(/room\/\?code=/);
  const code = new URL(host.url()).searchParams.get("code")!;
  await guest.goto(`/?code=${code}`);
  await guest.getByLabel("Your name").fill("Guest");
  await guest.getByRole("button", { name: "Join room →" }).click();
  await expect(host.getByText("Guest", { exact: true })).toBeVisible();
  await host.locator(".room-mobile-start").getByRole("button", { name: /Start match/ }).click();
  const picker = host.locator(".room-result-overlay");
  await expect(picker.getByRole("heading", { name: "Choose a word" })).toBeVisible();
  await expect(picker.getByRole("button")).toHaveCount(3);
  const boardBox = (await host.locator(".room-board").boundingBox())!, pickerBox = (await picker.boundingBox())!;
  expect(pickerBox.x).toBeGreaterThanOrEqual(boardBox.x);
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(boardBox.x + boardBox.width);
  expect(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await host.screenshot({ path: ".cache/verification/choosing-phone.png" });
  await picker.getByRole("button").first().focus();
  await host.keyboard.press("Enter");
  await expect(host.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
  await hostContext.close(); await guestContext.close();
});

test("drawing tools replay to a second browser and survive refresh", async ({ browser }) => {
  const hostContext = await browser.newContext(), guestContext = await browser.newContext();
  const host = await hostContext.newPage(), guest = await guestContext.newPage();
  await host.goto("/");
  await host.getByLabel("Your name").fill("Artist");
  await host.getByRole("button", { name: /Create a room/ }).click();
  await expect(host).toHaveURL(/room\/\?code=/);
  const code = new URL(host.url()).searchParams.get("code")!;
  await guest.goto(`/?code=${code}`);
  await guest.getByLabel("Your name").fill("Viewer");
  await guest.getByRole("button", { name: "Join room →" }).click();
  await expect(host.getByText("Viewer", { exact: true })).toBeVisible();
  await host.getByRole("button", { name: /Start match/ }).first().click();
  await host.locator(".room-result-overlay button").first().click();
  const canvas = host.getByLabel("Drawing canvas");
  await expect(canvas).toHaveAttribute("data-readonly", "false");
  const box = (await canvas.boundingBox())!;
  const pos = (x: number, y: number) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  async function parityChanged(previous: number[]) {
    await expect.poll(() => pixels(host)).not.toEqual(previous);
    await expect.poll(() => pixels(guest)).toEqual(await pixels(host));
    return pixels(host);
  }
  let last = await pixels(host);
  const corners = [pos(.2, .2), pos(.7, .2), pos(.7, .7), pos(.2, .7), pos(.2, .2)];
  await host.mouse.move(corners[0].x, corners[0].y); await host.mouse.down();
  for (const corner of corners.slice(1)) await host.mouse.move(corner.x, corner.y, { steps: 8 });
  await host.mouse.up(); last = await parityChanged(last);
  await host.getByRole("button", { name: "fill", exact: true }).click();
  await host.getByRole("button", { name: "Color #FF4343" }).click();
  const center = pos(.4, .4); await host.mouse.click(center.x, center.y);
  last = await parityChanged(last);
  await host.getByRole("button", { name: "eraser", exact: true }).click();
  await host.mouse.click(center.x, center.y); last = await parityChanged(last);
  await host.getByRole("button", { name: "Undo", exact: true }).click(); last = await parityChanged(last);
  await host.getByRole("button", { name: "Redo", exact: true }).click(); last = await parityChanged(last);
  await host.setViewportSize({ width: 900, height: 700 });
  await guest.setViewportSize({ width: 820, height: 1180 });
  await expect.poll(() => pixels(host)).toEqual(last);
  await expect.poll(() => pixels(guest)).toEqual(last);
  await guest.reload();
  await expect(guest.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "true");
  await expect.poll(() => pixels(guest)).toEqual(last);
  await host.reload();
  await expect(host.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
  await expect.poll(() => pixels(host)).toEqual(last);
  await expect(host.locator(".room-person")).toHaveCount(2);
  await host.getByRole("button", { name: "Clear", exact: true }).click(); last = await parityChanged(last);
  await guest.reload();
  await expect(guest.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "true");
  await expect.poll(() => pixels(guest)).toEqual(last);
  await hostContext.close(); await guestContext.close();
});


test("individual guesses remain independent and AI coverage is honest", async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext()));
  for (const context of contexts) await context.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    class DelayedSocket extends NativeSocket {
      private sendQueue = Promise.resolve();
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const delay = typeof data === "string" && data.includes('"room:guess"') ? 300 : 0;
        if (delay) (window as Window & { guessSends?: number }).guessSends = ((window as Window & { guessSends?: number }).guessSends ?? 0) + 1;
        // Serialize all sends so test-only delay never changes packet order.
        this.sendQueue = this.sendQueue.then(() => new Promise<void>(resolve => {
          setTimeout(() => { super.send(data); resolve(); }, delay);
        }));
      }
    }
    window.WebSocket = DelayedSocket;
  });
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [host, ...guests] = pages;
  await host.goto("/");
  await host.getByLabel("Your name").fill("Host");
  await host.getByRole("button", { name: /Create a room/ }).click();
  await expect(host).toHaveURL(/room\/\?code=/);
  const code = new URL(host.url()).searchParams.get("code")!;
  await host.getByRole("combobox", { name: "Mode" }).click();
  await expect(host.getByRole("option", { name: "Team (coming later)" })).toHaveAttribute("data-disabled", "");
  await host.keyboard.press("Escape");
  // Save the fixture's settings before guest connections change room revisions.
  // Roster admission alone does not mean their socket/resync work has settled.
  await host.getByRole("combobox", { name: "Prompt rounds" }).click();
  await host.getByRole("option", { name: "1 rounds", exact: true }).click();
  await expect(host.getByRole("combobox", { name: "Prompt rounds" })).toContainText("1 rounds");
  for (const [index, guest] of guests.entries()) {
    await guest.goto(`/?code=${code}`);
    await guest.getByLabel("Your name").fill(`Guest ${index + 1}`);
    await guest.getByRole("button", { name: "Join room →" }).click();
  }
  await expect(host.locator(".room-person")).toHaveCount(3);
  await host.getByRole("button", { name: /Start match/ }).first().click();
  await expect(host.getByRole("heading", { name: "Round 1 / 1" })).toBeVisible();
  await expect.poll(async () => (await Promise.all(pages.map(page => page.getByRole("heading", { name: "Choose a word" }).count()))).reduce((a, b) => a + b, 0)).toBe(1);
  const chooser = (await Promise.all(pages.map(page => page.getByRole("heading", { name: "Choose a word" }).isVisible()))).findIndex(Boolean);
  const drawer = pages[chooser];
  const guessers = pages.filter(page => page !== drawer);
  const choices = drawer.locator(".room-result-overlay button");
  const word = (await choices.first().textContent())!.trim();
  for (const guesser of guessers) await expect(guesser.locator(".room-prompt")).not.toContainText(word);
  await choices.first().click();
  const input = guessers[0].getByLabel("Your guess");
  await input.fill("incorrect draft");
  await input.press("Enter");
  await expect(guessers[0].locator(".room-feedback")).toContainText("Checking your guess");
  await expect(guessers[0].locator(".room-feedback")).not.toContainText("Correct!");
  await input.fill(word);
  await input.press("Enter");
  await expect(guessers[0].getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(input).toHaveValue(word);
  expect(await guessers[0].evaluate(() => (window as Window & { guessSends?: number }).guessSends)).toBe(1);
  await input.press("Enter");
  await expect(guessers[0].locator(".room-feedback")).toContainText("Correct! The others are still guessing");
  await expect(guessers[0].locator(".room-feedback")).not.toContainText(word);
  const correct = guessers[1].getByTestId("room-chat").locator(".room-message-correct");
  await expect(correct).toContainText("Correct!");
  await expect(correct).toHaveCSS("color", "rgb(22, 101, 52)");
  await expect(correct).toContainText("✓");
  await expect(guessers[1].getByTestId("room-chat")).not.toContainText(word);
  await expect(guessers[1].getByLabel("Your guess")).toBeEnabled();
  await expect(drawer.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
  await guessers[1].getByLabel("Your guess").fill(word);
  await guessers[1].getByLabel("Your guess").press("Enter");
  await expect(host.getByLabel("Round recap")).toContainText("Final standings");
  await expect(host.getByLabel("Round recap")).not.toContainText("Next drawer: Waiting");
  await expect(host.getByText("AI benchmark: Unavailable")).toBeVisible();
  await expect(host.getByRole("heading", { name: "Final standings" })).toBeVisible();
  await expect(host.getByLabel("Final results")).toContainText("0 / 1 rounds scored");
  await Promise.all(contexts.map(context => context.close()));
});

test("simultaneous last-seat joins admit only one guest", async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [host, ...guests] = pages;
  await host.goto("/");
  await host.getByLabel("Your name").fill("Host");
  await host.getByRole("button", { name: /Create a room/ }).click();
  await expect(host).toHaveURL(/room\/\?code=/);
  const code = new URL(host.url()).searchParams.get("code")!;
  await host.getByRole("combobox", { name: "Player seats" }).click();
  await host.getByRole("option", { name: "2 seats", exact: true }).click();
  await Promise.all(guests.map(async (page, index) => {
    await page.goto(`/?code=${code}`);
    await page.getByLabel("Your name").fill(`Guest ${index + 1}`);
  }));
  await Promise.all(guests.map(page => page.getByRole("button", { name: "Join room →" }).click()));
  await expect.poll(() => guests.filter(page => /room\/\?code=/.test(page.url())).length).toBe(1);
  await expect(host.locator(".room-person")).toHaveCount(2);
  const rejected = guests.find(page => !/room\/\?code=/.test(page.url()))!;
  await expect(rejected.getByText("Room is full.")).toBeVisible();
  await Promise.all(contexts.map(context => context.close()));
});

test("host can leave an active match and transfer hosting", async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [host, ...guests] = pages;
  await host.goto("/");
  await host.getByLabel("Your name").fill("Host");
  await host.getByRole("button", { name: /Create a room/ }).click();
  await expect(host).toHaveURL(/room\/\?code=/);
  const code = new URL(host.url()).searchParams.get("code")!;
  for (const [index, guest] of guests.entries()) {
    await guest.goto(`/?code=${code}`);
    await guest.getByLabel("Your name").fill(`Guest ${index + 1}`);
    await guest.getByRole("button", { name: "Join room →" }).click();
  }
  await expect(host.locator(".room-person")).toHaveCount(3);
  await host.getByRole("button", { name: /Start match/ }).first().click();
  await expect.poll(async () => (await Promise.all(pages.map(page => page.getByRole("heading", { name: "Choose a word" }).count()))).reduce((a, b) => a + b, 0)).toBe(1);
  await host.getByRole("button", { name: "Leave room" }).click();
  await host.getByRole("dialog").getByRole("button", { name: "Leave room" }).click();
  await expect(host).toHaveURL(/\/$/);
  await expect(guests[0].locator(".room-person")).toHaveCount(3);
  await expect(guests[0].locator(".room-person").filter({ hasText: "Host" }).filter({ hasText: "Disconnected" })).toBeVisible();
  await expect.poll(async () => (await Promise.all(guests.map(page => page.locator(".room-person").filter({ hasText: "Guest" }).locator("small").filter({ hasText: "Host ·" }).count()))).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  await Promise.all(contexts.map(context => context.close()));
});

test("a disconnected player restores the same seat and drawing", async ({ browser }) => {
  const hostContext = await browser.newContext(), guestContext = await browser.newContext();
  const host = await hostContext.newPage(), guest = await guestContext.newPage();
  await host.goto("/");
  await host.getByLabel("Your name").fill("Host");
  await host.getByRole("button", { name: /Create a room/ }).click();
  await expect(host).toHaveURL(/room\/\?code=/);
  const code = new URL(host.url()).searchParams.get("code")!;
  await guest.goto(`/?code=${code}`);
  await guest.getByLabel("Your name").fill("Guest");
  await guest.getByRole("button", { name: "Join room →" }).click();
  await expect(host.locator(".room-person")).toHaveCount(2);
  await host.getByRole("button", { name: /Start match/ }).first().click();
  await expect.poll(async () => (await host.getByRole("heading", { name: "Choose a word" }).count()) + (await guest.getByRole("heading", { name: "Choose a word" }).count())).toBe(1);
  const drawer = await host.getByRole("heading", { name: "Choose a word" }).isVisible() ? host : guest;
  const viewer = drawer === host ? guest : host;
  const viewerContext = drawer === host ? guestContext : hostContext;
  await drawer.locator(".room-result-overlay button").first().click();
  await expect(drawer.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
  const blank = await pixels(viewer);
  const box = (await drawer.getByLabel("Drawing canvas").boundingBox())!;
  await drawer.mouse.move(box.x + box.width * .2, box.y + box.height * .2);
  await drawer.mouse.down();
  await drawer.mouse.move(box.x + box.width * .5, box.y + box.height * .5, { steps: 10 });
  await drawer.mouse.up();
  await expect.poll(() => pixels(viewer)).not.toEqual(blank);
  await expect.poll(() => pixels(viewer)).toEqual(await pixels(drawer));
  const before = await pixels(drawer);
  await viewerContext.setOffline(true);
  await expect(viewer.getByText(/Connection interrupted|Restoring your room/)).toBeVisible();
  await viewerContext.setOffline(false);
  const retry = viewer.getByRole("button", { name: "Retry" });
  if (await retry.isVisible()) await retry.click();
  await expect.poll(() => pixels(viewer)).toEqual(before);
  await expect(viewer.locator(".room-person")).toHaveCount(2);
  await expect(drawer.locator(".room-person")).toHaveCount(2);
  await hostContext.close();
  await guestContext.close();
});
