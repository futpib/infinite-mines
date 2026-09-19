import { expect, test } from "@playwright/test";
import { CellState } from "../../src/model";
import { openDeterministicGame, worldPoint } from "./helpers";

test("R50 — field rotation is display-only, input-correct, and persisted", async ({ page }) => {
  await openDeterministicGame(page);
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-field-rotation"))).toBeNull();
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().rotation)).toBe(0);
  await page.evaluate(async () => {
    window.__infiniteMines.renderer.restoreView({ version: 1, panX: 31.25, panY: -17.5, zoom: 1.12 });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const target = { x: 7, y: 3 };
  const before = await page.evaluate(({ x, y }) => {
    const api = window.__infiniteMines;
    const polygon = api.renderer.cellScreenPolygon(x, y);
    return {
      model: {
        seed: api.model.seed,
        topology: api.model.topologyId,
        mode: api.model.mode,
        density: api.model.density,
        score: api.model.score,
        health: api.model.health,
        things: api.model.things,
        storedCells: api.model.store.nonZeroCells,
        targetState: api.model.getState(x, y),
      },
      view: api.renderer.createViewSnapshot(),
      center: {
        x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
        y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
      },
      viewport: { width: api.renderer.canvas.clientWidth, height: api.renderer.canvas.clientHeight },
      frameCount: api.diagnostics().frameCount,
    };
  }, target);
  expect(before.model.targetState).toBe(CellState.Covered);

  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator('#rotation-options [data-rotation="0"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /90°/ }).click();
  await expect(page.locator('#rotation-options [data-rotation="90"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBeGreaterThan(before.frameCount);
  await page.getByRole("button", { name: "Close" }).click();

  const rotated = await page.evaluate(({ x, y }) => {
    const api = window.__infiniteMines;
    const polygon = api.renderer.cellScreenPolygon(x, y);
    const center = {
      x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
      y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
    };
    return {
      model: {
        seed: api.model.seed,
        topology: api.model.topologyId,
        mode: api.model.mode,
        density: api.model.density,
        score: api.model.score,
        health: api.model.health,
        things: api.model.things,
        storedCells: api.model.store.nonZeroCells,
        targetState: api.model.getState(x, y),
      },
      view: api.renderer.createViewSnapshot(),
      center,
      hit: api.renderer.screenToCell(center.x, center.y),
      rotation: api.diagnostics().rotation,
    };
  }, target);
  expect(rotated.model).toEqual(before.model);
  expect(rotated.view).toEqual(before.view);
  expect(rotated.hit).toEqual(target);
  expect(rotated.rotation).toBe(90);
  expect(rotated.center.x - before.viewport.width / 2).toBeCloseTo(-(before.center.y - before.viewport.height / 2), 8);
  expect(rotated.center.y - before.viewport.height / 2).toBeCloseTo(before.center.x - before.viewport.width / 2, 8);
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-field-rotation"))).toBe("90");

  const targetPoint = await worldPoint(page, target);
  await page.mouse.move(targetPoint.x, targetPoint.y);
  await expect(page.locator("#cell-locator")).toHaveAttribute("data-x", String(target.x));
  await expect(page.locator("#cell-locator")).toHaveAttribute("data-y", String(target.y));
  const hoverAlignment = await page.locator("#hover-overlay .hover-cell.is-visible").first().evaluate((marker) => {
    const api = window.__infiniteMines;
    const element = marker as HTMLElement;
    const x = Number(element.dataset.x);
    const y = Number(element.dataset.y);
    const polygon = api.renderer.cellFramebufferPolygon(x, y);
    const insets = api.renderer.squareOwnedEdgeInsets();
    const expected = {
      left: Math.min(...polygon.map((point) => point.x)) - insets.left,
      top: Math.min(...polygon.map((point) => point.y)) - insets.top,
      right: Math.max(...polygon.map((point) => point.x)) + insets.right,
      bottom: Math.max(...polygon.map((point) => point.y)) + insets.bottom,
    };
    const actual = element.getBoundingClientRect();
    return {
      cell: { x, y },
      insets,
      error: Math.max(
        Math.abs(actual.left - expected.left),
        Math.abs(actual.top - expected.top),
        Math.abs(actual.right - expected.right),
        Math.abs(actual.bottom - expected.bottom),
      ),
    };
  });
  expect(hoverAlignment.cell).toEqual(target);
  expect(hoverAlignment.insets).toEqual({ left: 1, top: 0, right: 0, bottom: 1 });
  expect(hoverAlignment.error).toBeLessThan(0.02);
  await page.mouse.click(targetPoint.x, targetPoint.y, { button: "right" });
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), target)).toBe(CellState.Flagged);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("saved");

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().rotation)).toBe(90);
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), target)).toBe(CellState.Flagged);
  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator('#rotation-options [data-rotation="90"]')).toHaveAttribute("aria-pressed", "true");
});

