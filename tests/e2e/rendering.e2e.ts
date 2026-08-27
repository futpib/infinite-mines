import { expect, test } from "@playwright/test";
import { hexToRgb, openDeterministicGame } from "./helpers";

test("R12/R13 — zoom reaches one CSS pixel and low-zoom pixels encode tile state without borders", async ({ page }) => {
  await openDeterministicGame(page);
  const result = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    const canvas = document.querySelector<HTMLCanvasElement>("#board");
    if (!canvas) throw new Error("Missing board");
    renderer.home();
    api.model.store.set(-3, 0, 2);
    api.model.store.set(-1, 0, 10);
    api.model.store.set(1, 0, 11);
    api.model.store.set(3, 0, 12);
    const bounds = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
        deltaY: 10_000,
      }),
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const gl = renderer.gl;
    gl.finish();
    const dpr = canvas.width / bounds.width;
    const readCell = (x: number): number[] => {
      const pixel = new Uint8Array(4);
      const cssX = bounds.width / 2 + renderer.panX + x * renderer.cellSize;
      const cssY = bounds.height / 2 + renderer.panY;
      gl.readPixels(
        Math.floor(cssX * dpr),
        canvas.height - 1 - Math.floor(cssY * dpr),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      return Array.from(pixel.slice(0, 3));
    };
    const styles = getComputedStyle(document.documentElement);
    const color = (name: string) => styles.getPropertyValue(name).trim();
    return {
      diagnostics: api.diagnostics(),
      view: renderer.createViewSnapshot(),
      colors: {
        opened1: readCell(-3),
        flag: readCell(-1),
        question: readCell(1),
        exploded: readCell(3),
      },
      expected: {
        background: color("--board-bg"),
      },
    };
  });

  expect(result.view.zoom).toBe(0.04);
  expect(result.diagnostics.cellSize).toBe(1);
  expect(result.diagnostics.lod).toBe("pixel");
  expect(result.diagnostics.borderCssPixels).toBe(0);
  expect(result.diagnostics.glyphs).toBe(false);
  expect(result.diagnostics.visibleCells).toBeGreaterThan(1_000_000);
  const colors = Object.values(result.colors);
  expect(new Set(colors.map((color) => color.join(","))).size).toBe(colors.length);
  for (const color of colors) expect(color).not.toEqual(hexToRgb(result.expected.background));
});

