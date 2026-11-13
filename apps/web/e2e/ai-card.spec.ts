import { expect, test, type Page } from "@playwright/test";

async function openFixture(page: Page, scenario: RegExp) {
  await page.goto("/review/");
  await page.getByRole("button", { name: scenario }).click();
  await expect(page.getByTestId("ai-card")).toBeVisible();
}

/** Change only the browser-local review fixture, then resume through the real UI. */
async function setAnswers(page: Page, count: number) {
  await page.evaluate((historyCount) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("more-than-meets-room-demo", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction("rooms", "readwrite");
      const store = tx.objectStore("rooms"), get = store.get("REVIEW");
      get.onsuccess = () => {
        const room = get.result;
        const old = room.snapshot.game.result;
        room.snapshot.game.result = {
          ...old,
          word: "target-hidden",
          aiAnswers: [...Array.from({ length: historyCount }, (_, i) => `earlier-${i + 1}`), "final-sentinel"],
          finalAnswer: "final-sentinel",
          aiCorrect: old?.aiCorrect ?? false,
          deltas: old?.deltas ?? {},
        };
        store.put(room, "REVIEW");
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), count);
  await page.reload();
  await expect(page.getByTestId("ai-card")).toBeVisible();
}

for (const width of [360, 1440]) {
  test.describe(`AI card at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("live state keeps its height and hides unrevealed AI answers", async ({ page }) => {
      await openFixture(page, /AI.*guessing/);
      await setAnswers(page, 7);
      const card = page.getByTestId("ai-card");
      await expect(card.getByRole("status", { name: "AI guessing" })).toBeVisible();
      await expect(card).not.toContainText("final-sentinel");
      await expect(card).not.toContainText("earlier-1");
      await expect(page.getByText("final-sentinel")).toHaveCount(0);
      await expect(page.getByText("earlier-1", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("ai-final-answer")).toHaveCount(0);
      expect((await card.boundingBox())!.height).toBe(224);
    });

    for (const [scenario, label] of [[/Result.*correct/, "correct"], [/Result.*missed/, "missed"]] as const) {
      test(`${label} result pins final answer above scrollable history without shifting chat`, async ({ page }) => {
        await openFixture(page, scenario);
        let chatTop: number | undefined;
        for (const count of [1, 7, 40]) {
          await setAnswers(page, count);
          const card = page.getByTestId("ai-card");
          const final = page.getByTestId("ai-final-answer");
          const history = page.getByTestId("ai-previous-guesses");
          const chat = page.getByTestId("room-chat");
          await expect(final).toContainText("final-sentinel");
          await expect(final.getByLabel(label === "correct" ? "Correct" : "Incorrect")).toBeVisible();
          await expect(history.getByRole("listitem")).toHaveCount(count + 1);
          const [cardBox, finalBox, historyBox, chatBox] = await Promise.all([card.boundingBox(), final.boundingBox(), history.boundingBox(), chat.boundingBox()]);
          expect(cardBox!.height).toBeGreaterThan(224);
          // The list shares the card with a two-line answer strip and a column
          // header, so it is the scroll region rather than a fixed 280px pane.
          expect(historyBox!.height).toBeGreaterThanOrEqual(250);
          expect(finalBox!.y + finalBox!.height).toBeLessThanOrEqual(historyBox!.y + 1);
          if (chatTop === undefined) chatTop = chatBox!.y;
          else expect(Math.abs(chatBox!.y - chatTop)).toBeLessThanOrEqual(1);
          if (count === 40) {
            const metrics = await history.evaluate(element => {
              const before = element.scrollTop;
              element.scrollTop = element.scrollHeight;
              return { before, after: element.scrollTop, height: element.clientHeight, content: element.scrollHeight };
            });
            expect(metrics.content).toBeGreaterThan(metrics.height);
            expect(metrics.after).toBeGreaterThan(metrics.before);
            const finalAfter = await final.boundingBox();
            expect(finalAfter!.y).toBe(finalBox!.y);
          }
        }
      });
    }
  });
}
