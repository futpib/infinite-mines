import { expect, test } from "@playwright/test";
import { CellState } from "../../src/model";
import { findCell, openDeterministicGame, worldPoint } from "./helpers";

test("R16 — cell coordinates produce a safe, reproducible clipboard reference", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openDeterministicGame(page);

  const target = await findCell(page, "covered");
  const point = await worldPoint(page, target);
  await page.mouse.move(point.x, point.y);

  const locator = page.locator("#cell-locator");
  await expect(locator).toHaveAttribute("data-x", String(target.x));
  await expect(locator).toHaveAttribute("data-y", String(target.y));
  await expect(locator).toHaveAttribute("data-state", "covered");
  await expect(page.locator("#cell-coordinate")).toHaveText(`${target.x}, ${target.y}`);
  await expect(page.locator("#cell-state")).toHaveText("COVERED · COPY");

  const beforeDrag = await page.locator("#cell-coordinate").textContent();
  await page.mouse.down();
  await page.mouse.move(point.x + 80, point.y);
  expect(await page.locator("#cell-coordinate").textContent()).toBe(beforeDrag);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().hoveredCells)).toBe(0);
  await page.mouse.up();

  await locator.click();
  await expect(page.locator("#toast")).toContainText("reference copied");
  const reference = await page.evaluate(() => navigator.clipboard.readText());
  const expected = await page.evaluate(() => {
    const model = window.__infiniteMines.model;
    const origin = model.safeOrigin;
    return {
      mode: model.mode,
      density: `${(model.density * 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`,
      things: model.thingsEnabled ? "on" : "off",
      seed: model.seed,
      safe: origin ? `(${origin.x}, ${origin.y})` : "unset",
      scale: window.__infiniteMines.renderer.cellSize.toFixed(2),
    };
  });
  const current = await locator.evaluate((element) => ({
    x: (element as HTMLElement).dataset.x,
    y: (element as HTMLElement).dataset.y,
    state: (element as HTMLElement).dataset.state,
  }));
  expect(reference).toBe(
    `Infinite Mines cell (${current.x}, ${current.y}) | mode=${expected.mode} | density=${expected.density} | things=${expected.things} | topology=square | seed=${expected.seed} | safe=${expected.safe} | state=${current.state} | scale=${expected.scale}px/tile | rotation=0deg | theme=light`,
  );
  expect(reference).not.toMatch(/mine=(?:true|false)/);
  expect(reference).not.toContain("concealed mine");
});

test("R18 — subtle compositor markers preview covered, chord, and auto-flag click footprints", async ({ page }) => {
  await openDeterministicGame(page);
  const covered = await findCell(page, "covered");
  const coveredPoint = await worldPoint(page, covered);
  await page.mouse.move(coveredPoint.x, coveredPoint.y);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.renderer.hoverPreview)).toEqual([covered]);

  await page.evaluate(() => {
    const model = window.__infiniteMines.model;
    model.reset("beginner", 1, false);
    model.mineAt = (x: number, y: number) => Math.abs(x % 2) === 1 && Math.abs(y % 2) === 1;
    model.reveal(0, 0);
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) model.cycleMark(x, y);
    window.__infiniteMines.renderer.home();
  });
  const center = await worldPoint(page, { x: 0, y: 0 });
  await page.mouse.move(center.x + 30, center.y);
  await page.mouse.move(center.x, center.y);
  const chordPreview = [
    { x: 0, y: 0 },
    { x: 0, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.renderer.hoverPreview)).toEqual(chordPreview);
  const markers = page.locator("#hover-overlay .hover-cell");
  await expect(markers).toHaveCount(19);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible")).toHaveCount(5);
  const outline = await markers.first().evaluate((marker) => {
    const styles = getComputedStyle(marker);
    return {
      borderWidth: styles.borderWidth,
      borderColor: styles.borderColor,
      opacity: styles.opacity,
      transform: styles.transform,
    };
  });
  expect(outline.borderWidth).toBe("1px");
  expect(outline.borderColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(Number(outline.opacity)).toBeLessThan(0.5);
  expect(outline.transform).not.toBe("none");
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().hoveredCells)).toBe(5);

  await page.evaluate(() => {
    const model = window.__infiniteMines.model;
    model.reset("beginner", 1, false);
    model.mineAt = (x: number, y: number) => Math.abs(x % 2) === 1 && Math.abs(y % 2) === 1;
    model.reveal(0, 0);
    model.reveal(0, -1);
    model.reveal(1, 0);
    model.reveal(0, 1);
    model.reveal(-1, 0);
  });
  await page.mouse.move(center.x + 30, center.y);
  await page.mouse.move(center.x, center.y);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.renderer.hoverPreview)).toEqual([
    { x: 0, y: 0 },
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: 1 },
    { x: 1, y: 1 },
  ]);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible")).toHaveCount(5);
});

