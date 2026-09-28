import { expect, test } from "@playwright/test";
import { openDeterministicGame } from "./helpers";

for (const topology of ["square", "hexagonal", "triangular", "rhombille"] as const) {
  test(`R56 — ${topology} Thing artwork settles when a zoomed view exceeds the old atlas`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1920, height: 1200 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript(() => performance.setResourceTimingBufferSize(10_000));
    await openDeterministicGame(page);
    await page.evaluate(() => window.__infiniteMines.renderer.waitForThingSprites());
    const fixture = await page.evaluate((topology) => {
      const { model, renderer } = window.__infiniteMines;
      model.reset("beginner", 0x555123, false, topology, undefined, true);
      const privateModel = model as unknown as {
        artifactForZone(x: number, y: number): { x: number; y: number };
      };
      const sprites = new Set<number>();
      for (let y = -8; y <= 8; y += 1) {
        for (let x = -8; x <= 8; x += 1) {
          const anchor = privateModel.artifactForZone(x, y);
          const visual = model.thingVisualAt(anchor.x, anchor.y);
          if (!visual) throw new Error("Missing Thing");
          sprites.add(visual.sprite);
          for (const cell of visual.reservedCells) model.store.set(cell.x, cell.y, 1);
        }
      }
      renderer.restoreView({ version: 1, zoom: 6 / 25, panX: 0, panY: 0 });
      return { sprites: sprites.size, frames: window.__infiniteMines.diagnostics().frameCount };
    }, topology);
    expect(fixture.sprites).toBeGreaterThan(256);

    const readiness = () => page.evaluate(() => {
      const renderer = window.__infiniteMines.renderer;
      const internal = renderer as unknown as { thingAtlasRequired: Set<number>; thingSpriteLoads: Map<number, unknown> };
      return {
        pending: internal.thingSpriteLoads.size,
        missing: [...internal.thingAtlasRequired].filter((sprite) => renderer.thingAtlasSlotForSprite(sprite) === null).length,
      };
    });
    const sample = () => page.evaluate(() => {
      const { renderer, model } = window.__infiniteMines;
      const internal = renderer as unknown as {
        thingAtlasRequired: Set<number>; thingAtlasWorldExtent: number; thingEmojiAtlas: HTMLCanvasElement;
      };
      const gl = renderer.gl;
      gl.finish();
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let hash = 0x811c9dc5;
      for (const value of pixels) hash = Math.imul(hash ^ value, 0x01000193);
      return {
        hash: hash >>> 0,
        diagnostics: window.__infiniteMines.diagnostics(),
        required: internal.thingAtlasRequired.size,
        physicalExtent: internal.thingAtlasWorldExtent * renderer.cellSize * window.__infiniteMines.diagnostics().pixelRatio,
        atlasWidth: internal.thingEmojiAtlas.width,
        modelVersion: model.store.version,
        requests: performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/things/")).length,
      };
    });
    for (const size of [6, 5, 4, 2, 5, 25, 5]) {
      const requestsBefore = (await sample()).requests;
      await page.evaluate((size) => window.__infiniteMines.renderer.restoreView({
        version: 1, zoom: size / 25, panX: 0, panY: 0,
      }), size);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      await expect.poll(readiness, { timeout: 20_000 }).toEqual({ pending: 0, missing: 0 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const before = await sample();
      if (size === 6) expect(before.diagnostics.frameCount - fixture.frames).toBeLessThan(10);
      await page.waitForTimeout(500);
      const after = await sample();
      expect(after.hash).toBe(before.hash);
      expect(after.diagnostics.frameCount).toBe(before.diagnostics.frameCount);
      expect(after.diagnostics.instanceUploads).toBe(before.diagnostics.instanceUploads);
      expect(after.requests).toBe(before.requests);
      expect(after.modelVersion).toBe(before.modelVersion);
      expect(after.diagnostics.drawCalls).toBe(1);
      if (size <= 4) {
        expect(after.required).toBe(0);
        expect(after.requests).toBe(requestsBefore);
      } else {
        expect(after.required).toBeGreaterThan(0);
        expect(after.diagnostics.thingSpritesLoaded).toBeGreaterThanOrEqual(after.required);
        expect(after.diagnostics.thingTexturePixels * (480 / 512)).toBeGreaterThanOrEqual(after.physicalExtent);
        expect(after.atlasWidth).toBeLessThanOrEqual(4096);
        if (topology === "square" && size <= 6) expect(after.required).toBeGreaterThan(64);
        if (size === 25) expect(after.diagnostics.thingTexturePixels).toBe(512);
      }
    }
    expect(errors).toEqual([]);
  });
}

test("R56 — a mobile pinch to pixel zoom does not restart rendering when old artwork loads finish", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  let releaseLoads = () => {};
  const heldLoads = new Promise<void>((resolve) => { releaseLoads = resolve; });
  let requested = 0;
  try {
    await openDeterministicGame(page);
    await page.evaluate(() => window.__infiniteMines.renderer.waitForThingSprites());
    await page.route("**/things/*.svg", async (route) => {
      requested += 1;
      await heldLoads;
      await route.continue();
    });
    await page.evaluate(() => {
      const { model, renderer } = window.__infiniteMines;
      model.reset("beginner", 0x555123, false, "rhombille", undefined, true);
      const privateModel = model as unknown as { artifactForZone(x: number, y: number): { x: number; y: number } };
      for (let y = -6; y <= 6; y += 1) for (let x = -6; x <= 6; x += 1) {
        const anchor = privateModel.artifactForZone(x, y);
        const visual = model.thingVisualAt(anchor.x, anchor.y);
        if (visual) for (const cell of visual.reservedCells) model.store.set(cell.x, cell.y, 1);
      }
      renderer.restoreView({ version: 1, zoom: 6 / 25, panX: 0, panY: 0 });
    });
    await expect.poll(() => requested).toBeGreaterThan(0);
    const session = await context.newCDPSession(page);
    const points = (spread: number) => [-1, 1].map((side, id) => ({ id, x: 195 + side * spread, y: 500, radiusX: 2, radiusY: 2, force: 1 }));
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(80) });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(20) });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().cellSize)).toBeCloseTo(1.5, 5);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const before = await page.evaluate(() => window.__infiniteMines.diagnostics());
    const requestsBefore = requested;
    releaseLoads();
    await expect.poll(() => page.evaluate(() => (window.__infiniteMines.renderer as unknown as {
      thingSpriteLoads: Map<number, unknown>;
    }).thingSpriteLoads.size)).toBe(0);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__infiniteMines.diagnostics());
    expect(after.frameCount).toBe(before.frameCount);
    expect(after.instanceUploads).toBe(before.instanceUploads);
    expect(after.openedCells).toBe(before.openedCells);
    expect(requested).toBe(requestsBefore);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    releaseLoads();
    await context.close();
  }
});