test("R23 — detail glyphs crossfade continuously into state-color squares", async ({ page }) => {
  await openDeterministicGame(page);
  const result = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    const canvas = document.querySelector<HTMLCanvasElement>("#board");
    if (!canvas) throw new Error("Missing board");
    const target = { x: 7, y: 7 };
    api.model.store.set(target.x, target.y, 2);

    const readAtSize = async (cellSize: number) => {
      renderer.restoreView({
        version: 1,
        zoom: cellSize / 25,
        panX: -target.x * cellSize,
        panY: -target.y * cellSize,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const bounds = canvas.getBoundingClientRect();
      const gl = renderer.gl;
      gl.finish();
      const dpr = canvas.width / bounds.width;
      const pixel = new Uint8Array(4);
      const cellLeft = bounds.width / 2 - cellSize / 2;
      const cellTop = bounds.height / 2 - cellSize / 2;
      const cssX = cellLeft + 1.5;
      const cssY = cellTop + 1.5;
      gl.readPixels(
        Math.floor(cssX * dpr),
        canvas.height - 1 - Math.floor(cssY * dpr),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      return {
        color: Array.from(pixel.slice(0, 3)),
        diagnostics: api.diagnostics(),
      };
    };

    const styles = getComputedStyle(document.documentElement);
    const samples = [];
    for (const size of [8, 7, 6, 5, 4]) samples.push(await readAtSize(size));
    return {
      samples,
      detail: styles.getPropertyValue("--board-cell").trim(),
    };
  });

  const detail = hexToRgb(result.detail);
  const state = result.samples[4].color;
  const expectedMixes = [1, 0.84375, 0.5, 0.15625, 0];
  result.samples.forEach(({ diagnostics }, index) =>
    expect(diagnostics.detailMix).toBeCloseTo(expectedMixes[index], 8),
  );
  result.samples.forEach(({ diagnostics }, index) =>
    expect(diagnostics.cellSize).toBeCloseTo([8, 7, 6, 5, 4][index], 8),
  );
  expect(result.samples.every(({ diagnostics }) => diagnostics.drawCalls <= 1)).toBe(true);
  expect(result.samples[0].color).toEqual(detail);
  expect(result.samples[4].color).toEqual(state);
  const midpoint = detail.map((channel, index) => Math.round((channel + state[index]) / 2));
  result.samples[2].color.forEach((channel, index) => expect(Math.abs(channel - midpoint[index])).toBeLessThanOrEqual(1));
});

test("R25 — low-zoom state colors approximate the visual average of detailed cells", async ({ page }) => {
  await openDeterministicGame(page);
  const result = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    const canvas = document.querySelector<HTMLCanvasElement>("#board");
    if (!canvas) throw new Error("Missing board");
    const states = [2, 10, 11, 12];
    const targets = [-9, -3, 3, 9].map((initialX, index) => {
      let x = initialX;
      while (api.model.artifactAt(x, 0)) x += 1;
      api.model.store.set(x, 0, states[index]);
      return { x, state: states[index] };
    });
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    renderer.restoreView({ version: 1, zoom: 2, panX: 0, panY: 0 });
    await settle();
    const bounds = canvas.getBoundingClientRect();
    const gl = renderer.gl;
    gl.finish();
    const dpr = canvas.width / bounds.width;
    const detailed = targets.map(({ x }) => {
      const cellSize = renderer.cellSize;
      const left = bounds.width / 2 + renderer.panX + (x - 0.5) * cellSize;
      const top = bounds.height / 2 + renderer.panY - cellSize / 2;
      const inset = 1;
      const width = Math.round((cellSize - inset * 2) * dpr);
      const height = Math.round((cellSize - inset * 2) * dpr);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(
        Math.round((left + inset) * dpr),
        canvas.height - Math.round((top + cellSize - inset) * dpr),
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      const totals = [0, 0, 0];
      for (let pixel = 0; pixel < pixels.length; pixel += 4) {
        totals[0] += pixels[pixel];
        totals[1] += pixels[pixel + 1];
        totals[2] += pixels[pixel + 2];
      }
      const count = pixels.length / 4;
      return totals.map((total) => Math.round(total / count));
    });

    renderer.restoreView({ version: 1, zoom: 0.04, panX: 0, panY: 0 });
    await settle();
    gl.finish();
    const pixels = targets.map(({ x }) => {
      const pixel = new Uint8Array(4);
      const cssX = bounds.width / 2 + x;
      const cssY = bounds.height / 2;
      gl.readPixels(
        Math.floor(cssX * dpr),
        canvas.height - 1 - Math.floor(cssY * dpr),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      return Array.from(pixel.slice(0, 3));
    });
    return { detailed, pixels };
  });

  result.pixels.forEach((pixel, stateIndex) =>
    pixel.forEach((channel, channelIndex) =>
      expect(Math.abs(channel - result.detailed[stateIndex][channelIndex])).toBeLessThanOrEqual(12),
    ),
  );
});

test("R04/R12 — million-cell zoom and drag stay on one sparse GPU draw", async ({ page }) => {
  await openDeterministicGame(page);
  await page.evaluate(async () => {
    const renderer = window.__infiniteMines.renderer;
    const canvas = document.querySelector<HTMLCanvasElement>("#board");
    if (!canvas) throw new Error("Missing board");
    renderer.home();
    const bounds = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
        deltaY: 10_000,
      }),
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const hudBefore = await page.locator(".stats").textContent();
  const performance = await page.evaluate(
    () =>
      new Promise<{
        uploadsBefore: number;
        uploadsAfter: number;
        p95: number;
        diagnostics: ReturnType<typeof window.__infiniteMines.diagnostics>;
      }>((resolve) => {
        const renderer = window.__infiniteMines.renderer;
        const uploadsBefore = window.__infiniteMines.diagnostics().instanceUploads;
        const intervals: number[] = [];
        let previous = 0;
        let frame = 0;
        const step = (time: number) => {
          if (previous > 0) intervals.push(time - previous);
          previous = time;
          renderer.panBy(-0.5, 0);
          frame += 1;
          if (frame < 180) {
            requestAnimationFrame(step);
            return;
          }
          renderer.finishPan();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              intervals.sort((a, b) => a - b);
              resolve({
                uploadsBefore,
                uploadsAfter: window.__infiniteMines.diagnostics().instanceUploads,
                p95: intervals[Math.floor(intervals.length * 0.95)],
                diagnostics: window.__infiniteMines.diagnostics(),
              });
            }),
          );
        };
        requestAnimationFrame(step);
      }),
  );
  expect(performance.uploadsAfter).toBe(performance.uploadsBefore);
  expect(performance.diagnostics.drawCalls).toBeLessThanOrEqual(1);
  expect(performance.diagnostics.cachedTiles).toBeLessThanOrEqual(2048);
  expect(performance.diagnostics.visibleCells).toBeGreaterThan(1_000_000);
  expect(performance.diagnostics.frameMs).toBeLessThan(10);
  expect(performance.p95).toBeLessThan(35);
  expect(await page.locator(".stats").textContent()).toBe(hudBefore);

  const frameCount = performance.diagnostics.frameCount;
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBe(frameCount);
});

test("R06 — Retina output, fractional transforms, and drag-time resolution switching remain exact", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 3 });
  const page = await context.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  try {
    await openDeterministicGame(page);
    const resting = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#board");
      if (!canvas) throw new Error("Missing board");
      const bounds = canvas.getBoundingClientRect();
      return {
        diagnostics: window.__infiniteMines.diagnostics(),
        backingRatio: canvas.width / bounds.width,
      };
    });
    expect(resting.diagnostics.pixelRatio).toBe(2);
    expect(resting.backingRatio).toBe(2);

    const fractional = await page.evaluate(async () => {
      const renderer = window.__infiniteMines.renderer;
      renderer.zoomAt(500, 400, 1.37);
      renderer.panBy(0.25, 0.5);
      renderer.finishPan();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { view: renderer.createViewSnapshot(), diagnostics: window.__infiniteMines.diagnostics() };
    });
    expect(fractional.view.zoom).toBeCloseTo(1.37, 8);
    expect(fractional.diagnostics.cellSize).toBeCloseTo(34.25, 8);
    expect(fractional.diagnostics.borderCssPixels).toBe(1);
    expect(fractional.diagnostics.pixelRatio).toBe(2);

    await page.mouse.move(450, 400);
    await page.mouse.down();
    await page.mouse.move(470, 400);
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().pixelRatio)).toBe(1);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().pixelRatio)).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