test("R50 — every topology and quarter-turn share rendering, hit-testing, pan, and focal zoom", async ({ page }) => {
  await openDeterministicGame(page);
  const cases = await page.evaluate(async ({ opened }) => {
    const api = window.__infiniteMines;
    const results: Array<{
      topology: string;
      rotation: number;
      hit: { x: number; y: number };
      screenError: number;
      panError: number;
      focalHit: { x: number; y: number };
      painted: boolean;
      pixelHit: { x: number; y: number };
      pixelPainted: boolean;
      damageMismatch: number;
      drawCalls: number;
    }> = [];
    const target = { x: 4, y: -2 };
    const rotations = [0, 90, 180, 270] as const;
    const topologies = ["square", "rhombille", "triangular"] as const;
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const rotate = (rotation: (typeof rotations)[number], x: number, y: number) => {
      if (rotation === 90) return { x: -y, y: x };
      if (rotation === 180) return { x: -x, y: -y };
      if (rotation === 270) return { x: y, y: -x };
      return { x, y };
    };

    for (const topology of topologies) {
      for (const rotation of rotations) {
        api.model.reset("beginner", 0x50a7_0001, false, topology, undefined, false);
        api.model.store.clear();
        api.model.store.set(target.x, target.y, opened);
        api.renderer.syncThings();
        api.renderer.home();
        api.renderer.setRotation(rotation);
        api.renderer.requestRender();
        await nextFrame();

        const geometry = api.model.topology.geometry(target.x, target.y);
        const origin = api.model.topology.origin;
        const expectedOffset = rotate(
          rotation,
          (geometry.center.x - origin.x) * api.renderer.cellSize,
          (geometry.center.y - origin.y) * api.renderer.cellSize,
        );
        const polygon = api.renderer.cellScreenPolygon(target.x, target.y);
        const center = {
          x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
          y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
        };
        const expected = {
          x: api.renderer.canvas.clientWidth / 2 + expectedOffset.x,
          y: api.renderer.canvas.clientHeight / 2 + expectedOffset.y,
        };
        const hit = api.renderer.screenToCell(center.x, center.y);

        const dpr = api.diagnostics().pixelRatio;
        const pixel = new Uint8Array(4);
        api.renderer.gl.readPixels(
          Math.max(0, Math.min(api.renderer.canvas.width - 1, Math.floor(center.x * dpr))),
          Math.max(0, Math.min(api.renderer.canvas.height - 1, api.renderer.canvas.height - 1 - Math.floor(center.y * dpr))),
          1,
          1,
          api.renderer.gl.RGBA,
          api.renderer.gl.UNSIGNED_BYTE,
          pixel,
        );
        const background = api.diagnostics().backgroundColor.slice(1);
        const backgroundRgb = [0, 2, 4].map((offset) => Number.parseInt(background.slice(offset, offset + 2), 16));
        const painted = backgroundRgb.some((channel, index) => Math.abs(channel - pixel[index]) > 2);

        api.model.store.set(target.x + 1, target.y, opened);
        api.renderer.requestRender({
          minX: target.x,
          minY: target.y,
          maxX: target.x + 1,
          maxY: target.y,
        });
        await nextFrame();
        const partial = new Uint8Array(api.renderer.canvas.width * api.renderer.canvas.height * 4);
        api.renderer.gl.readPixels(
          0,
          0,
          api.renderer.canvas.width,
          api.renderer.canvas.height,
          api.renderer.gl.RGBA,
          api.renderer.gl.UNSIGNED_BYTE,
          partial,
        );
        api.renderer.requestRender();
        await nextFrame();
        const full = new Uint8Array(partial.length);
        api.renderer.gl.readPixels(
          0,
          0,
          api.renderer.canvas.width,
          api.renderer.canvas.height,
          api.renderer.gl.RGBA,
          api.renderer.gl.UNSIGNED_BYTE,
          full,
        );
        let damageMismatch = 0;
        for (let index = 0; index < partial.length; index += 1) {
          if (partial[index] !== full[index]) damageMismatch += 1;
        }

        const beforePan = center;
        api.renderer.panBy(13, -9);
        await nextFrame();
        const pannedPolygon = api.renderer.cellScreenPolygon(target.x, target.y);
        const afterPan = {
          x: pannedPolygon.reduce((sum, point) => sum + point.x, 0) / pannedPolygon.length,
          y: pannedPolygon.reduce((sum, point) => sum + point.y, 0) / pannedPolygon.length,
        };
        const focalHitBefore = api.renderer.screenToCell(afterPan.x, afterPan.y);
        api.renderer.zoomAt(afterPan.x, afterPan.y, 1.3);
        await nextFrame();
        const focalHit = api.renderer.screenToCell(afterPan.x, afterPan.y);

        api.renderer.restoreView({ version: 1, panX: 0, panY: 0, zoom: 0.16 });
        await nextFrame();
        const pixelPolygon = api.renderer.cellScreenPolygon(target.x, target.y);
        const pixelCenter = {
          x: pixelPolygon.reduce((sum, point) => sum + point.x, 0) / pixelPolygon.length,
          y: pixelPolygon.reduce((sum, point) => sum + point.y, 0) / pixelPolygon.length,
        };
        const pixelHit = api.renderer.screenToCell(pixelCenter.x, pixelCenter.y);
        const pixelLod = new Uint8Array(4);
        api.renderer.gl.readPixels(
          Math.max(0, Math.min(api.renderer.canvas.width - 1, Math.floor(pixelCenter.x * dpr))),
          Math.max(0, Math.min(api.renderer.canvas.height - 1, api.renderer.canvas.height - 1 - Math.floor(pixelCenter.y * dpr))),
          1,
          1,
          api.renderer.gl.RGBA,
          api.renderer.gl.UNSIGNED_BYTE,
          pixelLod,
        );
        const pixelPainted = backgroundRgb.some((channel, index) => Math.abs(channel - pixelLod[index]) > 2);
        results.push({
          topology,
          rotation,
          hit,
          screenError: Math.max(Math.abs(center.x - expected.x), Math.abs(center.y - expected.y)),
          panError: Math.max(Math.abs(afterPan.x - beforePan.x - 13), Math.abs(afterPan.y - beforePan.y + 9)),
          focalHit: focalHitBefore.x === target.x && focalHitBefore.y === target.y ? focalHit : { x: NaN, y: NaN },
          painted,
          pixelHit,
          pixelPainted,
          damageMismatch,
          drawCalls: api.diagnostics().drawCalls,
        });
      }
    }
    return results;
  }, { opened: CellState.Opened1 });

  expect(cases).toHaveLength(12);
  for (const result of cases) {
    const label = `${result.topology} at ${result.rotation}°`;
    expect(result.hit, `${label} hit test`).toEqual({ x: 4, y: -2 });
    expect(result.focalHit, `${label} focal zoom`).toEqual({ x: 4, y: -2 });
    expect(result.screenError, `${label} screen projection`).toBeLessThan(1e-7);
    expect(result.panError, `${label} screen-space pan`).toBeLessThan(1e-7);
    expect(result.painted, `${label} framebuffer paint`).toBe(true);
    expect(result.pixelHit, `${label} pixel hit test`).toEqual({ x: 4, y: -2 });
    expect(result.pixelPainted, `${label} pixel framebuffer paint`).toBe(true);
    expect(result.damageMismatch, `${label} damage redraw`).toBe(0);
    expect(result.drawCalls, `${label} draw count`).toBe(1);
  }
});

