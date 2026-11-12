import { test, expect } from "@playwright/test";
// Measure layout without sampling the intentional decorative dot translation.
test.use({ reducedMotion: "reduce" });
const viewports = [
  [360, 800],
  [390, 844],
  [430, 932],
  [600, 960],
  [820, 1180],
  [1024, 768],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
] as const;
for (const [width, height] of viewports) {
  test(`login and room fit ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const path of ["entry", "drawing"]) {
      if (path === "entry") {
        await page.goto("/");
        await expect(page.getByLabel("Your name")).toBeVisible();
      } else {
        await page.goto("/review/");
        await page.getByRole("button", { name: "Drawing · drawer" }).click();
        await expect(page.getByLabel("Drawing canvas")).toHaveAttribute("data-readonly", "false");
      }
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        fonts:
          document.fonts.check("600 24px Fredoka") &&
          document.fonts.check("400 16px Nunito"),
        overflow: [...document.querySelectorAll<HTMLElement>("main *")]
          .filter(
            (element) =>
              element.getClientRects().length &&
              !element.closest("svg") &&
              getComputedStyle(element).clip === "auto" &&
              getComputedStyle(element).overflowX !== "auto" &&
              getComputedStyle(element).overflowX !== "scroll" &&
              element.scrollWidth > element.clientWidth + 3,
          )
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            width: element.clientWidth,
            scroll: element.scrollWidth,
          })),
      }));
      expect(layout.scrollWidth, `${path}: page overflow`).toBeLessThanOrEqual(
        width,
      );
      expect(layout.overflow, `${path}: clipped nested content`).toEqual([]);
      expect(layout.fonts).toBe(true);
      if (path === "drawing" && width >= 1100) {
        const toolbar = await page.locator(".room-tools").boundingBox();
        expect(
          toolbar!.y + toolbar!.height,
          "canvas tools should fit with the canvas",
        ).toBeLessThanOrEqual(height);
      }
      if (path === "drawing" && width <= 820) {
        const positions = await page.evaluate(() => {
          const bottom = (selector: string) => {
            const element = document.querySelector(selector);
            return element?.getBoundingClientRect().bottom ?? null;
          };
          const top = (selector: string) => {
            const element = document.querySelector(selector);
            return element?.getBoundingClientRect().top ?? null;
          };
          return {
            drawingBottom: bottom(".room-drawing"),
            chatTop: top("[data-testid='room-chat']"),
            chatBottom: bottom("[data-testid='room-chat']"),
            teamsTop: top(".room-teams"),
            aiTop: top(".room-ai"),
          };
        });
        expect(positions.chatTop, "chat should follow the drawing").toBeGreaterThanOrEqual(positions.drawingBottom!);
        expect(positions.teamsTop, "roster should follow chat").toBeGreaterThanOrEqual(positions.chatBottom!);
        if (positions.aiTop !== null) {
          expect(positions.aiTop, "AI card should follow chat").toBeGreaterThanOrEqual(positions.chatBottom!);
        }
      }
    }
  });
}
