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

test("R06 — Retina output and fractional transforms remain exact throughout dragging", async ({ browser }) => {
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
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().pixelRatio)).toBe(2);
    expect(
      await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("#board");
        if (!canvas) throw new Error("Missing board");
        return canvas.width / canvas.getBoundingClientRect().width;
      }),
    ).toBe(2);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().pixelRatio)).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("R31 — a one-pixel pan translates framebuffer grid edges without a start or release resnap", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 3 });
  const page = await context.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  try {
    await openDeterministicGame(page);
    const result = await page.evaluate(async () => {
      const api = window.__infiniteMines;
      const renderer = api.renderer;
      const canvas = document.querySelector<HTMLCanvasElement>("#board");
      if (!canvas) throw new Error("Missing board");
      const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      renderer.home();
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -8; x <= 8; x += 1) api.model.store.set(x, y, 1);
      }
      renderer.requestRender();
      await settle();

      const borderHex = getComputedStyle(document.documentElement).getPropertyValue("--board-cell-border").trim();
      const border = [
        Number.parseInt(borderHex.slice(1, 3), 16),
        Number.parseInt(borderHex.slice(3, 5), 16),
        Number.parseInt(borderHex.slice(5, 7), 16),
      ];
      const readBorderCenters = () => {
        const bounds = canvas.getBoundingClientRect();
        const dpr = canvas.width / bounds.width;
        const startCss = bounds.width / 2 - 80;
        const widthCss = 160;
        const x = Math.floor(startCss * dpr);
        const y = Math.floor((bounds.height / 2 + 8) * dpr);
        const width = Math.floor(widthCss * dpr);
        const pixels = new Uint8Array(width * 4);
        renderer.gl.finish();
        renderer.gl.readPixels(
          x,
          canvas.height - 1 - y,
          width,
          1,
          renderer.gl.RGBA,
          renderer.gl.UNSIGNED_BYTE,
          pixels,
        );
        const matches: number[] = [];
        for (let index = 0; index < width; index += 1) {
          const offset = index * 4;
          const distance = Math.hypot(
            pixels[offset] - border[0],
            pixels[offset + 1] - border[1],
            pixels[offset + 2] - border[2],
          );
          if (distance < 45) matches.push((x + index + 0.5) / dpr);
        }
        const runs: number[][] = [];
        for (const position of matches) {
          const run = runs.at(-1);
          if (!run || position - run.at(-1)! > 1 / dpr + 0.0001) runs.push([position]);
          else run.push(position);
        }
        return {
          dpr,
          centers: runs.map((run) => (run[0] + run.at(-1)!) / 2),
        };
      };

      const before = readBorderCenters();
      renderer.panBy(1, 0);
      await settle();
      const during = readBorderCenters();
      const framesBeforeRelease = api.diagnostics().frameCount;
      renderer.finishPan();
      await settle();
      const after = readBorderCenters();
      const releaseFrames = api.diagnostics().frameCount - framesBeforeRelease;
      const frameIntervals: number[] = [];
      await new Promise<void>((resolve) => {
        let previous = 0;
        let frame = 0;
        const step = (time: number) => {
          if (previous > 0) frameIntervals.push(time - previous);
          previous = time;
          renderer.panBy(frame % 2 === 0 ? 1 : -1, 0);
          frame += 1;
          if (frame < 90) requestAnimationFrame(step);
          else {
            renderer.finishPan();
            requestAnimationFrame(() => resolve());
          }
        };
        requestAnimationFrame(step);
      });
      frameIntervals.sort((a, b) => a - b);
      const frameP95 = frameIntervals[Math.floor(frameIntervals.length * 0.95)];
      return { before, during, after, releaseFrames, frameP95 };
    });

    expect(result.before.dpr).toBe(2);
    expect(result.during.dpr).toBe(2);
    expect(result.after.dpr).toBe(2);
    expect(result.before.centers.length).toBeGreaterThanOrEqual(5);
    expect(result.during.centers).toHaveLength(result.before.centers.length);
    expect(result.after.centers).toHaveLength(result.before.centers.length);
    expect(result.releaseFrames).toBe(0);
    result.before.centers.forEach((center, index) => {
      expect(result.during.centers[index] - center).toBeCloseTo(1, 8);
      expect(result.after.centers[index]).toBeCloseTo(result.during.centers[index], 8);
    });
    expect(result.frameP95).toBeLessThan(35);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("R34 — cell damage and integral pans preserve untouched framebuffer pixels", async ({ page }) => {
  await openDeterministicGame(page);
  const result = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    const gl = renderer.gl;
    const canvas = document.querySelector<HTMLCanvasElement>("#board");
    if (!canvas) throw new Error("Missing board");
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const readFrame = () => {
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.finish();
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const equalFrames = (left: Uint8Array, right: Uint8Array) => {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
      }
      return true;
    };

    renderer.home();
    await settle();
    let target: { x: number; y: number } | null = null;
    for (let y = -12; y <= 12 && target === null; y += 1) {
      for (let x = -20; x <= 20; x += 1) {
        if (api.model.getState(x, y) === 0) {
          target = { x, y };
          break;
        }
      }
    }
    if (!target) throw new Error("No covered on-screen cell");

    const beforeDamage = readFrame();
    const action = api.model.cycleMark(target.x, target.y);
    if (!action.damage) throw new Error("Missing action damage");
    renderer.requestRender(action.damage);
    await settle();
    const damageDiagnostics = api.diagnostics();
    const afterDamage = readFrame();
    renderer.requestRender();
    await settle();
    const forcedDamageFrame = readFrame();

    let changedPixels = 0;
    for (let index = 0; index < beforeDamage.length; index += 4) {
      if (
        beforeDamage[index] !== afterDamage[index] ||
        beforeDamage[index + 1] !== afterDamage[index + 1] ||
        beforeDamage[index + 2] !== afterDamage[index + 2] ||
        beforeDamage[index + 3] !== afterDamage[index + 3]
      ) {
        changedPixels += 1;
      }
    }

    const beforePan = forcedDamageFrame;
    renderer.panBy(1, 0);
    await settle();
    const panDiagnostics = api.diagnostics();
    const afterPan = readFrame();
    renderer.requestRender();
    await settle();
    const forcedPanFrame = readFrame();

    renderer.panBy(0.5, 0);
    await settle();
    const fractionalDiagnostics = api.diagnostics();
    const afterFractional = readFrame();
    renderer.requestRender();
    await settle();
    const forcedFractionalFrame = readFrame();

    renderer.home();
    renderer.zoom = 0.32;
    for (let y = -65; y <= 65; y += 1) {
      for (let x = -110; x <= 110; x += 1) api.model.store.set(x, y, 2);
    }
    renderer.requestRender();
    await settle();
    const beforeDensePan = readFrame();
    renderer.panBy(1, 0);
    await settle();
    const densePanDiagnostics = api.diagnostics();
    const afterDensePan = readFrame();
    renderer.requestRender();
    await settle();
    const forcedDensePanFrame = readFrame();

    return {
      contextPreserved: gl.getContextAttributes()?.preserveDrawingBuffer ?? false,
      canvasWidth: canvas.width,
      changedPixels,
      damageDiagnostics,
      damageMatchesFull: equalFrames(afterDamage, forcedDamageFrame),
      panDiagnostics,
      panMatchesFull: equalFrames(afterPan, forcedPanFrame),
      panChanged: !equalFrames(beforePan, afterPan),
      fractionalDiagnostics,
      fractionalMatchesFull: equalFrames(afterFractional, forcedFractionalFrame),
      densePanDiagnostics,
      densePanChanged: !equalFrames(beforeDensePan, afterDensePan),
      densePanMatchesFull: equalFrames(afterDensePan, forcedDensePanFrame),
    };
  });

  expect(result.contextPreserved).toBe(true);
  expect(result.changedPixels).toBeGreaterThan(0);
  expect(result.damageDiagnostics.redrawMode).toBe("damage");
  expect(result.damageDiagnostics.redrawnPixels / result.damageDiagnostics.canvasPixels).toBeLessThan(0.02);
  expect(result.damageMatchesFull).toBe(true);
  expect(result.panDiagnostics.redrawMode).toBe("full");
  expect(result.panDiagnostics.redrawnPixels).toBe(result.panDiagnostics.canvasPixels);
  expect(result.panDiagnostics.blittedPixels).toBe(0);
  expect(result.panChanged).toBe(true);
  expect(result.panMatchesFull).toBe(true);
  expect(result.fractionalDiagnostics.redrawMode).toBe("full");
  expect(result.fractionalMatchesFull).toBe(true);
  expect(result.densePanDiagnostics.drawnCells).toBeGreaterThanOrEqual(20_000);
  expect(result.densePanDiagnostics.redrawMode).toBe("pan");
  expect(result.densePanDiagnostics.redrawnPixels).toBe(
    result.densePanDiagnostics.canvasPixels / result.canvasWidth,
  );
  expect(result.densePanDiagnostics.blittedPixels).toBe(
    result.densePanDiagnostics.canvasPixels - result.densePanDiagnostics.redrawnPixels,
  );
  expect(result.densePanChanged).toBe(true);
  expect(result.densePanMatchesFull).toBe(true);
});

