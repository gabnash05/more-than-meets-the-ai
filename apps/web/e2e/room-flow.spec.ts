import { expect, test } from "@playwright/test";

test("host lobby exposes defaults, blockers, and invite dialog", async ({ page }) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: "Lobby · host" }).click();
  await expect(page.getByText("Everyone vs AI")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Mode" })).toContainText("Individual");
  await page.getByRole("button", { name: /Room REVIEW/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Invite your crew");
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("copies the invite link when the Clipboard API is unavailable", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read"]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });
  await page.goto("/review/");
  await page.getByRole("button", { name: "Lobby · host" }).click();
  await page.getByRole("button", { name: /Room REVIEW/ }).click();
  const link = await page.getByRole("textbox", { name: "Room link" }).inputValue();
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Copied!", { exact: true })).toBeVisible();
  const copied = await page.evaluate(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    return navigator.clipboard.readText();
  });
  expect(copied).toBe(link);
});

test("team minimum and supplied individual result are visible", async ({ page }) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: "Team minimum blocker" }).click();
  await expect(page.locator(".room-settings").getByText("Team 2 needs two connected players.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Start match/ })).toBeDisabled();
  await page.goto("/review/");
  await page.getByRole("button", { name: "Result · correct" }).click();
  await expect(page.getByText("You got it!")).toBeVisible();
  await expect(page.locator(".room-recap-score")).toContainText(/Your round:\s*100 points/);
  await expect(page.getByText("Guess points: 100")).toBeVisible();
  await expect(page.getByText("Next drawer: You · 8s")).toBeVisible();
  await expect(page.getByText("Last submitted guess", { exact: true })).toBeVisible();
});