test("R18 — hover paint follows WebGL edges across topology, zoom, camera phase, and device scale", async ({ browser }) => {
  const matrix: Array<{
    topology: string;
    deviceScaleFactor: number;
    cellSize: number;
    x: number;
    y: number;
    alignmentError: number;
    deviceAlignmentError: number;
  }> = [];
  let configurationCount = 0;
  for (const deviceScaleFactor of [1, 1.25, 1.5, 2, 3]) {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor });
    const page = await context.newPage();
    try {
      await openDeterministicGame(page);
      for (const topology of ["square", "hexagonal", "triangular", "rhombille"] as const) {
        for (const cellSize of [4, 8, 25, 34.25]) {
          const center = await page.evaluate(
            async ({ topologyId, requestedCellSize, phase, opened1, opened4, flagged }) => {
              const api = window.__infiniteMines;
              api.model.reset("beginner", 0x18ed_9e00, false, topologyId);
              api.model.store.clear();
              api.model.store.set(0, 0, topologyId === "square" ? opened4 : opened1);
              if (topologyId === "square") {
                for (const [x, y] of [
                  [-1, -1],
                  [1, -1],
                  [-1, 1],
                  [1, 1],
                ]) api.model.store.set(x, y, flagged);
              }
              api.renderer.restoreView({
                version: 1,
                zoom: requestedCellSize / 25,
                panX: 0.27 + phase * 0.13,
                panY: 0.61 - phase * 0.17,
              });
              await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
              const polygon = api.renderer.cellScreenPolygon(0, 0);
              return {
                x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
                y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
              };
            },
            {
              topologyId: topology,
              requestedCellSize: cellSize,
              phase: configurationCount,
              opened1: CellState.Opened1,
              opened4: CellState.Opened4,
              flagged: CellState.Flagged,
            },
          );
          await page.mouse.move(center.x + 70, center.y + 45);
          await page.mouse.move(center.x, center.y);
          const markers = page.locator("#hover-overlay .hover-cell.is-visible");
          await expect(markers).toHaveCount(
            topology === "square" ? 5 : topology === "hexagonal" ? 7 : topology === "triangular" ? 13 : 11,
          );
          // Preserve the real chord/hint marker set, then make those same cells
          // explored so every complete WebGL outline is present for pixel sampling.
          const frameBeforeNeighborhoodRender = await page.evaluate((opened1) => {
            const api = window.__infiniteMines;
            const frameCount = api.diagnostics().frameCount;
            for (const marker of document.querySelectorAll<HTMLElement>("#hover-overlay .hover-cell.is-visible")) {
              api.model.store.set(Number(marker.dataset.x), Number(marker.dataset.y), opened1);
            }
            api.renderer.requestRender();
            return frameCount;
          }, CellState.Opened1);
          await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBeGreaterThan(
            frameBeforeNeighborhoodRender,
          );
          const measurements = await markers.evaluateAll((nodes) => nodes.map((node) => {
            const api = window.__infiniteMines;
            const element = node as HTMLElement;
            const x = Number(element.dataset.x);
            const y = Number(element.dataset.y);
            const rawPolygon = api.renderer.cellScreenPolygon(x, y);
            const rect = element.getBoundingClientRect();
            const dpr = api.diagnostics().pixelRatio;
            const snap = (value: number) => Math.floor(value * dpr + 0.5) / dpr;
            const framebufferPolygon = api.model.topologyId === "square"
              ? rawPolygon.map((point) => ({ x: snap(point.x), y: snap(point.y) }))
              : rawPolygon;
            const borderColor = getComputedStyle(document.documentElement).getPropertyValue("--board-cell-border").trim();
            const borderRgb = [
              Number.parseInt(borderColor.slice(1, 3), 16),
              Number.parseInt(borderColor.slice(3, 5), 16),
              Number.parseInt(borderColor.slice(5, 7), 16),
            ];
            const gl = api.renderer.gl;
            const edgeColorErrors = framebufferPolygon.map((start, index) => {
              const end = framebufferPolygon[(index + 1) % framebufferPolygon.length];
              const centerX = Math.floor(((start.x + end.x) / 2) * dpr);
              const centerY = api.renderer.canvas.height - 1 - Math.floor(((start.y + end.y) / 2) * dpr);
              const radius = Math.ceil(dpr) + 1;
              const left = Math.max(0, centerX - radius);
              const bottom = Math.max(0, centerY - radius);
              const width = Math.min(api.renderer.canvas.width - left, radius * 2 + 1);
              const height = Math.min(api.renderer.canvas.height - bottom, radius * 2 + 1);
              const pixels = new Uint8Array(width * height * 4);
              gl.readPixels(left, bottom, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              let best = Number.POSITIVE_INFINITY;
              for (let pixel = 0; pixel < pixels.length; pixel += 4) {
                best = Math.min(
                  best,
                  Math.max(
                    Math.abs(pixels[pixel] - borderRgb[0]),
                    Math.abs(pixels[pixel + 1] - borderRgb[1]),
                    Math.abs(pixels[pixel + 2] - borderRgb[2]),
                  ),
                );
              }
              return best;
            });
            const framebufferEdgeColorError = Math.max(...edgeColorErrors);
            if (api.model.topologyId === "square") {
              const left = snap(Math.min(...rawPolygon.map((point) => point.x)));
              const top = snap(Math.min(...rawPolygon.map((point) => point.y)));
              const ownedEdgeExtension = api.diagnostics().lod === "detail" ? api.diagnostics().borderCssPixels : 0;
              const right = snap(Math.max(...rawPolygon.map((point) => point.x))) + ownedEdgeExtension;
              const bottom = snap(Math.max(...rawPolygon.map((point) => point.y))) + ownedEdgeExtension;
              return {
                x,
                y,
                alignmentError: Math.max(
                  Math.abs(rect.left - left),
                  Math.abs(rect.top - top),
                  Math.abs(rect.right - right),
                  Math.abs(rect.bottom - bottom),
                ),
                deviceAlignmentError: Math.max(
                  Math.abs(rect.left - left),
                  Math.abs(rect.top - top),
                  Math.abs(rect.right - right),
                  Math.abs(rect.bottom - bottom),
                ) * dpr,
                framebufferEdgeColorError,
                clipUsesPixels: element.style.clipPath === "",
                lod: api.diagnostics().lod,
                rendererPixelRatio: dpr,
              };
            }
            const coordinates = [...element.style.clipPath.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
            const paintedPolygon: Array<{ x: number; y: number }> = [];
            for (let index = 0; index < coordinates.length; index += 2) {
              paintedPolygon.push({ x: rect.left + coordinates[index], y: rect.top + coordinates[index + 1] });
            }
            return {
              x,
              y,
              alignmentError: Math.max(
                ...rawPolygon.flatMap((point, index) => [
                  Math.abs(point.x - paintedPolygon[index].x),
                  Math.abs(point.y - paintedPolygon[index].y),
                ]),
              ),
              deviceAlignmentError: Math.max(
                ...rawPolygon.flatMap((point, index) => [
                  Math.abs(point.x - paintedPolygon[index].x),
                  Math.abs(point.y - paintedPolygon[index].y),
                ]),
              ) * dpr,
              framebufferEdgeColorError,
              clipUsesPixels: element.style.clipPath.includes("px"),
              lod: api.diagnostics().lod,
              rendererPixelRatio: dpr,
            };
          }));
          for (const measurement of measurements) {
            expect(measurement.rendererPixelRatio).toBeCloseTo(Math.min(deviceScaleFactor, 2), 8);
            expect(measurement.clipUsesPixels).toBe(true);
            if (measurement.lod === "detail") {
              expect(
                measurement.framebufferEdgeColorError,
                `${topology} ${cellSize}px at ${deviceScaleFactor}x cell ${measurement.x},${measurement.y}: ${JSON.stringify(measurement)}`,
              ).toBeLessThanOrEqual(48);
            }
            expect(
              measurement.deviceAlignmentError,
              `${topology} ${cellSize}px at ${deviceScaleFactor}x cell ${measurement.x},${measurement.y}: ${JSON.stringify(measurement)}`,
            ).toBeLessThan(0.04);
            expect(
              measurement.alignmentError,
              `${topology} ${cellSize}px at ${deviceScaleFactor}x cell ${measurement.x},${measurement.y}: ${JSON.stringify(measurement)}`,
            ).toBeLessThan(0.02);
            matrix.push({
              topology,
              deviceScaleFactor,
              cellSize,
              x: measurement.x,
              y: measurement.y,
              alignmentError: measurement.alignmentError,
              deviceAlignmentError: measurement.deviceAlignmentError,
            });
          }
          configurationCount += 1;
        }
      }
    } finally {
      await context.close();
    }
  }
  expect(configurationCount).toBe(80);
  expect(matrix).toHaveLength(720);
});