test("R36 — covered/open boundary corners stay on one device-pixel lattice", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 3 });
  const page = await context.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  try {
    await openDeterministicGame(page);
    const result = await page.evaluate(async () => {
      const api = window.__infiniteMines;
      const renderer = api.renderer;
      const gl = renderer.gl;
      const canvas = document.querySelector<HTMLCanvasElement>("#board");
      if (!canvas) throw new Error("Missing board");
      const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const equalFrames = (left: Uint8Array, right: Uint8Array) => {
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
          if (left[index] !== right[index]) return false;
        }
        return true;
      };
      const readFrame = () => {
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.finish();
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };

      api.model.store.clear();
      // An L opening whose vertical boundary switches from exposed to shared.
      api.model.store.set(0, 0, 1);
      api.model.store.set(0, 1, 1);
      api.model.store.set(1, 1, 1);
      // Its rotated counterpart exercises the same ownership transition horizontally.
      api.model.store.set(4, 0, 1);
      api.model.store.set(5, 0, 1);
      api.model.store.set(5, 1, 1);

      const borderHex = getComputedStyle(document.documentElement).getPropertyValue("--board-cell-border").trim();
      const border = [
        Number.parseInt(borderHex.slice(1, 3), 16),
        Number.parseInt(borderHex.slice(3, 5), 16),
        Number.parseInt(borderHex.slice(5, 7), 16),
      ];
      const bounds = canvas.getBoundingClientRect();
      const dpr = canvas.width / bounds.width;
      const isBorder = (x: number, topY: number) => {
        const pixel = new Uint8Array(4);
        gl.readPixels(x, canvas.height - 1 - topY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return Math.hypot(pixel[0] - border[0], pixel[1] - border[1], pixel[2] - border[2]) < 45;
      };
      const borderRun = (axis: "x" | "y", edgeCss: number, sampleCss: number) => {
        gl.finish();
        const edge = Math.floor(edgeCss * dpr + 0.5);
        const sample = Math.floor(sampleCss * dpr);
        const radius = Math.ceil(3 * dpr);
        const matches: number[] = [];
        for (let position = edge - radius; position <= edge + radius; position += 1) {
          const x = axis === "x" ? position : sample;
          const y = axis === "x" ? sample : position;
          if (isBorder(x, y)) matches.push(position);
        }
        const runs: number[][] = [];
        for (const position of matches) {
          const run = runs.at(-1);
          if (!run || position !== run.at(-1)! + 1) runs.push([position]);
          else run.push(position);
        }
        const nearest = runs.sort((left, right) => {
          const leftCenter = (left[0] + left.at(-1)! + 1) / 2;
          const rightCenter = (right[0] + right.at(-1)! + 1) / 2;
          return Math.abs(leftCenter - edge) - Math.abs(rightCenter - edge);
        })[0];
        if (!nearest) throw new Error(`No ${axis}-axis border run near ${edgeCss}`);
        return {
          width: nearest.length,
          center: (nearest[0] + nearest.at(-1)! + 1) / 2 / dpr,
        };
      };

      const samples: Array<{
        cellSize: number;
        verticalShift: number;
        horizontalShift: number;
        verticalWidths: number[];
        horizontalWidths: number[];
      }> = [];
      for (const view of [
        { cellSize: 25, panX: 0.25, panY: 0.75 },
        { cellSize: 34.25, panX: -0.35, panY: 0.2 },
        { cellSize: 8, panX: 0.4, panY: -0.3 },
      ]) {
        renderer.restoreView({ version: 1, zoom: view.cellSize / 25, panX: view.panX, panY: view.panY });
        await settle();
        const centerX = bounds.width / 2 + view.panX;
        const centerY = bounds.height / 2 + view.panY;
        const verticalEdge = centerX + view.cellSize * 0.5;
        const verticalTop = borderRun("x", verticalEdge, centerY);
        const verticalBottom = borderRun("x", verticalEdge, centerY + view.cellSize);
        const horizontalEdge = centerY + view.cellSize * 0.5;
        const horizontalLeft = borderRun("y", horizontalEdge, centerX + view.cellSize * 4);
        const horizontalRight = borderRun("y", horizontalEdge, centerX + view.cellSize * 5);
        samples.push({
          cellSize: view.cellSize,
          verticalShift: verticalBottom.center - verticalTop.center,
          horizontalShift: horizontalRight.center - horizontalLeft.center,
          verticalWidths: [verticalTop.width, verticalBottom.width],
          horizontalWidths: [horizontalLeft.width, horizontalRight.width],
        });
      }

      renderer.restoreView({ version: 1, zoom: 1, panX: 0.25, panY: 0.75 });
      await settle();
      api.model.store.set(1, 0, 1);
      renderer.requestRender({ minX: 1, minY: 0, maxX: 1, maxY: 0 });
      await settle();
      const damageDiagnostics = api.diagnostics();
      const damageFrame = readFrame();
      renderer.requestRender();
      await settle();
      const forcedFrame = readFrame();

      return {
        dpr,
        samples,
        damageMode: damageDiagnostics.redrawMode,
        damageMatchesFull: equalFrames(damageFrame, forcedFrame),
      };
    });

    expect(result.dpr).toBe(2);
    for (const sample of result.samples) {
      expect(sample.verticalWidths, `vertical widths at ${sample.cellSize}px`).toEqual([result.dpr, result.dpr]);
      expect(sample.horizontalWidths, `horizontal widths at ${sample.cellSize}px`).toEqual([result.dpr, result.dpr]);
      expect(sample.verticalShift, `vertical corner shift at ${sample.cellSize}px`).toBeCloseTo(0, 8);
      expect(sample.horizontalShift, `horizontal corner shift at ${sample.cellSize}px`).toBeCloseTo(0, 8);
    }
    expect(result.damageMode).toBe("damage");
    expect(result.damageMatchesFull).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
