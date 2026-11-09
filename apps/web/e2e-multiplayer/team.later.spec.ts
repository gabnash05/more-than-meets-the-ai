import { expect, test, type Page } from "@playwright/test";

async function pixels(page: Page) {
  return page.getByLabel("Drawing canvas").evaluate(async (canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  });
}

test("four players share a target while team canvases remain private", async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [host, teamTwoDrawer, teamOneGuesser, teamTwoGuesser] = pages;
  await host.goto("http://127.0.0.1:3100/");
  await host.getByLabel("Your name").fill("Host");
  await host.getByRole("button", { name: /Create a room/ }).click();
  await expect(host).toHaveURL(/room\/\?code=/);
  const code = new URL(host.url()).searchParams.get("code")!;
  await host.getByRole("combobox", { name: "Mode" }).click();
  await host.getByRole("option", { name: "Team", exact: true }).click();
  for (const [index, page] of pages.slice(1).entries()) {
    await page.goto(`http://127.0.0.1:3100/?code=${code}`);
    await page.getByLabel("Your name").fill(`Player ${index + 2}`);
    await page.getByRole("button", { name: "Join room →" }).click();
    await expect(page).toHaveURL(/room\/\?code=/);
  }
  await expect(host.locator(".room-person")).toHaveCount(4);
  await host.getByRole("combobox", { name: "Prompt rounds" }).click();
  await host.getByRole("option", { name: "2 rounds", exact: true }).click();
  await host.getByRole("button", { name: /Start match/ }).first().click();
  for (let round = 0; round < 2; round++) {
    await expect.poll(async () => (await Promise.all(pages.map(page => page.getByRole("heading", { name: "Choose a word" }).count()))).reduce((a, b) => a + b, 0)).toBe(1);
    const chooser = round === 0 ? host : teamTwoGuesser;
    const choices = chooser.locator(".room-result-overlay button");
    await expect(choices).toHaveCount(3);
    const word = (await choices.first().textContent())!.trim();
    for (const page of pages.filter(page => page !== chooser)) await expect(page.locator(".room-result-overlay button")).toHaveCount(0);
    await choices.first().click();
    const drawers = round === 0 ? [host, teamTwoDrawer] : [teamOneGuesser, teamTwoGuesser];
    const guessers = round === 0 ? [teamOneGuesser, teamTwoGuesser] : [host, teamTwoDrawer];
    for (const drawer of drawers) {
      await expect(drawer.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
      await expect(drawer.locator(".room-prompt")).toContainText(word);
    }
    for (const guesser of guessers) await expect(guesser.locator(".room-prompt")).not.toContainText(word);
    if (round === 0) {
      const blankOther = await pixels(drawers[1]);
      const box = (await drawers[0].getByLabel("Drawing canvas").boundingBox())!;
      await drawers[0].mouse.move(box.x + box.width * .2, box.y + box.height * .2); await drawers[0].mouse.down();
      await drawers[0].mouse.move(box.x + box.width * .5, box.y + box.height * .5, { steps: 10 }); await drawers[0].mouse.up();
      await expect.poll(() => pixels(guessers[0])).toEqual(await pixels(drawers[0]));
      expect(await pixels(drawers[1])).toEqual(blankOther);
      expect(await pixels(guessers[1])).toEqual(blankOther);
      await drawers[0].screenshot({ path: ".cache/verification/team-drawing-desktop.png" });
    }
    await guessers[0].getByLabel("Your guess").fill(word);
    await guessers[0].getByLabel("Your guess").press("Enter");
    await expect(drawers[0].getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "true");
    await expect(drawers[0].getByText("Your team has finished. Waiting for the other teams.")).toBeVisible();
    await expect(drawers[1].getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
    await guessers[1].getByLabel("Your guess").fill(word);
    await guessers[1].getByLabel("Your guess").press("Enter");
  }
  for (const page of pages) await expect(page.getByRole("heading", { name: "Final standings" })).toBeVisible();
  await expect(host.getByLabel("Final results")).toContainText("Team 1");
  await expect(host.getByLabel("Final results")).toContainText("Team 2");
  await host.getByRole("button", { name: "Return to lobby" }).click();
  await expect(teamTwoGuesser.getByText("Get the crew together.")).toBeVisible();
  await Promise.all(contexts.map(context => context.close()));
});
