import { expect, test } from "@playwright/test";
import { openDeterministicGame } from "./helpers";

for (const input of ["wheel", "pinch"] as const) {
  test(`R55 — ${input} holds at 1×1 and navigates through the 64×64 limit`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: input === "pinch" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: input === "pinch",
      isMobile: input === "pinch",
      deviceScaleFactor: input === "pinch" ? 2 : 1,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", (request) => errors.push(request.url()));
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    try {
      await openDeterministicGame(page);
      const focus = { x: input === "pinch" ? 205 : 840, y: 520 };
      const before = await page.evaluate((point) => {
        const api = window.__infiniteMines;
        api.renderer.restoreView({ version: 1, zoom: 1.1 / 25, panX: 0, panY: 0 });
        return { version: api.model.store.version, cell: api.renderer.screenToCell(point.x, point.y) };
      }, focus);
      const session = await context.newCDPSession(page);
      let distance = 240;
      const touchPoints = () => [-1, 1].map((side, id) => ({
        id, x: focus.x + side * distance / 2, y: focus.y, radiusX: 2, radiusY: 2, force: 1,
      }));
      if (input === "pinch") {
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touchPoints() });
      } else {
        await page.mouse.move(focus.x, focus.y);
      }
      const zoom = async (factor: number, expectedSize: number) => {
        if (input === "pinch") {
          distance *= factor;
          await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touchPoints() });
        } else {
          await page.mouse.wheel(0, -Math.log(factor) / 0.0012);
        }
        // Wait for unchanged tiers too: wheel input is dispatched asynchronously.
        await page.waitForTimeout(100);
        await expect.poll(() => page.evaluate(() => window.__infiniteMines.renderer.cellSize))
          .toBeCloseTo(expectedSize, 5);
        const state = await page.evaluate((point) => ({
          enabled: window.__infiniteMines.renderer.cellInputEnabled,
          cell: window.__infiniteMines.renderer.screenToCell(point.x, point.y),
          version: window.__infiniteMines.model.store.version,
        }), focus);
        expect(state.enabled).toBe(expectedSize >= 1);
        expect(state.version).toBe(before.version);
        expect(state.cell).toEqual(before.cell);
      };
      await zoom(0.9, 1); // Continuous zoom reaches the playable boundary.
      await zoom(0.8, 1); // Further movement stays at 1×1, with cell input enabled.
      await zoom(0.8, 0.5); // Enough accumulated movement enters 2×2.
      await zoom(0.68, 0.5); // The later tiers retain their existing dwell.
      await zoom(0.9, 1 / 3);
      await zoom(1.1, 0.5);
      await zoom(1.6, 1); // Reversing returns to the same playable 1×1 band.
      await zoom(1.6, 1.1 * 0.9 * 0.8 * 0.8 * 0.68 * 0.9 * 1.1 * 1.6 * 1.6);
      if (input === "pinch") {
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
      await page.evaluate((point) => {
        const renderer = window.__infiniteMines.renderer;
        renderer.zoomAt(point.x, point.y, 1 / (32 * renderer.cellSize));
      }, focus);
      distance = 240;
      if (input === "pinch") {
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touchPoints() });
      }
      await zoom(0.8, 1 / 40);
      await zoom(0.8, 1 / 50);
      await zoom(0.75, 1 / 64);
      await zoom(0.8, 1 / 64); // Input clamps at the final tier without accumulating overshoot.
      await zoom(1.28, 1 / 50);
      await zoom(50 / 64, 1 / 64);
      if (input === "pinch") {
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
      await page.evaluate(() => window.__infiniteMines.flushSave());
      await page.reload();
      await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().overviewBlockSize)).toBe(64);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
