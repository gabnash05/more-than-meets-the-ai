import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

const labels = [
  "cat",
  "dog",
  ...Array.from({ length: 343 }, (_, index) => `drawing ${index + 3}`),
];
const heatmap = {
  grid: Array.from({ length: 196 }, (_, index) =>
    index % 14 === 7 ? 255 : 12,
  ),
  frame: { x: 0, y: 0, width: 1024, height: 768 },
  content: { x: 0, y: 0, width: 1024, height: 768 },
};

async function mockFreeDraw(
  page: Page,
  confidence: number | number[] = 0.5,
  answer = "cat",
) {
  let guessCount = 0;
  await page.route("**/api/free-draw/sessions/current", async (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.route("**/api/free-draw/sessions", async (route) =>
    route.fulfill({
      json: {
        sessionId: "free-draw-e2e",
        token: "e2e-token",
        capabilities: {
          guesser: { available: true, labels },
          referee: { available: true },
          minIntervalMs: 3000,
        },
      },
    }),
  );
  await page.route("**/api/free-draw/capabilities", async (route) =>
    route.fulfill({
      json: {
        guesser: { available: true, labels },
        referee: { available: true },
        minIntervalMs: 3000,
      },
    }),
  );
  await page.route("**/api/free-draw/infer", async (route) => {
    const observation = JSON.parse(
      route.request().headers()["x-free-draw-observation"] ?? "{}",
    ) as {
      runId: string;
      revision: number;
      requestId: string;
      roles: string[];
    };
    const outcomes: Record<string, unknown> = {};
    if (observation.roles.includes("guesser")) {
      const selectedConfidence = Array.isArray(confidence)
        ? confidence[Math.min(guessCount, confidence.length - 1)]
        : confidence;
      guessCount += 1;
      outcomes.guesser = {
        status: "answer",
        answer,
        confidence: selectedConfidence,
        heatmap,
      };
    }
    if (observation.roles.includes("referee"))
      outcomes.referee = { status: "evidence", scores: [0, 0] };
    await route.fulfill({
      json: { ...observation, sessionId: "free-draw-e2e", outcomes },
    });
  });
}

async function drawStroke(page: Page) {
  const canvas = page.getByTestId("drawing-canvas");
  await expect.poll(() => canvas.getAttribute("data-ready")).toBe("true");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Drawing canvas has no visible bounds");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.54, {
    steps: 8,
  });
  await page.mouse.up();
}

test("Free Draw opens without a profile and selects a searchable prompt by keyboard", async ({
  page,
}) => {
  await mockFreeDraw(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Start drawing/ })).toBeVisible();
  await page.getByRole("link", { name: /Start drawing/ }).click();
  await expect(page).toHaveURL(/\/free-draw\/$/);
  await expect(
    page.getByRole("heading", { name: "Make your mark." }),
  ).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveCount(0);
  await page.getByRole("button", { name: "Choose a prompt" }).click();
  const prompt = page.getByRole("combobox", { name: "Choose a prompt" });
  await prompt.fill("ca");
  await prompt.press("ArrowDown");
  await prompt.press("Enter");
  await expect(page.getByText("Prompt: cat")).toBeVisible();
});

