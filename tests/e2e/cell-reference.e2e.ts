import { expect, test } from "@playwright/test";
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
    `Infinite Mines cell (${current.x}, ${current.y}) | mode=${expected.mode} | density=${expected.density} | topology=square | seed=${expected.seed} | safe=${expected.safe} | state=${current.state} | scale=${expected.scale}px/tile | theme=light`,
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