test("R26 — hover footprint can persistently reduce to the directly hovered cell", async ({ page }) => {
  await openDeterministicGame(page);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().hoverMode)).toBe("affected");
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-hover-preview"))).toBeNull();

  const prepareChord = async () => {
    await page.evaluate(() => {
      const model = window.__infiniteMines.model;
      model.reset("beginner", 1, false);
      model.mineAt = (x: number, y: number) => Math.abs(x % 2) === 1 && Math.abs(y % 2) === 1;
      model.reveal(0, 0);
      for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) model.cycleMark(x, y);
      window.__infiniteMines.renderer.home();
    });
  };
  const chordPreview = [
    { x: 0, y: 0 },
    { x: 0, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];

  await prepareChord();
  let center = await worldPoint(page, { x: 0, y: 0 });
  await page.mouse.move(center.x + 30, center.y);
  await page.mouse.move(center.x, center.y);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.renderer.hoverPreview)).toEqual(chordPreview);

  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator('#hover-options [data-hover="affected"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Hovered cell only/ }).click();
  await expect(page.locator('#hover-options [data-hover="cell"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close" }).click();
  await page.mouse.move(center.x + 30, center.y);
  await page.mouse.move(center.x, center.y);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.renderer.hoverPreview)).toEqual([{ x: 0, y: 0 }]);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible")).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-hover-preview"))).toBe("cell");

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().hoverMode)).toBe("cell");
  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator('#hover-options [data-hover="cell"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Affected cells/ }).click();
  await page.getByRole("button", { name: "Close" }).click();

  await prepareChord();
  center = await worldPoint(page, { x: 0, y: 0 });
  await page.mouse.move(center.x + 30, center.y);
  await page.mouse.move(center.x, center.y);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.renderer.hoverPreview)).toEqual(chordPreview);
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-hover-preview"))).toBe("affected");
});

