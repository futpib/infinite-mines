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
        deltaY: -Math.log(0.04) / 0.0012,
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

  expect(result.view.zoom).toBeCloseTo(0.04, 12);
  expect(result.diagnostics.cellSize).toBeCloseTo(1, 12);
  expect(result.diagnostics.lod).toBe("pixel");
  expect(result.diagnostics.borderCssPixels).toBe(0);
  expect(result.diagnostics.glyphs).toBe(false);
  expect(result.diagnostics.visibleCells).toBeGreaterThan(1_000_000);
  const colors = Object.values(result.colors);
  expect(new Set(colors.map((color) => color.join(","))).size).toBe(colors.length);
  for (const color of colors) expect(color).not.toEqual(hexToRgb(result.expected.background));
});

test("R55 — subpixel overview uses discrete 1×1 through 8×8 aggregates and blocks cell actions", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await openDeterministicGame(page);
  const report = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    const canvas = document.querySelector<HTMLCanvasElement>("#board");
    if (!canvas) throw new Error("Missing board");
    const settle = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const hashBytes = (bytes: Uint8Array) => {
      let hash = 0x811c9dc5;
      for (const value of bytes) hash = Math.imul(hash ^ value, 0x01000193);
      return hash >>> 0;
    };
    const modelHash = () => hashBytes(new Uint8Array(api.model.createSnapshot().cells));
    const framebufferHash = () => {
      const gl = renderer.gl;
      gl.finish();
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return hashBytes(pixels);
    };
    const percentile = (values: number[], fraction: number) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
    };

    api.model.reset("beginner", 0x55aa_0001, false, "square", 0.18, false);
    for (let y = -64; y < 64; y += 1) {
      for (let x = -64; x < 64; x += 1) {
        if (x !== 0 || y !== 0) api.model.store.set(x, y, 2);
      }
    }
    api.model.store.set(1, 0, 10);
    api.model.store.set(2, 0, 12);
    renderer.restoreView({ version: 1, zoom: 0.04, panX: 0, panY: 0 });
    await settle();
    const focus = { x: canvas.clientWidth * 0.67, y: canvas.clientHeight * 0.61 };
    const initialFocus = renderer.screenToCell(focus.x, focus.y);
    const steps = [];
    for (let blockSize = 1; blockSize <= 8; blockSize += 1) {
      if (blockSize > 1) renderer.zoomAt(focus.x, focus.y, (blockSize - 1) / blockSize);
      await settle();
      steps.push({
        blockSize,
        focusCell: renderer.screenToCell(focus.x, focus.y),
        diagnostics: api.diagnostics(),
        view: renderer.createViewSnapshot(),
      });
    }

    const priorityBefore = framebufferHash();
    api.model.store.set(3, 0, 11);
    renderer.requestRender();
    await settle();
    const priorityAfter = framebufferHash();
    const beforeModel = modelHash();
    const beforeFramebuffer = framebufferHash();
    const beforePan = renderer.createViewSnapshot();
    renderer.panBy(1, 0);
    await settle();
    renderer.panBy(-1, 0);
    await settle();
    const afterRoundTripFramebuffer = framebufferHash();
    const intervals: number[] = [];
    const beforeMotion = api.diagnostics();
    await new Promise<void>((resolve) => {
      let frame = 0;
      let previous = 0;
      const tick = (timestamp: number) => {
        if (previous > 0) intervals.push(timestamp - previous);
        previous = timestamp;
        renderer.panBy(frame % 2 === 0 ? 1 : -1, 0);
        frame += 1;
        if (frame < 90) requestAnimationFrame(tick);
        else requestAnimationFrame(() => resolve());
      };
      requestAnimationFrame(tick);
    });
    const afterMotion = api.diagnostics();
    return {
      initialFocus,
      steps,
      priorityBefore,
      priorityAfter,
      beforeModel,
      beforeFramebuffer,
      afterRoundTripFramebuffer,
      beforePan,
      afterPan: renderer.createViewSnapshot(),
      frameP95: percentile(intervals, 0.95),
      framesOver34Ms: intervals.filter((value) => value > 34).length,
      uploads: afterMotion.instanceUploads - beforeMotion.instanceUploads,
      frameCount: afterMotion.frameCount - beforeMotion.frameCount,
    };
  });

  await testInfo.attach("discrete-overview-zoom.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  expect(report.steps.map((step) => step.diagnostics.overviewBlockSize)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(report.steps.map((step) => step.diagnostics.lod)).toEqual([
    "pixel",
    "overview",
    "overview",
    "overview",
    "overview",
    "overview",
    "overview",
    "overview",
  ]);
  for (const step of report.steps) {
    expect(step.diagnostics.cellSize).toBeCloseTo(1 / step.blockSize, 10);
    expect(step.diagnostics.drawCalls).toBe(1);
    expect(step.diagnostics.glyphs).toBe(false);
    expect(step.focusCell).toEqual(report.initialFocus);
  }
  expect(report.steps.at(-1)?.diagnostics.visibleCells).toBeGreaterThan(80_000_000);
  expect(report.steps.at(-1)?.diagnostics.drawnCells).toBeLessThan(report.steps[0].diagnostics.drawnCells);
  expect(report.steps.at(-1)?.diagnostics.hoveredCells).toBe(0);
  expect(report.steps.at(-1)?.view.zoom).toBeCloseTo(0.005, 12);
  expect(report.priorityAfter).toBe(report.priorityBefore);
  expect(report.beforeFramebuffer).toBe(report.afterRoundTripFramebuffer);
  expect(report.beforePan).toEqual(report.afterPan);
  expect(report.frameP95).toBeLessThan(35);
  expect(report.framesOver34Ms).toBe(0);
  expect(report.uploads).toBe(0);
  expect(report.frameCount).toBeGreaterThanOrEqual(90);

  const board = page.locator("#board");
  const boardBounds = await board.boundingBox();
  if (!boardBounds) throw new Error("Missing board bounds");
  const beforeClick = await page.evaluate(() => new Uint8Array(window.__infiniteMines.model.createSnapshot().cells));
  await page.mouse.click(boardBounds.x + boardBounds.width / 2, boardBounds.y + boardBounds.height / 2, {
    button: "right",
  });
  await expect(page.locator("#toast")).toContainText("8×8 overview — zoom in to play");
  expect(await page.evaluate(() => new Uint8Array(window.__infiniteMines.model.createSnapshot().cells))).toEqual(beforeClick);
  await expect(page.locator("#cell-locator")).toBeDisabled();
  await expect(page.locator("#cell-state")).toHaveText("8×8 OVERVIEW · ZOOM IN TO PLAY");

  await page.evaluate(() => window.__infiniteMines.flushSave());
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().persistenceStatus)).toBe("restored");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().overviewBlockSize)).toBe(8);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics())).toMatchObject({
    lod: "overview",
    cellSize: 0.125,
    overviewBlockSize: 8,
    drawCalls: 1,
  });
  const displayRoundTrips = await page.evaluate(async () => {
    const renderer = window.__infiniteMines.renderer;
    const settle = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const framebufferHash = () => {
      const gl = renderer.gl;
      gl.finish();
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let hash = 0x811c9dc5;
      for (const value of pixels) hash = Math.imul(hash ^ value, 0x01000193);
      return hash >>> 0;
    };
    const originalTheme = document.documentElement.dataset.theme ?? "light";
    const alternateTheme = originalTheme === "dark" ? "light" : "dark";
    const baseline = framebufferHash();
    renderer.setRotation(90);
    await settle();
    const rotated = window.__infiniteMines.diagnostics();
    renderer.setRotation(0);
    await settle();
    const afterRotation = framebufferHash();
    document.documentElement.dataset.theme = alternateTheme;
    renderer.refreshTheme();
    await settle();
    const alternateThemeHash = framebufferHash();
    document.documentElement.dataset.theme = originalTheme;
    renderer.refreshTheme();
    await settle();
    return {
      baseline,
      rotated,
      afterRotation,
      alternateThemeHash,
      afterTheme: framebufferHash(),
    };
  });
  expect(displayRoundTrips.rotated).toMatchObject({ rotation: 90, overviewBlockSize: 8, drawCalls: 1 });
  expect(displayRoundTrips.afterRotation).toBe(displayRoundTrips.baseline);
  expect(displayRoundTrips.alternateThemeHash).not.toBe(displayRoundTrips.baseline);
  expect(displayRoundTrips.afterTheme).toBe(displayRoundTrips.baseline);
  const reverse = await page.evaluate(async () => {
    const renderer = window.__infiniteMines.renderer;
    const settle = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const blocks = [];
    for (let blockSize = 7; blockSize >= 1; blockSize -= 1) {
      renderer.zoomAt(renderer.canvas.clientWidth / 2, renderer.canvas.clientHeight / 2, (blockSize + 1) / blockSize);
      await settle();
      blocks.push(window.__infiniteMines.diagnostics().overviewBlockSize);
    }
    return { blocks, diagnostics: window.__infiniteMines.diagnostics(), input: renderer.cellInputEnabled };
  });
  expect(reverse.blocks).toEqual([7, 6, 5, 4, 3, 2, 1]);
  expect(reverse.diagnostics).toMatchObject({ lod: "pixel", cellSize: 1, overviewBlockSize: 1 });
  expect(reverse.input).toBe(true);
  await page.mouse.move(boardBounds.x + boardBounds.width / 2, boardBounds.y + boardBounds.height / 2);
  await expect(page.locator("#cell-locator")).toBeEnabled();

  await page.mouse.wheel(0, -Math.log(0.5) / 0.0012);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().overviewBlockSize)).toBe(2);
  await expect(page.locator("#cell-locator")).toBeDisabled();
  await page.mouse.wheel(0, Math.log(0.5) / 0.0012);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().overviewBlockSize)).toBe(1);
  await expect(page.locator("#cell-locator")).toBeEnabled();
});