test("threshold status, independent insight toggles, draft restore, and clear controls", async ({
  page,
}) => {
  await mockFreeDraw(page, 0.5, "cat");
  await page.goto("/free-draw/");
  await expect(
    page.getByRole("button", { name: "Guesser On" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Heatmap Off" }).click();
  await expect(
    page.getByRole("button", { name: "Guesser On" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Heatmap On" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Guesser On" }).click();
  await expect(
    page.getByRole("button", { name: "Heatmap On" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Guesser Off" }).click();
  await drawStroke(page);
  await expect(
    page.getByRole("listitem").filter({ hasText: "Below threshold" }),
  ).toBeVisible({ timeout: 12000 });
  await expect(page.getByText("50%", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Where the AI looked — attention, not its reasoning."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Clear history" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Restart Guesser" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByText("No predictions yet")).toBeVisible();

  const canvas = page.getByTestId("drawing-canvas");
  const inkCount = async (element: Locator) =>
    element.evaluate((node) => {
      const source = node as HTMLCanvasElement;
      const sample = document.createElement("canvas");
      sample.width = 64;
      sample.height = 48;
      const context = sample.getContext("2d");
      if (!context) return 0;
      context.fillStyle = "white";
      context.fillRect(0, 0, sample.width, sample.height);
      context.drawImage(source, 0, 0, sample.width, sample.height);
      const pixels = context.getImageData(
        0,
        0,
        sample.width,
        sample.height,
      ).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4)
        if (
          pixels[index] < 245 ||
          pixels[index + 1] < 245 ||
          pixels[index + 2] < 245
        )
          count += 1;
      return count;
    });
  await expect.poll(() => inkCount(canvas)).toBeGreaterThan(0);
  const inkBeforeReload = await inkCount(canvas);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const request = indexedDB.open("mmtai-free-draw", 1);
            request.onsuccess = () => {
              const db = request.result;
              const get = db
                .transaction("current")
                .objectStore("current")
                .get("snapshot");
              get.onsuccess = async () => {
                const blob = get.result?.bitmap as Blob | undefined;
                db.close();
                if (!blob) {
                  resolve(0);
                  return;
                }
                const image = await createImageBitmap(blob);
                const sample = document.createElement("canvas");
                sample.width = 64;
                sample.height = 48;
                const context = sample.getContext("2d")!;
                context.fillStyle = "white";
                context.fillRect(0, 0, 64, 48);
                context.drawImage(image, 0, 0, 64, 48);
                image.close();
                const pixels = context.getImageData(0, 0, 64, 48).data;
                let count = 0;
                for (let i = 0; i < pixels.length; i += 4)
                  if (
                    pixels[i] < 245 ||
                    pixels[i + 1] < 245 ||
                    pixels[i + 2] < 245
                  )
                    count++;
                resolve(count);
              };
              get.onerror = () => {
                resolve(0);
                db.close();
              };
            };
            request.onerror = () => resolve(0);
          }),
      ),
    )
    .toBe(inkBeforeReload);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Guesser Off" }),
  ).toHaveAttribute("aria-pressed", "false");
  const restored = page.getByTestId("drawing-canvas");
  await expect.poll(() => restored.getAttribute("data-ready")).toBe("true");
  await expect.poll(() => inkCount(restored)).toBe(inkBeforeReload);
});

test("repeat predictions retain order; exact 50% does not solve, above 50% does", async ({
  page,
}) => {
  await mockFreeDraw(page, [0.5, 0.81, 0.74], "cat");
  await page.goto("/free-draw/");
  await page.getByRole("button", { name: "Choose a prompt" }).click();
  const prompt = page.getByRole("combobox", { name: "Choose a prompt" });
  await prompt.fill("cat");
  await prompt.press("ArrowDown");
  await prompt.press("Enter");
  await drawStroke(page);
  await expect(
    page.getByRole("listitem").filter({ hasText: "Below threshold" }),
  ).toBeVisible({ timeout: 12000 });
  await expect(
    page.getByText("Guessed it! Your drawing is still open."),
  ).toHaveCount(0);
  await drawStroke(page);
  await expect(
    page.getByRole("listitem").filter({ hasText: "Correct" }),
  ).toBeVisible({ timeout: 12000 });
  await expect(
    page.getByText("Guessed it! Your drawing is still open."),
  ).toBeVisible();
  await expect(page.getByText("Showing 1–2 of 2 predictions")).toBeVisible();
  await page.getByRole("button", { name: "Restart Guesser" }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Correct" }),
  ).toBeVisible({ timeout: 12000 });
  await expect(
    page.getByText("Guessed it! Your drawing is still open."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear drawing" }).click();
  await expect(page.getByText("No predictions yet")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Clear drawing" }),
  ).toBeDisabled();
});

test("heatmap continues with Guesser off without adding predictions", async ({
  page,
}) => {
  await mockFreeDraw(page, 0.84, "dog");
  await page.goto("/free-draw/");
  await page.getByRole("button", { name: "Heatmap Off" }).click();
  await page.getByRole("button", { name: "Guesser On" }).click();
  await expect(
    page.getByRole("button", { name: "Guesser Off" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Heatmap On" }),
  ).toHaveAttribute("aria-pressed", "true");
  await drawStroke(page);
  await expect(page.locator(".room-heatmap-guess")).toContainText("dog", {
    timeout: 12000,
  });
  await expect(
    page.getByText("Where the AI looked — attention, not its reasoning."),
  ).toBeVisible();
  await expect(page.getByText("No predictions yet")).toBeVisible();
});

test("mobile keeps the drawing tools ahead of AI and history without horizontal overflow", async ({
  page,
}) => {
  await mockFreeDraw(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/free-draw/");
  await expect(page.getByTestId("drawing-canvas")).toBeVisible();
  const measurements = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "[data-testid=drawing-canvas]",
    )!;
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      canvasWidth: canvas.getBoundingClientRect().width,
      toolsTop: document.querySelector(".fd-tools")!.getBoundingClientRect()
        .top,
      aiTop: document.querySelector(".fd-ai-panel")!.getBoundingClientRect()
        .top,
      historyTop: document.querySelector(".fd-history")!.getBoundingClientRect()
        .top,
    };
  });
  expect(measurements.documentWidth).toBeLessThanOrEqual(
    measurements.viewportWidth,
  );
  expect(measurements.canvasWidth).toBeLessThanOrEqual(
    measurements.viewportWidth,
  );
  expect(measurements.toolsTop).toBeLessThan(measurements.aiTop);
  expect(measurements.aiTop).toBeLessThan(measurements.historyTop);
});

test("late inference from a prior prompt is discarded", async ({ page }) => {
  await mockFreeDraw(page);
  let deferred: Route | undefined;
  await page.route("**/api/free-draw/infer", async (route) => {
    deferred = route;
  });
  await page.goto("/free-draw/");
  await drawStroke(page);
  await expect.poll(() => Boolean(deferred)).toBe(true);
  const observation = JSON.parse(
    deferred!.request().headers()["x-free-draw-observation"] ?? "{}",
  ) as { runId: string; revision: number; requestId: string; roles: string[] };
  await page.getByRole("button", { name: "Choose a prompt" }).click();
  const prompt = page.getByRole("combobox", { name: "Choose a prompt" });
  await prompt.fill("dog");
  await prompt.press("ArrowDown");
  await prompt.press("Enter");
  await deferred!.fulfill({
    json: {
      ...observation,
      sessionId: "free-draw-e2e",
      outcomes: {
        guesser: { status: "answer", answer: "cat", confidence: 0.99, heatmap },
      },
    },
  });
  await expect(page.getByText("Prompt: dog")).toBeVisible();
  await expect(page.getByText("No predictions yet")).toBeVisible();
  await expect(
    page.getByText("Guessed it! Your drawing is still open."),
  ).toHaveCount(0);
});
test("Referee retries do not hold up new guesses or duplicate unchanged predictions", async ({
  page,
}) => {
  await mockFreeDraw(page, 0.7, "dog");
  let refereeCalls = 0;
  let guesserCalls = 0;
  await page.route("**/api/free-draw/infer", async (route) => {
    const observation = JSON.parse(
      route.request().headers()["x-free-draw-observation"] ?? "{}",
    );
    const outcomes: Record<string, unknown> = {};
    if (observation.roles.includes("guesser")) {
      guesserCalls++;
      outcomes.guesser = {
        status: "answer",
        answer: "dog",
        confidence: 0.7,
        heatmap,
      };
    }
    if (observation.roles.includes("referee")) {
      refereeCalls++;
      outcomes.referee = { status: "unavailable", reason: "test-outage" };
    }
    await route.fulfill({
      json: { ...observation, sessionId: "free-draw-e2e", outcomes },
    });
  });
  await page.goto("/free-draw/");
  await drawStroke(page);
  await expect.poll(() => refereeCalls).toBeGreaterThanOrEqual(2);
  const before = guesserCalls;
  await page.getByRole("button", { name: "Fill", exact: true }).click();
  const box = await page.getByTestId("drawing-canvas").boundingBox();
  if (!box) throw new Error("Canvas unavailable");
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.85);
  await expect
    .poll(() => guesserCalls, { timeout: 4500 })
    .toBeGreaterThan(before);
  const settled = guesserCalls;
  await expect
    .poll(() => refereeCalls, { timeout: 12000 })
    .toBeGreaterThanOrEqual(3);
  expect(guesserCalls).toBe(settled);
});
for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`desktop ${viewport.width}x${viewport.height} keeps live history visible during AI outage`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/free-draw/**", (route) =>
      route.fulfill({ status: 503, body: "Unavailable" }),
    );
    await page.goto("/free-draw/");
    await expect(
      page.getByText(
        "AI is unavailable. You can keep drawing while we reconnect.",
      ),
    ).toBeVisible();
    const history = await page.locator(".fd-history-viewport").boundingBox();
    if (!history) throw new Error("History unavailable");
    expect(history.height).toBeGreaterThan(60);
    expect(history.y + history.height).toBeLessThanOrEqual(viewport.height);
    await drawStroke(page);
    await expect(
      page.getByRole("button", { name: "Undo", exact: true }),
    ).toBeEnabled();
  });
}