test("R20 — one-pixel hover motion causes no WebGL work and rate-limits locator text", async ({ page }) => {
  await openDeterministicGame(page);
  const result = await page.evaluate(
    () =>
      new Promise<{
        webglFrames: number;
        instanceUploads: number;
        locatorMutations: number;
        markerCount: number;
        visibleMarkers: number;
        lod: string | undefined;
      }>((resolve) => {
        const api = window.__infiniteMines;
        const renderer = api.renderer;
        renderer.zoom = 0.04;
        renderer.requestRender();
        const canvas = document.querySelector<HTMLCanvasElement>("#board");
        const coordinate = document.querySelector("#cell-coordinate");
        if (!canvas || !coordinate) throw new Error("Missing hover fixtures");
        const bounds = canvas.getBoundingClientRect();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const before = api.diagnostics();
            let locatorMutations = 0;
            const observer = new MutationObserver((records) => {
              locatorMutations += records.length;
            });
            observer.observe(coordinate, { childList: true, characterData: true, subtree: true });
            let frame = 0;
            const step = () => {
              canvas.dispatchEvent(
                new PointerEvent("pointermove", {
                  bubbles: true,
                  clientX: bounds.left + 200 + frame * 3,
                  clientY: bounds.top + 300,
                  pointerId: 77,
                  pointerType: "mouse",
                }),
              );
              frame += 1;
              if (frame < 120) {
                requestAnimationFrame(step);
                return;
              }
              requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                  setTimeout(() => {
                    observer.disconnect();
                    const after = api.diagnostics();
                    resolve({
                      webglFrames: after.frameCount - before.frameCount,
                      instanceUploads: after.instanceUploads - before.instanceUploads,
                      locatorMutations,
                      markerCount: document.querySelectorAll("#hover-overlay .hover-cell").length,
                      visibleMarkers: document.querySelectorAll("#hover-overlay .hover-cell.is-visible").length,
                      lod: (document.querySelector("#hover-overlay") as HTMLElement | null)?.dataset.lod,
                    });
                  }, 70),
                ),
              );
            };
            requestAnimationFrame(step);
          }),
        );
      }),
  );
  expect(result.webglFrames).toBe(0);
  expect(result.instanceUploads).toBe(0);
  expect(result.locatorMutations).toBeLessThanOrEqual(50);
  expect(result.markerCount).toBe(19);
  expect(result.visibleMarkers).toBe(1);
  expect(result.lod).toBe("pixel");
});

test("R16 — touch identifies a cell without requiring hover", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await openDeterministicGame(page);
    const target = await findCell(page, "covered-safe");
    const point = await worldPoint(page, target);
    await page.touchscreen.tap(point.x, point.y);
    await expect(page.locator("#cell-locator")).toHaveAttribute("data-x", String(target.x));
    await expect(page.locator("#cell-locator")).toHaveAttribute("data-y", String(target.y));
  } finally {
    await context.close();
  }
});
