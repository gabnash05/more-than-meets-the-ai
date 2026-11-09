import { expect, test } from "@playwright/test";

test("host can configure Guesser and Referee in the lobby", async ({ page }) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: "Lobby · host" }).click();
  const guesser = page.getByRole("checkbox", { name: "Enable AI Guesser" });
  const referee = page.getByRole("checkbox", { name: "Enable AI Referee" });
  await expect(guesser).toBeChecked();
  await expect(referee).toBeChecked();
  await guesser.uncheck();
  await expect(guesser).not.toBeChecked();
  await referee.uncheck();
  await expect(referee).not.toBeChecked();
  await expect(page.getByRole("button", { name: /Start match/ })).toBeEnabled();
});
