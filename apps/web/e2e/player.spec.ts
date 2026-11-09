import { test, expect } from "@playwright/test";

test("customization, creation and profile survive refresh", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Create a room/ }).click();
  await expect(page.locator(".player-error[role=alert]")).toContainText("1–24 characters");
  await page.getByLabel("Your name").fill("  Alex  ");
  await page.getByRole("combobox", { name: "Shape" }).click();
  await page.getByRole("option", { name: "Spark" }).click();
  await page.getByRole("combobox", { name: "Face" }).click();
  await page.getByRole("option", { name: "Wink" }).click();
  await page.getByRole("button", { name: "Purple character" }).click();
  await page.getByRole("button", { name: /Create a room/ }).click();
  await expect(page).toHaveURL(/\/room\/\?code=[A-Z0-9]{6}$/);
  await expect(page.getByText("Everyone vs AI")).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("mtmai.player.v1")!),
    ),
  ).toEqual({
    name: "Alex",
    avatar: { shape: "spark", expression: "wink", color: "purple" },
  });
  await page.reload();
  await expect(page.getByText("Everyone vs AI")).toBeVisible();
  await page.getByRole("button", { name: "Leave room" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Leave room" }).click();
  await expect(page.getByLabel("Your name")).toHaveValue("Alex");
  await expect(page.getByRole("combobox", { name: "Shape" })).toHaveText("Spark");
  await expect(page.getByRole("combobox", { name: "Face" })).toHaveText("Wink");
  await expect(
    page.getByRole("button", { name: "Purple character" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("direct room link retains its code through guest join", async ({
  page,
}) => {
  await page.goto("/review/");
  await page.getByRole("button", { name: "Lobby · host" }).click();
  await expect(page.getByText("Everyone vs AI")).toBeVisible();
  await page.goto("/?code=review");
  await expect(page).toHaveURL(/\/\?code=review$/i);
  await expect(page.locator(".player-invite")).toContainText("review");
  await page.getByLabel("Your name").fill("Sam");
  await page.getByRole("combobox", { name: "Shape" }).click();
  await page.getByRole("option", { name: "Cloud" }).click();
  await expect(page.locator(".player-invite")).toContainText("review");
  await page.getByRole("button", { name: "Join room →" }).click();
  await expect(page).toHaveURL(/\/room\/\?code=REVIEW$/);
  await expect(page.getByRole("button", { name: /Room REVIEW/ })).toBeVisible();
  await expect(page.getByText("Sam (you)")).toBeVisible();
});

test("reduced motion stops artwork animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const wrappers = page.locator(".player-bob");
  await expect(wrappers).toHaveCount(3);
  for (const wrapper of await wrappers.all())
    await expect(wrapper).toHaveCSS("animation-name", "none");
});