test("R55 — every Euclidean topology shares the bounded 8×8 overview path", async ({ page }) => {
  await openDeterministicGame(page);
  const report = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    const settle = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const results: Record<
      string,
      {
        beforeFocus: { x: number; y: number };
        afterFocus: { x: number; y: number };
        overview: ReturnType<typeof api.diagnostics>;
        rotated: ReturnType<typeof api.diagnostics>;
      }
    > = {};
    for (const topology of ["square", "hexagonal", "triangular", "rhombille"] as const) {
      api.model.reset("beginner", 0x55aa_0002, false, topology, undefined, false);
      for (let y = -24; y <= 24; y += 1) {
        for (let x = -24; x <= 24; x += 1) api.model.store.set(x, y, 2);
      }
      renderer.home();
      renderer.setRotation(0);
      renderer.restoreView({ version: 1, zoom: 0.04, panX: 0, panY: 0 });
      const focus = { x: renderer.canvas.clientWidth * 0.61, y: renderer.canvas.clientHeight * 0.37 };
      const beforeFocus = renderer.screenToCell(focus.x, focus.y);
      renderer.zoomAt(focus.x, focus.y, 1 / 8);
      await settle();
      const afterFocus = renderer.screenToCell(focus.x, focus.y);
      const overview = api.diagnostics();
      renderer.setRotation(90);
      await settle();
      results[topology] = { beforeFocus, afterFocus, overview, rotated: api.diagnostics() };
    }
    return results;
  });
  for (const topology of ["square", "hexagonal", "triangular", "rhombille"] as const) {
    const result = report[topology];
    expect(result.afterFocus).toEqual(result.beforeFocus);
    expect(result.overview).toMatchObject({
      topology,
      lod: "overview",
      cellSize: 0.125,
      overviewBlockSize: 8,
      drawCalls: 1,
      glyphs: false,
      hoveredCells: 0,
    });
    expect(result.overview.drawnCells).toBeGreaterThan(0);
    expect(result.overview.drawnCells).toBeLessThan(result.overview.storedCells);
    expect(result.rotated).toMatchObject({ topology, rotation: 90, overviewBlockSize: 8, drawCalls: 1 });
  }
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

