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
          minIntervalMs: 500,
        },
      },
    }),
  );
  await page.route("**/api/free-draw/capabilities", async (route) =>
    route.fulfill({
      json: {
        guesser: { available: true, labels },
        referee: { available: true },
        minIntervalMs: 500,
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

test("threshold status, independent insight toggles, fresh reload, and Home entry defaults", async ({
  page,
}) => {
  await mockFreeDraw(page, 0.5, "cat");
  await page.goto("/free-draw/");
  await expect(page.getByRole("button", { name: "brush", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "eraser", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "fill", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Color #181321" })).toBeVisible();
  await expect(page.getByRole("button", { name: "No prompt" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Heatmap Off" }).click();
  await expect(page.getByRole("button", { name: "Guesser On" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Guesser On" }).click();
  await expect(page.getByRole("button", { name: "Heatmap On" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Guesser Off" }).click();
  await drawStroke(page);
  await expect(page.getByRole("listitem").filter({ hasText: "Below threshold" })).toBeVisible({ timeout: 12000 });
  await expect(page.getByText("50%", { exact: true })).toBeVisible();
  await expect(page.getByText("Where the AI looked — attention, not its reasoning.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear history" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Restart Guesser" })).toBeVisible();
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByText("No predictions yet")).toBeVisible();

  const inkCount = async (element: Locator) => element.evaluate((node) => {
    const source = node as HTMLCanvasElement;
    const sample = document.createElement("canvas");
    sample.width = 64;
    sample.height = 48;
    const context = sample.getContext("2d");
    if (!context) return 0;
    context.fillStyle = "white";
    context.fillRect(0, 0, sample.width, sample.height);
    context.drawImage(source, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4)
      if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) count++;
    return count;
  });
  const canvas = page.getByTestId("drawing-canvas");
  await expect.poll(() => inkCount(canvas)).toBeGreaterThan(0);
  await page.reload();
  await expect.poll(() => canvas.getAttribute("data-ready")).toBe("true");
  await expect(page.getByText("No predictions yet")).toBeVisible();
  await expect.poll(() => inkCount(canvas)).toBe(0);
  await expect(page.getByRole("button", { name: "No prompt" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("link", { name: "Back to home" }).click();
  await page.getByRole("link", { name: /Start drawing/ }).click();
  const freshCanvas = page.getByTestId("drawing-canvas");
  await expect.poll(() => freshCanvas.getAttribute("data-ready")).toBe("true");
  await expect(page.getByText("No predictions yet")).toBeVisible();
  await expect.poll(() => inkCount(freshCanvas)).toBe(0);
  await expect(page.getByRole("button", { name: "No prompt" })).toHaveAttribute("aria-pressed", "true");
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
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("No predictions yet")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Clear", exact: true }),
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

test("mobile keeps mode before canvas, toolbar under canvas, and AI/history below without overflow", async ({
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
      modeTop: document.querySelector(".fd-mode-panel")!.getBoundingClientRect().top,
      canvasTop: canvas.getBoundingClientRect().top,
      toolsTop: document.querySelector(".room-tools")!.getBoundingClientRect()
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
  expect(measurements.modeTop).toBeLessThan(measurements.canvasTop);
  expect(measurements.canvasTop).toBeLessThan(measurements.toolsTop);
  expect(measurements.toolsTop).toBeLessThan(measurements.aiTop);
  expect(measurements.aiTop).toBeLessThan(measurements.historyTop);
});

test("desktop places heading, drawing mode, and AI left of the canvas with history right", async ({ page }) => {
  await mockFreeDraw(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/free-draw/");
  const positions = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing layout element: ${selector}`);
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    };
    return {
      heading: rect(".fd-workspace-heading"),
      mode: rect(".fd-mode-panel"),
      canvas: rect("[data-testid=drawing-canvas]"),
      ai: rect(".fd-ai-panel"),
      history: rect(".fd-history"),
    };
  });
  expect(positions.mode.right).toBeLessThan(positions.canvas.left);
  expect(positions.heading.bottom).toBeLessThan(positions.mode.top);
  expect(positions.mode.bottom).toBeLessThan(positions.ai.top);
  expect(positions.ai.right).toBeLessThan(positions.canvas.left);
  expect(positions.canvas.right).toBeLessThan(positions.history.left);
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
test("Guesser result appears during a held stroke before the separate delayed Referee response", async ({ page }) => {
  await mockFreeDraw(page, 0.9, "cat");
  let refereeCompleted = false;
  let guesserCalls = 0;
  let refereeCalls = 0;
  let combinedRequests = 0;
  await page.route("**/api/free-draw/infer", async (route) => {
    const observation = JSON.parse(
      route.request().headers()["x-free-draw-observation"] ?? "{}",
    ) as { runId: string; revision: number; requestId: string; roles: string[] };
    if (observation.roles.length !== 1) combinedRequests++;
    if (observation.roles.includes("guesser")) guesserCalls++;
    if (observation.roles.includes("referee")) refereeCalls++;
    if (observation.roles.includes("referee")) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      refereeCompleted = true;
    }
    const outcomes: Record<string, unknown> = {};
    if (observation.roles.includes("guesser"))
      outcomes.guesser = { status: "answer", answer: "cat", confidence: 0.9, heatmap };
    if (observation.roles.includes("referee"))
      outcomes.referee = { status: "evidence", scores: [0.65, 0] };
    await route.fulfill({
      json: { ...observation, sessionId: "free-draw-e2e", outcomes },
    });
  });
  await page.goto("/free-draw/");
  await page.getByRole("button", { name: "Choose a prompt" }).click();
  const prompt = page.getByRole("combobox", { name: "Choose a prompt" });
  await prompt.fill("cat");
  await prompt.press("ArrowDown");
  await prompt.press("Enter");
  const canvas = page.getByTestId("drawing-canvas");
  await expect.poll(() => canvas.getAttribute("data-ready")).toBe("true");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas unavailable");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.54, { steps: 8 });
  await expect(page.getByRole("listitem").filter({ hasText: "Correct" })).toBeVisible({ timeout: 8000 });
  expect(refereeCompleted).toBe(false);
  expect(guesserCalls).toBeGreaterThan(0);
  await expect.poll(() => refereeCalls).toBeGreaterThan(0);
  await expect(page.getByTestId("referee-warning")).toContainText("65% confidence", { timeout: 4000 });
  expect(refereeCompleted).toBe(true);
  expect(combinedRequests).toBe(0);
  await page.mouse.up();
  await page.waitForTimeout(3500);
  await expect(page.getByTestId("referee-warning")).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByTestId("referee-warning")).toHaveCount(0);
});

test("history stays tall and readable beyond the viewport and expands on demand", async ({ page }) => {
  await mockFreeDraw(page, 0.9, "dog");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/free-draw/");
  await drawStroke(page);
  await expect(page.getByRole("listitem").filter({ hasText: "Submitted" })).toBeVisible({ timeout: 8000 });
  const history = page.locator(".fd-history-viewport");
  const initial = await history.boundingBox();
  if (!initial) throw new Error("History unavailable");
  expect(initial.height).toBeGreaterThanOrEqual(360);
  await expect(page.locator(".fd-history-row")).toHaveCSS("font-size", "14px");
  await expect(page.locator(".fd-history-row")).toHaveCSS("height", "72px");
  const initialHeight = initial.height;
  await page.getByRole("button", { name: "Expand history" }).click();
  await expect(page.getByRole("button", { name: "Collapse history" })).toHaveAttribute("aria-expanded", "true");
  const expanded = await history.boundingBox();
  if (!expanded) throw new Error("Expanded history unavailable");
  expect(expanded.height).toBeGreaterThan(initialHeight);
});