test("R50 — rotated dense fields retain the one-pixel framebuffer blit path", async ({ page }) => {
  await openDeterministicGame(page);
  const result = await page.evaluate(async ({ opened }) => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    const gl = renderer.gl;
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const readFrame = () => {
      const pixels = new Uint8Array(renderer.canvas.width * renderer.canvas.height * 4);
      gl.finish();
      gl.readPixels(0, 0, renderer.canvas.width, renderer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };

    await renderer.waitForThingSprites();
    api.model.reset("beginner", 0x50a7_0002, false, "square", undefined, false);
    api.model.store.clear();
    for (let y = -160; y <= 160; y += 1) {
      for (let x = -160; x <= 160; x += 1) api.model.store.set(x, y, opened);
    }
    renderer.syncThings();
    renderer.restoreView({ version: 1, panX: 0, panY: 0, zoom: 0.32 });
    renderer.setRotation(90);
    renderer.requestRender();
    await settle();
    renderer.panBy(1, 0);
    await settle();
    const pan = api.diagnostics();
    const retained = readFrame();
    renderer.requestRender();
    await settle();
    const full = readFrame();
    let mismatch = 0;
    for (let index = 0; index < retained.length; index += 1) {
      if (retained[index] !== full[index]) mismatch += 1;
    }
    return { pan, mismatch, canvasHeight: renderer.canvas.height };
  }, { opened: CellState.Opened1 });

  expect(result.pan, JSON.stringify(result.pan)).toMatchObject({ rotation: 90, redrawMode: "pan", drawCalls: 1 });
  expect(result.pan.drawnCells).toBeGreaterThanOrEqual(20_000);
  expect(result.pan.redrawnPixels).toBe(result.canvasHeight);
  expect(result.pan.blittedPixels).toBe(result.pan.canvasPixels - result.pan.redrawnPixels);
  expect(result.mismatch).toBe(0);
});