test("R49 — emoji Things embed fixed vector artwork with exact alpha into reserved topology cells", async ({ page }) => {
  await openDeterministicGame(page, 0x5eed_1234);
  await page.evaluate(async () => {
    const api = window.__infiniteMines;
    await api.setThingsEnabled(true);
    api.model.reset("beginner", 0x5eed_1234, false, "square", undefined, true);
    api.renderer.syncThings();
  });
  const result = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    await renderer.waitForThingSprites();
    const privateModel = api.model as unknown as {
      artifactForZone(zoneX: number, zoneY: number): { x: number; y: number };
    };
    const nearbySprites: number[] = [];
    for (let zoneY = -1; zoneY <= 1; zoneY += 1) {
      for (let zoneX = -1; zoneX <= 1; zoneX += 1) {
        const nearby = privateModel.artifactForZone(zoneX, zoneY);
        const nearbyVisual = api.model.thingVisualAt(nearby.x, nearby.y);
        if (!nearbyVisual) throw new Error(`Missing Thing in zone ${zoneX},${zoneY}`);
        nearbySprites.push(nearbyVisual.sprite);
      }
    }
    let artifact: {
      x: number;
      y: number;
      cells: readonly { x: number; y: number }[];
      artCells: readonly { x: number; y: number }[];
      reservedCells: readonly { x: number; y: number }[];
      side: number;
      sprite: number;
    } | null = null;
    search: for (let zoneY = -200; zoneY <= 200; zoneY += 1) {
      for (let zoneX = -200; zoneX <= 200; zoneX += 1) {
        const anchor = privateModel.artifactForZone(zoneX, zoneY);
        const visual = api.model.thingVisualAt(anchor.x, anchor.y);
        if (visual?.side === 4 && visual.sprite === 0) {
          artifact = visual;
          break search;
        }
      }
    }
    if (!artifact) throw new Error("No deterministic four-cell castle Thing found");
    const atlasSlot = await renderer.waitForThingSprite(artifact.sprite);
    api.reveal(artifact.x, artifact.y);
    const zoom = 2;
    const cellSize = 25 * zoom;
    const origin = api.model.topology.origin;
    const visualMinX = Math.min(...artifact.cells.map((cell) => cell.x));
    const visualMinY = Math.min(...artifact.cells.map((cell) => cell.y));
    const visualMaxX = Math.max(...artifact.cells.map((cell) => cell.x));
    const visualMaxY = Math.max(...artifact.cells.map((cell) => cell.y));
    renderer.restoreView({
      version: 1,
      zoom,
      panX: -((visualMinX + visualMaxX) / 2 - origin.x) * cellSize,
      panY: -((visualMinY + visualMaxY) / 2 - origin.y) * cellSize,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const gl = renderer.gl;
    gl.finish();
    const visualPolygon = artifact.cells.flatMap((cell) => renderer.cellScreenPolygon(cell.x, cell.y));
    const dpr = renderer.diagnostics.pixelRatio;
    const left = Math.ceil(Math.min(...visualPolygon.map((point) => point.x)) * dpr);
    const right = Math.floor(Math.max(...visualPolygon.map((point) => point.x)) * dpr);
    const top = Math.ceil(Math.min(...visualPolygon.map((point) => point.y)) * dpr);
    const bottom = Math.floor(Math.max(...visualPolygon.map((point) => point.y)) * dpr);
    const width = right - left;
    const height = bottom - top;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(left, renderer.canvas.height - bottom, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const colorful = (offset: number): boolean => {
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      return Math.max(red, green, blue) - Math.min(red, green, blue) > 38;
    };
    const colors = new Set<string>();
    const backing = [pixels[0], pixels[1], pixels[2]];
    let colorfulPixels = 0;
    let colorfulMinX = width;
    let colorfulMinY = height;
    let colorfulMaxX = 0;
    let colorfulMaxY = 0;
    let subjectMinX = width;
    let subjectMinY = height;
    let subjectMaxX = 0;
    let subjectMaxY = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const offset = (y * width + x) * 4;
        if (
          Math.max(
            Math.abs(pixels[offset] - backing[0]),
            Math.abs(pixels[offset + 1] - backing[1]),
            Math.abs(pixels[offset + 2] - backing[2]),
          ) > 18
        ) {
          subjectMinX = Math.min(subjectMinX, x);
          subjectMinY = Math.min(subjectMinY, y);
          subjectMaxX = Math.max(subjectMaxX, x);
          subjectMaxY = Math.max(subjectMaxY, y);
        }
        if (!colorful(offset)) continue;
        colorfulPixels += 1;
        colorfulMinX = Math.min(colorfulMinX, x);
        colorfulMinY = Math.min(colorfulMinY, y);
        colorfulMaxX = Math.max(colorfulMaxX, x);
        colorfulMaxY = Math.max(colorfulMaxY, y);
        colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
      }
    }
    const privateRenderer = renderer as unknown as {
      thingEmojiAtlas: HTMLCanvasElement;
      resources: { thingAtlasTexture: WebGLTexture };
    };
    const thingAtlas = privateRenderer.thingEmojiAtlas;
    const thingContext = thingAtlas.getContext("2d");
    if (!thingContext) throw new Error("Missing Thing atlas context");
    const atlasPixels = thingContext.getImageData(
      (atlasSlot % 8) * 512,
      Math.floor(atlasSlot / 8) * 512,
      512,
      512,
    ).data;
    const alphaLevels = new Set<number>();
    const atlasColors = new Set<string>();
    let transparentPixels = 0;
    let partialAlphaPixels = 0;
    let opaquePixels = 0;
    for (let offset = 0; offset < atlasPixels.length; offset += 4) {
      const alpha = atlasPixels[offset + 3];
      alphaLevels.add(alpha);
      if (alpha === 0) transparentPixels += 1;
      else if (alpha === 255) opaquePixels += 1;
      else partialAlphaPixels += 1;
      if (alpha > 0) {
        atlasColors.add(`${atlasPixels[offset]},${atlasPixels[offset + 1]},${atlasPixels[offset + 2]},${alpha}`);
      }
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, privateRenderer.resources.thingAtlasTexture);
    const transparentAtlas = document.createElement("canvas");
    transparentAtlas.width = thingAtlas.width;
    transparentAtlas.height = thingAtlas.height;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, transparentAtlas);
    renderer.requestRender();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    gl.finish();
    const withoutThing = new Uint8Array(width * height * 4);
    gl.readPixels(left, renderer.canvas.height - bottom, width, height, gl.RGBA, gl.UNSIGNED_BYTE, withoutThing);
    let unchangedPixels = 0;
    let changedPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const difference = Math.max(
        Math.abs(pixels[offset] - withoutThing[offset]),
        Math.abs(pixels[offset + 1] - withoutThing[offset + 1]),
        Math.abs(pixels[offset + 2] - withoutThing[offset + 2]),
      );
      if (difference === 0) unchangedPixels += 1;
      if (difference > 2) changedPixels += 1;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, thingAtlas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    renderer.requestRender();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
      artifact,
      visualCellsReserved: artifact.cells.map((cell) => api.model.thingFootprintAt(cell.x, cell.y)),
      artCellsReserved: artifact.artCells.map((cell) => api.model.thingFootprintAt(cell.x, cell.y)),
      reservationCellsReserved: artifact.reservedCells.map((cell) => api.model.thingFootprintAt(cell.x, cell.y)),
      artCellClues: artifact.artCells.map((cell) => api.model.clueAt(cell.x, cell.y)),
      artNeighborReservations: artifact.artCells.flatMap((cell) => {
        const reservations: boolean[] = [];
        api.model.topology.forEachNeighbor(cell.x, cell.y, (neighborX, neighborY) => {
          reservations.push(api.model.thingFootprintAt(neighborX, neighborY));
        });
        return reservations;
      }),
      nearbySprites,
      clue: api.model.clueAt(artifact.x, artifact.y),
      state: api.model.getState(artifact.x, artifact.y),
      colorfulPixels,
      colors: colors.size,
      atlas: {
        width: thingAtlas.width,
        height: thingAtlas.height,
        transparentPixels,
        partialAlphaPixels,
        opaquePixels,
        alphaLevels: alphaLevels.size,
        colors: atlasColors.size,
        minFilter: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER),
        magFilter: gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER),
      },
      blending: {
        enabled: gl.isEnabled(gl.BLEND),
        source: gl.getParameter(gl.BLEND_SRC_RGB),
        destination: gl.getParameter(gl.BLEND_DST_RGB),
      },
      framebufferAlpha: {
        unchangedPixels,
        changedPixels,
        totalPixels: width * height,
      },
      colorfulSpanCells: {
        x: (colorfulMaxX - colorfulMinX + 1) / dpr / cellSize,
        y: (colorfulMaxY - colorfulMinY + 1) / dpr / cellSize,
      },
      subjectSpanCells: {
        x: (subjectMaxX - subjectMinX + 1) / dpr / cellSize,
        y: (subjectMaxY - subjectMinY + 1) / dpr / cellSize,
      },
      diagnostics: api.diagnostics(),
    };
  });

  expect(result.artifact.side).toBe(4);
  expect(result.visualCellsReserved).toEqual(Array(16).fill(true));
  expect(result.artCellsReserved).toEqual(Array(result.artifact.artCells.length).fill(true));
  expect(result.reservationCellsReserved).toEqual(Array(36).fill(true));
  expect(result.artCellClues).toEqual(Array(result.artifact.artCells.length).fill(0));
  expect(result.artNeighborReservations).toEqual(Array(result.artNeighborReservations.length).fill(true));
  expect(result.nearbySprites).toHaveLength(9);
  expect(new Set(result.nearbySprites).size).toBe(9);
  expect(result.clue).toBe(0);
  expect(result.state).toBe(1);
  expect(result.colorfulPixels).toBeGreaterThan(500);
  expect(result.colors).toBeGreaterThan(100);
  expect(result.atlas).toMatchObject({
    width: 8 * 512,
    height: 8 * 512,
    minFilter: 9729,
    magFilter: 9729,
  });
  expect(result.atlas.transparentPixels).toBeGreaterThan(5_000);
  expect(result.atlas.partialAlphaPixels).toBeGreaterThan(100);
  expect(result.atlas.opaquePixels).toBeGreaterThan(1_000);
  expect(result.atlas.alphaLevels).toBeGreaterThan(20);
  expect(result.atlas.colors).toBeGreaterThan(500);
  expect(result.blending).toEqual({ enabled: true, source: 1, destination: 771 });
  expect(result.framebufferAlpha.unchangedPixels).toBeGreaterThan(result.framebufferAlpha.totalPixels * 0.2);
  expect(result.framebufferAlpha.changedPixels).toBeGreaterThan(result.framebufferAlpha.totalPixels * 0.1);
  expect(result.colorfulSpanCells.x).toBeGreaterThan(2);
  expect(result.colorfulSpanCells.y).toBeGreaterThan(2);
  expect(result.subjectSpanCells.x).toBeGreaterThan(3);
  expect(result.subjectSpanCells.y).toBeGreaterThan(3);
  expect(result.diagnostics).toMatchObject({
    backend: "webgl2",
    drawCalls: 1,
    thingSprites: 3213,
    thingSpritesLoaded: 12,
    thingTexturePixels: 512,
    thingSpritesReady: true,
    canvasCount: 3,
  });
});