for (const width of [360, 820, 1440]) {
  test(`result is in normal flow and fully reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/review/");
    await page.getByRole("button", { name: "Result · correct" }).click();
    const result = page.getByLabel("Round recap");
    await expect(result).toBeVisible();
    await expect(result.getByText("Next drawer: You · 8s")).toBeVisible();
    const board = (await page.locator(".room-board").boundingBox())!;
    const recap = (await result.boundingBox())!;
    expect(Math.abs(recap.x - board.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(recap.width - board.width)).toBeLessThanOrEqual(1);
    await page.goto("/review/");
    await page.getByRole("button", { name: "Synthetic standings · eight and ties" }).click();
    const final = (await page.getByLabel("Final results").boundingBox())!;
    await expect(page.locator(".room-board")).toBeHidden();
    await expect(page.locator(".room-board canvas")).toHaveCount(1);
    await expect(page.locator(".room-board canvas")).toHaveAttribute("data-readonly", "true");
    expect(Math.abs(final.x - board.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(final.width - board.width)).toBeLessThanOrEqual(1);
    await page.goto("/review/");
    await page.getByRole("button", { name: "Result · correct" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await result.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
    await page.screenshot({ path: `../../.cache/results-corrections/recap-${width}.png`, fullPage: true });
  });
}

for (const [kind, recap, final] of [
  ["solved", "Solved · 75 points", "75 points · 1 / 1 rounds scored · 1 solved"],
  ["not solved", "Not solved · 0 points", "0 points · 1 / 1 rounds scored · 0 solved"],
  ["unavailable", "Unavailable", "Unavailable · 0 / 1 rounds scored · 0 solved"],
] as const) {
  test(`synthetic AI ${kind} recap and final coverage remain separate from humans`, async ({ page }) => {
    await page.goto("/review/");
    await page.getByRole("button", { name: `Synthetic AI recap · ${kind}` }).click();
    await expect(page.getByLabel("Round recap")).toContainText(`AI benchmark: ${recap}`);
    await page.goto("/review/");
    const finalKind = kind === "solved" ? "positive" : kind === "not solved" ? "zero" : "unavailable";
    await page.getByRole("button", { name: `Synthetic AI final · ${finalKind}` }).click();
    const overlay = page.getByLabel("Final results");
    await expect(overlay).toContainText(`AI benchmark: ${final}`);
    await expect(overlay).toContainText("Winners: You, Friend");
    await expect(overlay.locator("li")).toHaveCount(2);
  });
}

test("eight-player tied standings use competition ranks and avoid a nested scroll trap", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/review/");
  await page.getByRole("button", { name: "Synthetic standings · eight and ties" }).click();
  const results = page.getByLabel("Final results");
  const cards = results.locator(".room-rank-card");
  await expect(cards).toHaveCount(8);
  await expect(cards.nth(0)).toContainText("#1");
  await expect(cards.nth(1)).toContainText("#1");
  await expect(cards.nth(2)).toContainText("#3");
  await expect(cards.nth(0)).toContainText("You");
  await expect(results.getByRole("button", { name: "Return to lobby" })).toBeVisible();
  expect(await results.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "../../.cache/results-corrections/final-eight-390.png", fullPage: true });
});

test("all-zero standings share first and capped chat scrolls to the newest correct message", async ({ page }) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: "Synthetic standings · all zero" }).click();
  const ranks = page.getByLabel("Final results").locator(".room-rank");
  await expect(ranks).toHaveCount(3);
  for (const rank of await ranks.all()) await expect(rank).toHaveText("#1");
  await page.goto("/review/");
  await page.getByRole("button", { name: "Synthetic chat · 100 messages" }).click();
  const messages = page.locator(".room-lobby-chat .room-messages");
  await expect(messages.locator("p")).toHaveCount(100);
  await expect(messages).toContainText("latest message");
  await expect(messages).not.toContainText("secret-should-not-appear");
  const correct = messages.locator(".room-message-correct");
  await expect(correct).toContainText("Correct!");
  await expect(correct).toHaveCSS("color", "rgb(22, 101, 52)");
  await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
});

for (const count of [2, 4, 5, 6, 7]) {
  test(`synthetic ${count}-player standings show every player`, async ({ page }) => {
    await page.goto("/review/");
    await page.getByRole("button", { name: `Synthetic standings · ${count} players` }).click();
    await expect(page.getByLabel("Final results").locator(".room-rank-card")).toHaveCount(count);
  });
}

test("active capped chat follows a new last message without stealing focus", async ({ page }) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: "Synthetic active chat · 100 messages" }).click();
  const messages = page.getByTestId("room-chat").locator(".room-messages");
  await expect(messages.locator("p")).toHaveCount(100);
  await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
  await messages.evaluate(element => { element.scrollTop = 0; });
  const input = page.getByLabel("Your guess");
  await input.fill("newest guess");
  const pageY = await page.evaluate(() => window.scrollY);
  await input.press("Enter");
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(pageY);
  await expect(messages.locator("p")).toHaveCount(100);
  await expect(messages).toContainText("newest guess");
  await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
});

test("prompt exhaustion uses the server blocker and host capability", async ({ page }) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: "Synthetic exhaustion · interrupted host" }).click();
  await expect(page.getByText("Not enough unused prompts remain.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry round" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Return to lobby" })).toBeVisible();
  await page.goto("/review/");
  await page.getByRole("button", { name: "Synthetic exhaustion · interrupted guest" }).click();
  await expect(page.getByText("Not enough unused prompts remain.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Return to lobby" })).toHaveCount(0);
  await page.goto("/review/");
  await page.getByRole("button", { name: "Synthetic exhaustion · recap host" }).click();
  await expect(page.getByLabel("Round recap")).toContainText("Not enough unused prompts remain.");
  await expect(page.getByRole("button", { name: "Return to lobby" })).toBeVisible();
});

for (const width of [390, 1440]) {
  test(`leave actions have space and keyboard focus returns at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/review/");
    await page.getByRole("button", { name: "Lobby · host" }).click();
    const trigger = page.getByRole("button", { name: "Leave room" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    const leave = dialog.getByRole("button", { name: "Leave room" });
    const stay = dialog.getByRole("button", { name: "Stay" });
    await expect(leave).toBeVisible();
    const a = (await leave.boundingBox())!, b = (await stay.boundingBox())!;
    const separation = width <= 540 ? b.y - (a.y + a.height) : b.x - (a.x + a.width);
    expect(separation).toBeGreaterThanOrEqual(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Tab");
    await expect(dialog.locator(":focus")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

test("desktop final standings review screenshot", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/review/");
  await page.getByRole("button", { name: "Synthetic standings · eight and ties" }).click();
  await expect(page.getByLabel("Final results")).toBeVisible();
  await page.screenshot({ path: "../../.cache/results-corrections/final-eight-1440.png", fullPage: true });
});
