import { expect, test } from "@playwright/test";
import { openDeterministicGame } from "./helpers";

const touchPoint = (id: number, x: number, y: number) => ({
  id,
  x,
  y,
  radiusX: 2,
  radiusY: 2,
  force: 1,
});

test("R22 — coarse-pointer laptops expose touch controls and one-finger dead-zone panning", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: false,
  });
  const page = await context.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  try {
    await openDeterministicGame(page);
    expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
    await expect(page.locator("#mobile-tool")).toBeVisible();
    await expect(page.locator("#hint")).toBeHidden();
    const bounds = await page.locator("#board").boundingBox();
    if (!bounds) throw new Error("Missing board bounds");
    const session = await context.newCDPSession(page);
    const startX = bounds.x + bounds.width * 0.62;
    const startY = bounds.y + bounds.height * 0.62;
    const before = await page.evaluate(() => ({
      view: window.__infiniteMines.renderer.createViewSnapshot(),
      openedCells: window.__infiniteMines.diagnostics().openedCells,
      score: window.__infiniteMines.diagnostics().score,
      storeVersion: window.__infiniteMines.model.store.version,
    }));

    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint(1, startX, startY)],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(1, startX + 4, startY + 4)],
    });
    expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual(before.view);

    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(1, startX + 80, startY + 30)],
    });
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().pixelRatio)).toBe(2);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().pixelRatio)).toBe(2);
    const after = await page.evaluate(() => ({
      view: window.__infiniteMines.renderer.createViewSnapshot(),
      openedCells: window.__infiniteMines.diagnostics().openedCells,
      score: window.__infiniteMines.diagnostics().score,
      storeVersion: window.__infiniteMines.model.store.version,
    }));
    expect(after.view.panX).toBeCloseTo(before.view.panX + 80, 5);
    expect(after.view.panY).toBeCloseTo(before.view.panY + 30, 5);
    expect(after.view.zoom).toBe(before.view.zoom);
    expect(after.openedCells).toBe(before.openedCells);
    expect(after.score).toBe(before.score);
    expect(after.storeVersion).toBe(before.storeVersion);
    expect(errors).toEqual([]);
    await session.detach();
  } finally {
    await context.close();
  }
});

test("R22 — two-finger touch pans and zooms focally without opening cells, then persists", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: false,
  });
  const page = await context.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  try {
    await openDeterministicGame(page);
    const bounds = await page.locator("#board").boundingBox();
    if (!bounds) throw new Error("Missing board bounds");
    const session = await context.newCDPSession(page);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const before = await page.evaluate(() => ({
      openedCells: window.__infiniteMines.diagnostics().openedCells,
      score: window.__infiniteMines.diagnostics().score,
      storeVersion: window.__infiniteMines.model.store.version,
    }));

    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint(11, centerX - 50, centerY), touchPoint(12, centerX + 50, centerY)],
    });
    for (let step = 1; step <= 8; step += 1) {
      const spread = 50 + step * 12.5;
      const shiftX = (40 * step) / 8;
      const shiftY = (30 * step) / 8;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          touchPoint(11, centerX - spread + shiftX, centerY + shiftY),
          touchPoint(12, centerX + spread + shiftX, centerY + shiftY),
        ],
      });
    }
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().pixelRatio)).toBe(2);
    const during = await page.evaluate(() => ({
      view: window.__infiniteMines.renderer.createViewSnapshot(),
      hoveredCells: window.__infiniteMines.diagnostics().hoveredCells,
    }));
    expect(during.view.zoom).toBeGreaterThan(1.9);
    expect(during.view.panX).toBeCloseTo(40, 5);
    expect(during.view.panY).toBeCloseTo(30, 5);
    expect(during.hoveredCells).toBe(0);

    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().pixelRatio)).toBe(2);
    const after = await page.evaluate(() => ({
      view: window.__infiniteMines.renderer.createViewSnapshot(),
      openedCells: window.__infiniteMines.diagnostics().openedCells,
      score: window.__infiniteMines.diagnostics().score,
      storeVersion: window.__infiniteMines.model.store.version,
    }));
    expect(after.openedCells).toBe(before.openedCells);
    expect(after.score).toBe(before.score);
    expect(after.storeVersion).toBe(before.storeVersion);

    await page.evaluate(() => window.__infiniteMines.flushSave());
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().backend)).toBe("webgl2");
    const restored = await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot());
    expect(restored.panX).toBeCloseTo(after.view.panX, 8);
    expect(restored.panY).toBeCloseTo(after.view.panY, 8);
    expect(restored.zoom).toBeCloseTo(after.view.zoom, 8);
    expect(errors).toEqual([]);
    await session.detach();
  } finally {
    await context.close();
  }
});