test("R49 — every drawn Thing fragment and vector-alpha texel stays inside its reservation", async ({ page }) => {
  await openDeterministicGame(page, 0x5eed_1234);
  await page.evaluate(() => window.__infiniteMines.setThingsEnabled(true));
  const cases = [
    { topology: "square", variant: 0 },
    { topology: "hexagonal", variant: 0 },
    { topology: "triangular", variant: 3 },
    { topology: "rhombille", variant: 9 },
  ] as const;

  for (const testCase of cases) {
    const result = await page.evaluate(async ({ topology, variant }) => {
      const api = window.__infiniteMines;
      api.model.reset("beginner", 0x5eed_1234, false, topology, undefined, true);
      api.renderer.syncThings();
      await api.renderer.waitForThingSprites();
      const privateModel = api.model as unknown as {
        artifactForZone(zoneX: number, zoneY: number): { x: number; y: number };
      };
      let thing: ReturnType<typeof api.model.thingVisualAt> = null;
      search: for (let zoneY = -50; zoneY <= 50; zoneY += 1) {
        for (let zoneX = -50; zoneX <= 50; zoneX += 1) {
          const anchor = privateModel.artifactForZone(zoneX, zoneY);
          const candidate = api.model.thingVisualAt(anchor.x, anchor.y);
          if (candidate?.sprite !== variant) continue;
          thing = candidate;
          break search;
        }
      }
      if (!thing) throw new Error(`No ${topology} Thing for vector ${variant}`);
      const atlasSlot = await api.renderer.waitForThingSprite(thing.sprite);
      api.reveal(thing.x, thing.y);
      const vertices = thing.cells.flatMap((cell) => api.model.topology.geometry(cell.x, cell.y).vertices);
      const centerX = (Math.min(...vertices.map((point) => point.x)) + Math.max(...vertices.map((point) => point.x))) / 2;
      const centerY = (Math.min(...vertices.map((point) => point.y)) + Math.max(...vertices.map((point) => point.y))) / 2;
      const origin = api.model.topology.origin;
      const cellSize = 50;
      api.renderer.restoreView({
        version: 1,
        zoom: 2,
        panX: -(centerX - origin.x) * cellSize,
        panY: -(centerY - origin.y) * cellSize,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

      const renderer = api.renderer;
      const gl = renderer.gl;
      gl.finish();
      const privateRenderer = renderer as unknown as {
        thingEmojiAtlas: HTMLCanvasElement;
        instanceCount: number;
        range: { anchorX: number; anchorY: number };
        genericAnchorWorldX: number;
        genericAnchorWorldY: number;
        resources: { instanceBuffer: WebGLBuffer; genericInstanceBuffer: WebGLBuffer };
      };
      const generic = topology !== "square";
      const stride = generic ? 14 : 5;
      const reserved = new Set(thing.reservedCells.map((cell) => `${cell.x},${cell.y}`));
      const art = new Set(thing.artCells.map((cell) => `${cell.x},${cell.y}`));
      const instanceCellKey = (values: readonly number[]): string => {
        if (generic) {
          const worldX = values[0] + privateRenderer.genericAnchorWorldX;
          const worldY = values[1] + privateRenderer.genericAnchorWorldY;
          const cell = api.model.topology.hitTest(worldX, worldY);
          return `${cell.x},${cell.y}`;
        }
        return `${Math.round(values[0] + privateRenderer.range.anchorX * 8)},${Math.round(values[1] + privateRenderer.range.anchorY * 8)}`;
      };
      gl.bindBuffer(
        gl.ARRAY_BUFFER,
        generic ? privateRenderer.resources.genericInstanceBuffer : privateRenderer.resources.instanceBuffer,
      );
      const instances = new Float32Array(privateRenderer.instanceCount * stride);
      gl.getBufferSubData(gl.ARRAY_BUFFER, 0, instances);
      const thingInstances: number[][] = [];
      const underlayInstances: number[][] = [];
      const borderInstances: number[][] = [];
      const baseInstances: number[][] = [];
      let lastThingOrder = -1;
      let firstBorderOrder = Number.POSITIVE_INFINITY;
      for (let offset = 0; offset < instances.length; offset += stride) {
        const values = Array.from(instances.slice(offset, offset + stride));
        const kind = values[generic ? 7 : 3];
        const key = instanceCellKey(values);
        if (kind === 3 && art.has(key)) {
          thingInstances.push(values);
          lastThingOrder = offset / stride;
        }
        if (kind === -1 && art.has(key)) underlayInstances.push(values);
        if (kind < 1.5) baseInstances.push(values);
        if (kind === 4 && art.has(key)) {
          borderInstances.push(values);
          firstBorderOrder = Math.min(firstBorderOrder, offset / stride);
        }
      }
      if (thingInstances.length === 0) throw new Error(`No ${topology} Thing instances`);
      const first = thingInstances[0];
      const sprite = Math.round(first[generic ? 6 : 2]);
      const bounds = generic
        ? {
            minX: first[10] + privateRenderer.genericAnchorWorldX,
            minY: first[11] + privateRenderer.genericAnchorWorldY,
            width: first[12],
            height: first[13],
          }
        : {
            minX: Math.min(...thing.cells.map((cell) => cell.x)),
            minY: Math.min(...thing.cells.map((cell) => cell.y)),
            width: thing.side,
            height: thing.side,
          };
      const carrierKeys = new Set<string>();
      const underlayKeys = new Set<string>();
      const actualBorderMasks = new Map<string, number>();
      for (const instance of thingInstances) {
        if (generic) {
          const worldX = instance[0] + privateRenderer.genericAnchorWorldX;
          const worldY = instance[1] + privateRenderer.genericAnchorWorldY;
          const cell = api.model.topology.hitTest(worldX, worldY);
          carrierKeys.add(`${cell.x},${cell.y}`);
        } else {
          carrierKeys.add(
            `${Math.round(instance[0] + privateRenderer.range.anchorX * 8)},${Math.round(instance[1] + privateRenderer.range.anchorY * 8)}`,
          );
        }
      }
      for (const instance of underlayInstances) {
        if (generic) {
          const worldX = instance[0] + privateRenderer.genericAnchorWorldX;
          const worldY = instance[1] + privateRenderer.genericAnchorWorldY;
          const cell = api.model.topology.hitTest(worldX, worldY);
          underlayKeys.add(`${cell.x},${cell.y}`);
        } else {
          underlayKeys.add(
            `${Math.round(instance[0] + privateRenderer.range.anchorX * 8)},${Math.round(instance[1] + privateRenderer.range.anchorY * 8)}`,
          );
        }
      }
      for (const instance of borderInstances) {
        if (generic) {
          const worldX = instance[0] + privateRenderer.genericAnchorWorldX;
          const worldY = instance[1] + privateRenderer.genericAnchorWorldY;
          const cell = api.model.topology.hitTest(worldX, worldY);
          actualBorderMasks.set(`${cell.x},${cell.y}`, Math.round(instance[9]));
        } else {
          actualBorderMasks.set(
            `${Math.round(instance[0] + privateRenderer.range.anchorX * 8)},${Math.round(instance[1] + privateRenderer.range.anchorY * 8)}`,
            Math.round(instance[4]),
          );
        }
      }
      const expectedBorderMasks = new Map<string, number>();
      let expectedBorderEdges = 0;
      for (const cell of thing.artCells) {
        let mask = 0;
        if (generic) {
          const neighbors = api.model.topology.edgeNeighbors(cell.x, cell.y);
          for (let edge = 0; edge < neighbors.length; edge += 1) {
            if (!art.has(`${neighbors[edge].x},${neighbors[edge].y}`)) mask |= 1 << edge;
          }
        } else {
          if (!art.has(`${cell.x},${cell.y - 1}`)) mask |= 1;
          if (!art.has(`${cell.x - 1},${cell.y}`)) mask |= 2;
          if (!art.has(`${cell.x + 1},${cell.y}`)) mask |= 4;
          if (!art.has(`${cell.x},${cell.y + 1}`)) mask |= 8;
        }
        if (mask === 0) continue;
        expectedBorderMasks.set(`${cell.x},${cell.y}`, mask);
        for (let bits = mask; bits > 0; bits &= bits - 1) expectedBorderEdges += 1;
      }
      let actualBorderEdges = 0;
      for (const mask of actualBorderMasks.values()) {
        for (let bits = mask; bits > 0; bits &= bits - 1) actualBorderEdges += 1;
      }
      let basePerimeterEdges = 0;
      for (const instance of baseInstances) {
        const edges = Math.round(instance[generic ? 9 : 4]);
        if (generic) {
          const worldX = instance[0] + privateRenderer.genericAnchorWorldX;
          const worldY = instance[1] + privateRenderer.genericAnchorWorldY;
          const cell = api.model.topology.hitTest(worldX, worldY);
          const cellIsArt = art.has(`${cell.x},${cell.y}`);
          const neighbors = api.model.topology.edgeNeighbors(cell.x, cell.y);
          for (let edge = 0; edge < neighbors.length; edge += 1) {
            if (cellIsArt !== art.has(`${neighbors[edge].x},${neighbors[edge].y}`) && (edges & (1 << edge)) !== 0) {
              basePerimeterEdges += 1;
            }
          }
        } else {
          const x = Math.round(instance[0] + privateRenderer.range.anchorX * 8);
          const y = Math.round(instance[1] + privateRenderer.range.anchorY * 8);
          const cellIsArt = art.has(`${x},${y}`);
          const neighbors = [
            { x, y: y - 1, bit: 1 },
            { x: x - 1, y, bit: 2 },
            { x: x + 1, y, bit: 4 },
            { x, y: y + 1, bit: 8 },
          ];
          for (const neighbor of neighbors) {
            if (cellIsArt !== art.has(`${neighbor.x},${neighbor.y}`) && (edges & neighbor.bit) !== 0) {
              basePerimeterEdges += 1;
            }
          }
        }
      }

      const atlas = privateRenderer.thingEmojiAtlas;
      const atlasContext = atlas.getContext("2d");
      if (!atlasContext) throw new Error("Missing Thing atlas context");
      const atlasPixels = atlasContext.getImageData(
        (atlasSlot % 8) * 512,
        Math.floor(atlasSlot / 8) * 512,
        512,
        512,
      ).data;
      let opaqueSamples = 0;
      let outsideReservation = 0;
      let outsideArt = 0;
      const sampledArt = new Set<string>();
      for (let pixelY = 0; pixelY < 512; pixelY += 2) {
        for (let pixelX = 0; pixelX < 512; pixelX += 2) {
          if (atlasPixels[(pixelY * 512 + pixelX) * 4 + 3] === 0) continue;
          opaqueSamples += 1;
          const mappedX = bounds.minX + ((pixelX + 0.5) / 512) * bounds.width;
          const mappedY = bounds.minY + ((pixelY + 0.5) / 512) * bounds.height;
          const cell = generic
            ? api.model.topology.hitTest(mappedX, mappedY)
            : api.model.topology.hitTest(mappedX - 0.5, mappedY - 0.5);
          const key = `${cell.x},${cell.y}`;
          sampledArt.add(key);
          if (!reserved.has(key)) outsideReservation += 1;
          if (!art.has(key)) outsideArt += 1;
        }
      }

      let internalEdges = 0;
      let emittedInternalEdges = 0;
      if (generic) {
        const underlayByCenter = new Map<string, number>();
        for (const instance of underlayInstances) {
          const center = `${(instance[0] + privateRenderer.genericAnchorWorldX).toFixed(7)},${(instance[1] + privateRenderer.genericAnchorWorldY).toFixed(7)}`;
          underlayByCenter.set(center, Math.round(instance[9]));
        }
        for (const cell of thing.artCells) {
          const geometry = api.model.topology.geometry(cell.x, cell.y);
          const cellMinX = Math.min(...geometry.vertices.map((point) => point.x));
          const cellMaxX = Math.max(...geometry.vertices.map((point) => point.x));
          const cellMinY = Math.min(...geometry.vertices.map((point) => point.y));
          const cellMaxY = Math.max(...geometry.vertices.map((point) => point.y));
          if (
            cellMaxX <= bounds.minX + 1e-8 ||
            cellMinX >= bounds.minX + bounds.width - 1e-8 ||
            cellMaxY <= bounds.minY + 1e-8 ||
            cellMinY >= bounds.minY + bounds.height - 1e-8
          ) {
            continue;
          }
          let drawCenterX = geometry.center.x;
          let drawCenterY = geometry.center.y;
          if (geometry.shape === "triangle-up" || geometry.shape === "triangle-down") {
            drawCenterX = (cellMinX + cellMaxX) / 2;
            drawCenterY = (cellMinY + cellMaxY) / 2;
          }
          const edges = underlayByCenter.get(`${drawCenterX.toFixed(7)},${drawCenterY.toFixed(7)}`);
          const neighbors = api.model.topology.edgeNeighbors(cell.x, cell.y);
          for (let edge = 0; edge < neighbors.length; edge += 1) {
            const neighborInside = art.has(`${neighbors[edge].x},${neighbors[edge].y}`);
            if (!neighborInside) continue;
            internalEdges += 1;
            if (edges !== undefined && (edges & (1 << edge)) !== 0) emittedInternalEdges += 1;
          }
        }
      } else {
        const baseByCell = new Map<string, number>();
        for (let offset = 0; offset < instances.length; offset += stride) {
          if (instances[offset + 3] === 3) continue;
          const x = Math.round(instances[offset] + privateRenderer.range.anchorX * 8);
          const y = Math.round(instances[offset + 1] + privateRenderer.range.anchorY * 8);
          baseByCell.set(`${x},${y}`, Math.round(instances[offset + 4]));
        }
        for (const cell of thing.artCells) {
          const edges = baseByCell.get(`${cell.x},${cell.y}`);
          if (edges === undefined) continue;
          if (art.has(`${cell.x},${cell.y - 1}`)) {
            internalEdges += 1;
            if ((edges & 1) !== 0) emittedInternalEdges += 1;
          }
          if (art.has(`${cell.x - 1},${cell.y}`)) {
            internalEdges += 1;
            if ((edges & 2) !== 0) emittedInternalEdges += 1;
          }
        }
      }

      return {
        topology,
        sprite,
        catalogSprite: thing.sprite,
        carrierCells: carrierKeys.size,
        expectedCarrierCells: art.size,
        carriersOutsideReservation: [...carrierKeys].filter((key) => !reserved.has(key)),
        carriersOutsideArt: [...carrierKeys].filter((key) => !art.has(key)),
        missingArtCarriers: [...art].filter((key) => !carrierKeys.has(key)),
        underlaysOutsideArt: [...underlayKeys].filter((key) => !art.has(key)),
        missingArtUnderlays: [...art].filter((key) => !underlayKeys.has(key)),
        borderMasks: [...actualBorderMasks].sort(([left], [right]) => left.localeCompare(right)),
        expectedBorderMasks: [...expectedBorderMasks].sort(([left], [right]) => left.localeCompare(right)),
        actualBorderEdges,
        expectedBorderEdges,
        borderAfterArtwork: firstBorderOrder > lastThingOrder,
        basePerimeterEdges,
        sampledArtOutsideFootprint: [...sampledArt].filter((key) => !art.has(key)),
        transparentReservationCells: [...reserved].filter((key) => !art.has(key)).length,
        opaqueSamples,
        outsideReservation,
        outsideArt,
        internalEdges,
        emittedInternalEdges,
        underlayInstances: underlayInstances.length,
        diagnostics: api.diagnostics(),
      };
    }, testCase);

    expect(result.catalogSprite, `${testCase.topology} selected vector`).toBe(testCase.variant);
    expect(result.carrierCells, `${testCase.topology} carrier count`).toBe(result.expectedCarrierCells);
    expect(result.carriersOutsideReservation, `${testCase.topology} carriers outside reservation`).toEqual([]);
    expect(result.carriersOutsideArt, `${testCase.topology} carriers outside alpha footprint`).toEqual([]);
    expect(result.missingArtCarriers, `${testCase.topology} missing alpha carriers`).toEqual([]);
    expect(result.underlaysOutsideArt, `${testCase.topology} underlays outside alpha footprint`).toEqual([]);
    expect(result.missingArtUnderlays, `${testCase.topology} missing glyph-suppressing underlays`).toEqual([]);
    expect(result.borderMasks, `${testCase.topology} exact outer border masks`).toEqual(result.expectedBorderMasks);
    expect(result.actualBorderEdges, `${testCase.topology} complete outer border`).toBe(result.expectedBorderEdges);
    expect(result.borderAfterArtwork, `${testCase.topology} border draw order`).toBe(true);
    expect(result.basePerimeterEdges, `${testCase.topology} single border owner`).toBe(0);
    expect(result.sampledArtOutsideFootprint, `${testCase.topology} sampled alpha outside footprint`).toEqual([]);
    expect(result.transparentReservationCells, `${testCase.topology} transparent-only reservation cells`).toBeGreaterThan(0);
    expect(result.opaqueSamples, `${testCase.topology} vector samples`).toBeGreaterThan(20_000);
    expect(result.outsideReservation, `${testCase.topology} vector alpha outside reservation`).toBe(0);
    expect(result.outsideArt, `${testCase.topology} vector alpha outside art cells`).toBe(0);
    expect(result.internalEdges, `${testCase.topology} audited internal edges`).toBeGreaterThan(0);
    expect(result.emittedInternalEdges, `${testCase.topology} emitted internal edges`).toBe(0);
    if (testCase.topology !== "square") expect(result.underlayInstances).toBeGreaterThan(4);
    expect(result.diagnostics).toMatchObject({
      backend: "webgl2",
      topology: testCase.topology,
      drawCalls: 1,
      thingSprites: 3213,
      thingSpritesLoaded: 12,
      thingTexturePixels: 512,
      thingSpritesReady: true,
      canvasCount: 3,
    });
  }
});

test("R49 — alpha reservations match every curated SVG, size, topology, and orientation", async ({ page }) => {
  test.setTimeout(45_000);
  await openDeterministicGame(page, 0x5eed_1234);
  await page.evaluate(() => window.__infiniteMines.setThingsEnabled(true));
  const result = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    await api.renderer.waitForThingSprites();
    const privateRenderer = api.renderer as unknown as { thingEmojiAtlas: HTMLCanvasElement };
    const privateModel = api.model as unknown as {
      artifactForZone(zoneX: number, zoneY: number): { x: number; y: number };
    };
    const atlasContext = privateRenderer.thingEmojiAtlas.getContext("2d", { willReadFrequently: true });
    if (!atlasContext) throw new Error("Missing Thing atlas context");
    const texturePixels = 512;
    const alphaMasks: Uint8Array[] = [];
    for (let sprite = 0; sprite < 12; sprite += 1) {
      const slot = api.renderer.thingAtlasSlotForSprite(sprite);
      if (slot === null) throw new Error(`Curated Thing ${sprite} is not loaded`);
      const source = atlasContext.getImageData(
        (slot % 8) * texturePixels,
        Math.floor(slot / 8) * texturePixels,
        texturePixels,
        texturePixels,
      ).data;
      const alpha = new Uint8Array(texturePixels * texturePixels);
      for (let y = 0; y < texturePixels; y += 1) {
        for (let x = 0; x < texturePixels; x += 1) {
          if (source[(y * texturePixels + x) * 4 + 3] === 0) continue;
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            const targetY = y + offsetY;
            if (targetY < 0 || targetY >= texturePixels) continue;
            for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
              const targetX = x + offsetX;
              if (targetX < 0 || targetX >= texturePixels) continue;
              alpha[targetY * texturePixels + targetX] = 1;
            }
          }
        }
      }
      alphaMasks.push(alpha);
    }

    const positiveModulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
    const pointInside = (x: number, y: number, vertices: readonly { x: number; y: number }[]): boolean => {
      let sign = 0;
      for (let index = 0; index < vertices.length; index += 1) {
        const start = vertices[index];
        const end = vertices[(index + 1) % vertices.length];
        const cross = (end.x - start.x) * (y - start.y) - (end.y - start.y) * (x - start.x);
        if (Math.abs(cross) <= 1e-9) continue;
        const nextSign = cross < 0 ? -1 : 1;
        if (sign !== 0 && nextSign !== sign) return false;
        sign = nextSign;
      }
      return true;
    };
    const failures: string[] = [];
    const exemplars = new Map<
      string,
      NonNullable<ReturnType<typeof api.model.thingVisualAt>> & {
        topology: "square" | "hexagonal" | "triangular" | "rhombille";
        sprite: number;
      }
    >();
    const topologies = new Map<string, typeof api.model.topology>();
    const targets = { square: 24, hexagonal: 24, triangular: 48, rhombille: 72 } as const;
    const curatedZones = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: -1, y: 1 },
      { x: -1, y: 0 },
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: 2, y: -1 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
    ];
    for (const topology of ["square", "hexagonal", "triangular", "rhombille"] as const) {
      const topologyStart = exemplars.size;
      for (let seedOffset = 0; seedOffset < 256 && exemplars.size - topologyStart < targets[topology]; seedOffset += 1) {
        const seed = (0x5eed_1234 + seedOffset * 0x1020_3041) >>> 0;
        api.model.reset("beginner", seed, false, topology, undefined, true);
        topologies.set(topology, api.model.topology);
        for (const zone of curatedZones) {
          if (exemplars.size - topologyStart >= targets[topology]) break;
          const layout = privateModel.artifactForZone(zone.x, zone.y);
          const thing = api.model.thingVisualAt(layout.x, layout.y);
          if (!thing) throw new Error("Missing generated Thing visual");
          const sprite = thing.sprite;
          if (sprite >= 12) continue;
          const orientation =
            topology === "triangular"
              ? positiveModulo(thing.x + thing.y, 2)
              : topology === "rhombille"
                ? positiveModulo(thing.x, 3)
                : 0;
          const key = `${topology}:${orientation}:${thing.side}:${sprite}`;
          if (!exemplars.has(key)) {
            exemplars.set(key, { ...thing, topology, sprite });
            const reserved = new Set(thing.reservedCells.map((cell) => `${cell.x},${cell.y}`));
            for (const cell of thing.artCells) {
              const clue = api.model.clueAt(cell.x, cell.y);
              if (clue !== 0) failures.push(`${key}: art cell ${cell.x},${cell.y} has clue ${clue}`);
              api.model.topology.forEachNeighbor(cell.x, cell.y, (neighborX, neighborY) => {
                if (!reserved.has(`${neighborX},${neighborY}`)) {
                  failures.push(`${key}: art neighbor ${neighborX},${neighborY} is not reserved`);
                }
              });
            }
          }
        }
      }
      if (exemplars.size - topologyStart !== targets[topology]) {
        throw new Error(`Missing ${topology} alpha configurations: ${exemplars.size - topologyStart}/${targets[topology]}`);
      }
    }

    let minArtCells = Number.POSITIVE_INFINITY;
    let maxArtCells = 0;
    for (const [configuration, thing] of exemplars) {
      const topology = topologies.get(thing.topology);
      if (!topology) throw new Error(`Missing ${thing.topology} topology`);
      const vertices = thing.cells.flatMap((cell) => topology.geometry(cell.x, cell.y).vertices);
      let minX = Math.min(...vertices.map((point) => point.x));
      let minY = Math.min(...vertices.map((point) => point.y));
      let maxX = Math.max(...vertices.map((point) => point.x));
      let maxY = Math.max(...vertices.map((point) => point.y));
      if (thing.topology !== "square") {
        const fit = thing.topology === "triangular" || thing.topology === "hexagonal" ? 0.9 : 0.8;
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const halfWidth = ((maxX - minX) * fit) / 2;
        const halfHeight = ((maxY - minY) * fit) / 2;
        minX = centerX - halfWidth;
        maxX = centerX + halfWidth;
        minY = centerY - halfHeight;
        maxY = centerY + halfHeight;
      }
      const width = maxX - minX;
      const height = maxY - minY;
      const art = new Set(thing.artCells.map((cell) => `${cell.x},${cell.y}`));
      const reserved = new Set(thing.reservedCells.map((cell) => `${cell.x},${cell.y}`));
      minArtCells = Math.min(minArtCells, art.size);
      maxArtCells = Math.max(maxArtCells, art.size);
      for (const key of art) {
        if (!reserved.has(key)) failures.push(`${configuration}: alpha cell ${key} is not mine-free`);
      }
      for (const cell of thing.reservedCells) {
        const geometry = topology.geometry(cell.x, cell.y);
        const cellMinX = Math.min(...geometry.vertices.map((point) => point.x));
        const cellMinY = Math.min(...geometry.vertices.map((point) => point.y));
        const cellMaxX = Math.max(...geometry.vertices.map((point) => point.x));
        const cellMaxY = Math.max(...geometry.vertices.map((point) => point.y));
        const minPixelX = Math.max(0, Math.floor(((cellMinX - minX) / width) * texturePixels) - 1);
        const minPixelY = Math.max(0, Math.floor(((cellMinY - minY) / height) * texturePixels) - 1);
        const maxPixelX = Math.min(texturePixels - 1, Math.ceil(((cellMaxX - minX) / width) * texturePixels) + 1);
        const maxPixelY = Math.min(texturePixels - 1, Math.ceil(((cellMaxY - minY) / height) * texturePixels) + 1);
        let touches = false;
        for (let pixelY = minPixelY; pixelY <= maxPixelY && !touches; pixelY += 1) {
          for (let pixelX = minPixelX; pixelX <= maxPixelX; pixelX += 1) {
            if (alphaMasks[thing.sprite][pixelY * texturePixels + pixelX] === 0) continue;
            const worldX = minX + ((pixelX + 0.5) / texturePixels) * width;
            const worldY = minY + ((pixelY + 0.5) / texturePixels) * height;
            if (pointInside(worldX, worldY, geometry.vertices)) {
              touches = true;
              break;
            }
          }
        }
        const key = `${cell.x},${cell.y}`;
        if (touches !== art.has(key)) failures.push(`${configuration}: ${key} expected ${touches} got ${art.has(key)}`);
      }
    }
    return { patterns: exemplars.size, failures, minArtCells, maxArtCells };
  });

  expect(result.patterns).toBe(168);
  expect(result.failures).toEqual([]);
  expect(result.minArtCells).toBeGreaterThan(0);
  expect(result.maxArtCells).toBeLessThanOrEqual(36);
});

