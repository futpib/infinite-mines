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
    await expect(page.locator("#touch-preview")).toBeVisible();
    const initialPreview = await page.locator("#touch-preview").boundingBox();
    if (!initialPreview) throw new Error("Missing touch preview bounds");
    expect(initialPreview.x).toBeGreaterThanOrEqual(12);
    expect(initialPreview.x + initialPreview.width).toBeLessThanOrEqual(1188);
    expect(initialPreview.y + initialPreview.height).toBeLessThan(startY - 30);
    await expect(page.locator("#touch-preview-tile")).toHaveAttribute("data-state", "covered");
    await expect(page.locator("#touch-preview-action")).toHaveText("TAP TO FLAG");
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(1, startX + 4, startY + 4)],
    });
    expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual(before.view);
    await expect(page.locator("#touch-preview")).toBeVisible();

    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(1, startX + 80, startY + 30)],
    });
    await expect(page.locator("#touch-preview")).toBeHidden();
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

    const edgeX = bounds.x + bounds.width / 2;
    const edgeY = bounds.y + 100;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint(2, edgeX, edgeY)],
    });
    await expect(page.locator("#touch-preview")).toHaveAttribute("data-placement", "below");
    const edgePreview = await page.locator("#touch-preview").boundingBox();
    if (!edgePreview) throw new Error("Missing edge touch preview bounds");
    expect(edgePreview.y).toBeGreaterThan(edgeY + 30);
    expect(edgePreview.y + edgePreview.height).toBeLessThanOrEqual(bounds.height - 12);
    await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect(page.locator("#touch-preview")).toBeHidden();
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
    await expect(page.locator("#touch-preview")).toBeHidden();
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

test("R47 — the magnified callout stays topology-aware and usable at pixel zoom", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  let pointerId = 30;
  const startAt = async (point: { x: number; y: number }) => {
    pointerId += 1;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint(pointerId, point.x, point.y)],
    });
  };
  const cancel = async () => {
    await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect(page.locator("#touch-preview")).toBeHidden();
  };
  const coveredTarget = async () =>
    page.evaluate(() => {
      const api = window.__infiniteMines;
      let best: { x: number; y: number; screenX: number; screenY: number; aspect: number; distance: number } | null = null;
      for (let y = -40; y <= 40; y += 1) {
        for (let x = -40; x <= 40; x += 1) {
          if (api.model.getState(x, y) !== 0) continue;
          const polygon = api.renderer.cellScreenPolygon(x, y);
          const screenX = polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length;
          const screenY = polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length;
          if (screenX < 36 || screenX > 354 || screenY < 250 || screenY > 790) continue;
          const width = Math.max(...polygon.map((point) => point.x)) - Math.min(...polygon.map((point) => point.x));
          const height = Math.max(...polygon.map((point) => point.y)) - Math.min(...polygon.map((point) => point.y));
          const distance = Math.hypot(screenX - 245, screenY - 610);
          if (!best || distance < best.distance) best = { x, y, screenX, screenY, aspect: width / height, distance };
        }
      }
      if (!best) throw new Error("No covered on-screen cell");
      return best;
    });

  try {
    await openDeterministicGame(page);
    for (const topology of ["square", "rhombille", "triangular"] as const) {
      await page.evaluate((nextTopology) => window.__infiniteMines.newGame("beginner", nextTopology), topology);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const target = await coveredTarget();
      await startAt({ x: target.screenX, y: target.screenY });
      await expect(page.locator("#touch-preview")).toHaveAttribute("data-topology", topology);
      await expect(page.locator("#touch-preview-coordinate")).toHaveText(`${target.x}, ${target.y}`);
      await expect(page.locator("#touch-preview-tile")).toHaveAttribute("data-state", "covered");
      const clipPath = await page.locator("#touch-preview-tile").evaluate((tile) => getComputedStyle(tile).clipPath);
      if (topology === "square") expect(clipPath).toBe("none");
      else expect(clipPath).toContain("polygon(");
      const tileBounds = await page.locator("#touch-preview-tile").boundingBox();
      if (!tileBounds) throw new Error("Missing magnified tile bounds");
      expect(tileBounds.width / tileBounds.height).toBeCloseTo(target.aspect, 2);
      await cancel();
    }

    await page.evaluate(() => {
      const renderer = window.__infiniteMines.renderer;
      renderer.zoomAt(195, 422, 0.001);
    });
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.renderer.cellSize)).toBe(1);
    const pixelTarget = await page.evaluate(() => {
      const point = { x: 245, y: 610 };
      return { ...point, cell: window.__infiniteMines.renderer.screenToCell(point.x, point.y) };
    });
    await startAt(pixelTarget);
    await expect(page.locator("#touch-preview")).toBeVisible();
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics().touchPreview)).toMatchObject(pixelTarget.cell);
    const previewBounds = await page.locator("#touch-preview").boundingBox();
    if (!previewBounds) throw new Error("Missing pixel-zoom preview bounds");
    expect(previewBounds.width).toBeGreaterThan(100);
    expect(previewBounds.y + previewBounds.height).toBeLessThan(pixelTarget.y - 30);
    await cancel();
  } finally {
    await session.detach();
    await context.close();
  }
});