test("R49 — emoji Things fade continuously through the board detail transition", async ({ page }) => {
  await openDeterministicGame(page, 0x5eed_1234);
  await page.evaluate(() => window.__infiniteMines.setThingsEnabled(true));
  const results = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    await renderer.waitForThingSprites();
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const privateRenderer = renderer as unknown as {
      thingEmojiAtlas: HTMLCanvasElement;
      resources: { thingAtlasTexture: WebGLTexture };
    };
    const privateModel = api.model as unknown as {
      artifactForZone(zoneX: number, zoneY: number): { x: number; y: number };
    };
    const gl = renderer.gl;
    const uploadSlot = (slot: number, source: HTMLCanvasElement) => {
      gl.bindTexture(gl.TEXTURE_2D, privateRenderer.resources.thingAtlasTexture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        (slot % 8) * 512,
        Math.floor(slot / 8) * 512,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source,
      );
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    };
    const blank = document.createElement("canvas");
    blank.width = 512;
    blank.height = 512;
    const samples: Array<{ topology: string; values: Array<{ cellSize: number; detailMix: number; difference: number }> }> = [];

    for (const topology of ["square", "hexagonal", "triangular", "rhombille"] as const) {
      api.model.reset("beginner", 0x5eed_1234, false, topology, undefined, true);
      renderer.syncThings();
      let thing: ReturnType<typeof api.model.thingVisualAt> = null;
      search: for (let zoneY = -24; zoneY <= 24; zoneY += 1) {
        for (let zoneX = -24; zoneX <= 24; zoneX += 1) {
          const anchor = privateModel.artifactForZone(zoneX, zoneY);
          const candidate = api.model.thingVisualAt(anchor.x, anchor.y);
          if (candidate?.sprite !== 0) continue;
          thing = candidate;
          break search;
        }
      }
      if (!thing) throw new Error(`No ${topology} fade-test Thing`);
      const slot = await renderer.waitForThingSprite(thing.sprite);
      const original = document.createElement("canvas");
      original.width = 512;
      original.height = 512;
      const originalContext = original.getContext("2d");
      if (!originalContext) throw new Error("Missing Thing slot context");
      originalContext.drawImage(
        privateRenderer.thingEmojiAtlas,
        (slot % 8) * 512,
        Math.floor(slot / 8) * 512,
        512,
        512,
        0,
        0,
        512,
        512,
      );
      api.reveal(thing.x, thing.y);
      const vertices = thing.cells.flatMap((cell) => api.model.topology.geometry(cell.x, cell.y).vertices);
      const centerX = (Math.min(...vertices.map((point) => point.x)) + Math.max(...vertices.map((point) => point.x))) / 2;
      const centerY = (Math.min(...vertices.map((point) => point.y)) + Math.max(...vertices.map((point) => point.y))) / 2;
      const origin = api.model.topology.origin;
      const values: Array<{ cellSize: number; detailMix: number; difference: number }> = [];
      for (const cellSize of [4, 5, 6, 7, 8]) {
        renderer.restoreView({
          version: 1,
          zoom: cellSize / 25,
          panX: -(centerX - origin.x) * cellSize,
          panY: -(centerY - origin.y) * cellSize,
        });
        await settle();
        gl.finish();
        const polygon = thing.cells.flatMap((cell) => renderer.cellScreenPolygon(cell.x, cell.y));
        const dpr = api.diagnostics().pixelRatio;
        const left = Math.max(0, Math.floor(Math.min(...polygon.map((point) => point.x)) * dpr) - 2);
        const right = Math.min(renderer.canvas.width, Math.ceil(Math.max(...polygon.map((point) => point.x)) * dpr) + 2);
        const top = Math.max(0, Math.floor(Math.min(...polygon.map((point) => point.y)) * dpr) - 2);
        const bottom = Math.min(renderer.canvas.height, Math.ceil(Math.max(...polygon.map((point) => point.y)) * dpr) + 2);
        const width = right - left;
        const height = bottom - top;
        const rendered = new Uint8Array(width * height * 4);
        gl.readPixels(left, renderer.canvas.height - bottom, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rendered);
        uploadSlot(slot, blank);
        renderer.requestRender();
        await settle();
        gl.finish();
        const withoutThing = new Uint8Array(rendered.length);
        gl.readPixels(left, renderer.canvas.height - bottom, width, height, gl.RGBA, gl.UNSIGNED_BYTE, withoutThing);
        uploadSlot(slot, original);
        renderer.requestRender();
        await settle();
        let difference = 0;
        for (let offset = 0; offset < rendered.length; offset += 4) {
          difference += Math.abs(rendered[offset] - withoutThing[offset]);
          difference += Math.abs(rendered[offset + 1] - withoutThing[offset + 1]);
          difference += Math.abs(rendered[offset + 2] - withoutThing[offset + 2]);
        }
        values.push({ cellSize, detailMix: api.diagnostics().detailMix, difference: difference / (width * height * 3) });
      }
      samples.push({ topology, values });
    }
    return samples;
  });

  for (const result of results) {
    [0, 0.15625, 0.5, 0.84375, 1].forEach((expected, index) => {
      expect(result.values[index].detailMix, `${result.topology} detail curve at ${index}`).toBeCloseTo(expected, 8);
    });
    expect(result.values[0].difference, `${result.topology} fully faded`).toBe(0);
    for (let index = 1; index < result.values.length; index += 1) {
      expect(result.values[index].difference, `${result.topology} visible at ${result.values[index].cellSize}px`).toBeGreaterThan(0);
      expect(
        result.values[index].difference,
        `${result.topology} monotonic at ${result.values[index].cellSize}px`,
      ).toBeGreaterThan(result.values[index - 1].difference);
    }
  }
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
        deltaY: -Math.log(0.04) / 0.0012,
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
