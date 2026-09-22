import { expect, test, type Page } from "@playwright/test";
import { openDeterministicGame } from "./helpers";

const waitForNextFrame = async (page: Page, previous: number): Promise<void> => {
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBeGreaterThan(previous);
};

test("R51 — right-angled hyperbolic pentagons stay exact, interactive, persistent, and bounded", async ({ context, page }) => {
  test.setTimeout(60_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => localStorage.setItem("infinite-mines-things", "off"));
  await openDeterministicGame(page, 0x5f40_0051);

  await page.getByRole("button", { name: "Game settings" }).click();
  await page.getByRole("button", { name: /Hyperbolic pentagons/ }).click();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().backend)).toBe("canvas2d");
  await expect(page.locator("#topology-pill")).toHaveText("HYPERBOLIC PENTAGONS");

  const contract = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const touching: Array<{ x: number; y: number }> = [];
    api.model.topology.forEachNeighbor(0, 0, (x, y) => touching.push({ x, y }));
    const edges = api.model.topology.edgeNeighbors(0, 0);
    const centerHit = api.renderer.screenToCell(api.renderer.canvas.clientWidth / 2, api.renderer.canvas.clientHeight / 2);
    return { touching, edges, centerHit, diagnostics: api.diagnostics() };
  });
  expect(contract.touching).toHaveLength(10);
  expect(contract.edges).toHaveLength(5);
  expect(new Set(contract.touching.map(({ x, y }) => `${x},${y}`)).size).toBe(10);
  expect(contract.centerHit).toEqual({ x: 0, y: 0 });
  expect(contract.diagnostics).toMatchObject({
    backend: "canvas2d",
    topology: "pentagonal",
    drawCalls: 1,
    thingsEnabled: false,
    thingSprites: 0,
    canvasCount: 4,
  });
  expect(contract.diagnostics.visibleCells).toBeLessThanOrEqual(384);
  expect(contract.diagnostics.openedCells).toBeLessThanOrEqual(128);

  const fullViewport = await page.evaluate(() => {
    const renderer = window.__infiniteMines.renderer;
    const width = renderer.canvas.clientWidth;
    const height = renderer.canvas.clientHeight;
    const corners = [
      { x: 1, y: 1 },
      { x: width - 1, y: 1 },
      { x: 1, y: height - 1 },
      { x: width - 1, y: height - 1 },
    ];
    return corners.map((point) => ({
      contained: renderer.containsScreenPoint(point.x, point.y),
      cell: renderer.screenToCell(point.x, point.y),
    }));
  });
  expect(fullViewport.every(({ contained }) => contained)).toBe(true);
  expect(new Set(fullViewport.map(({ cell }) => `${cell.x},${cell.y}`)).size).toBe(4);

  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator('[data-things="on"]')).toBeDisabled();
  await page.locator("#settings-dialog .close-button").click();

  const prepared = await page.evaluate(() => {
    const api = window.__infiniteMines;
    api.model.store.clear();
    api.model.store.set(0, 0, 2);
    api.renderer.home();
    return api.diagnostics().frameCount;
  });
  await waitForNextFrame(page, prepared);

  const rootCenter = await page.evaluate(() => {
    const polygon = window.__infiniteMines.renderer.cellScreenPolygon(0, 0);
    return {
      x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
      y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
    };
  });
  const board = await page.locator("#board").boundingBox();
  if (!board) throw new Error("Board is not visible");

  const edgeCell = await page.evaluate(() => window.__infiniteMines.renderer.screenToCell(5, 70));
  await page.mouse.click(board.x + 5, board.y + 70, { button: "right" });
  expect(await page.evaluate((cell) => window.__infiniteMines.model.getState(cell.x, cell.y), edgeCell)).toBe(10);

  const zoomedOut = await page.evaluate(() => {
    const api = window.__infiniteMines;
    api.renderer.zoomAt(api.renderer.canvas.clientWidth / 2, api.renderer.canvas.clientHeight / 2, 0.4);
    return api.diagnostics().frameCount;
  });
  await waitForNextFrame(page, zoomedOut);
  const beforeOutsideClick = await page.evaluate(() => [...new Uint8Array(window.__infiniteMines.model.createSnapshot().cells)]);
  await page.mouse.click(board.x + 5, board.y + board.height / 2, { button: "right" });
  expect(await page.evaluate(() => [...new Uint8Array(window.__infiniteMines.model.createSnapshot().cells)])).toEqual(
    beforeOutsideClick,
  );
  await expect(page.locator("#hover-overlay .hover-cell.is-visible")).toHaveCount(0);

  const homed = await page.evaluate(() => {
    const api = window.__infiniteMines;
    api.renderer.home();
    return api.diagnostics().frameCount;
  });
  await waitForNextFrame(page, homed);

  await page.mouse.move(board.x + rootCenter.x, board.y + rootCenter.y);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible")).toHaveCount(11);

  const target = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const candidates = api.model.topology.edgeNeighbors(0, 0).map((cell) => {
      const polygon = api.renderer.cellScreenPolygon(cell.x, cell.y);
      return {
        cell,
        polygon,
        point: {
          x: polygon.reduce((sum, vertex) => sum + vertex.x, 0) / polygon.length,
          y: polygon.reduce((sum, vertex) => sum + vertex.y, 0) / polygon.length,
        },
      };
    });
    const selected = candidates
      .filter(({ point }) => api.renderer.containsScreenPoint(point.x, point.y))
      .sort((left, right) => right.point.x - left.point.x)[0];
    if (!selected) throw new Error("No visible edge-neighbor is available");
    return {
      cell: selected.cell,
      point: selected.point,
    };
  });
  await page.mouse.click(board.x + target.point.x, board.y + target.point.y, { button: "right" });
  expect(await page.evaluate((cell) => window.__infiniteMines.model.getState(cell.x, cell.y), target.cell)).toBe(10);
  await page.locator("#cell-locator").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /topology=pentagonal \| path=(?:root|\d+(?:\.\d+)*) \| seed=/,
  );

  const beforeRotation = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const offCenterCell = api.model.topology.edgeNeighbors(0, 0)[0];
    const offCenterPolygon = api.renderer.cellScreenPolygon(offCenterCell.x, offCenterCell.y);
    const canvas = api.renderer.curvedCanvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing curved context");
    const dpr = api.diagnostics().pixelRatio;
    const x = Math.round(canvas.width / 2 - 30 * dpr);
    const y = Math.round(canvas.height / 2 - 30 * dpr);
    return {
      pixels: [...context.getImageData(x, y, Math.round(60 * dpr), Math.round(60 * dpr)).data],
      offCenterCell,
      offCenter: {
        x: offCenterPolygon.reduce((sum, point) => sum + point.x, 0) / offCenterPolygon.length,
        y: offCenterPolygon.reduce((sum, point) => sum + point.y, 0) / offCenterPolygon.length,
      },
      viewport: { width: canvas.clientWidth, height: canvas.clientHeight },
      model: api.model.createSnapshot().cells.byteLength,
      view: api.renderer.createViewSnapshot(),
      frame: api.diagnostics().frameCount,
    };
  });
  await page.getByRole("button", { name: "Game settings" }).click();
  await page.locator('#rotation-options button[data-rotation="90"]').click();
  await waitForNextFrame(page, beforeRotation.frame);
  await page.locator("#settings-dialog .close-button").click();
  const afterRotation = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const offCenterCell = api.model.topology.edgeNeighbors(0, 0)[0];
    const offCenterPolygon = api.renderer.cellScreenPolygon(offCenterCell.x, offCenterCell.y);
    const canvas = api.renderer.curvedCanvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing curved context");
    const dpr = api.diagnostics().pixelRatio;
    return {
      pixels: [
        ...context.getImageData(
          Math.round(canvas.width / 2 - 30 * dpr),
          Math.round(canvas.height / 2 - 30 * dpr),
          Math.round(60 * dpr),
          Math.round(60 * dpr),
        ).data,
      ],
      model: api.model.createSnapshot().cells.byteLength,
      view: api.renderer.createViewSnapshot(),
      offCenter: {
        x: offCenterPolygon.reduce((sum, point) => sum + point.x, 0) / offCenterPolygon.length,
        y: offCenterPolygon.reduce((sum, point) => sum + point.y, 0) / offCenterPolygon.length,
      },
      offCenterHit: api.renderer.screenToCell(
        offCenterPolygon.reduce((sum, point) => sum + point.x, 0) / offCenterPolygon.length,
        offCenterPolygon.reduce((sum, point) => sum + point.y, 0) / offCenterPolygon.length,
      ),
      hit: api.renderer.screenToCell(api.renderer.canvas.clientWidth / 2, api.renderer.canvas.clientHeight / 2),
    };
  });
  expect(afterRotation.pixels).toEqual(beforeRotation.pixels);
  expect(afterRotation.model).toBe(beforeRotation.model);
  expect(afterRotation.view).toEqual(beforeRotation.view);
  expect(afterRotation.hit).toEqual({ x: 0, y: 0 });
  expect(afterRotation.offCenterHit).toEqual(beforeRotation.offCenterCell);
  const beforeOffset = {
    x: beforeRotation.offCenter.x - beforeRotation.viewport.width / 2,
    y: beforeRotation.offCenter.y - beforeRotation.viewport.height / 2,
  };
  const afterOffset = {
    x: afterRotation.offCenter.x - beforeRotation.viewport.width / 2,
    y: afterRotation.offCenter.y - beforeRotation.viewport.height / 2,
  };
  expect(afterOffset.x).toBeCloseTo(-beforeOffset.y, 5);
  expect(afterOffset.y).toBeCloseTo(beforeOffset.x, 5);

  const focal = { x: 730, y: 470 };
  const navigation = await page.evaluate(({ x, y }) => {
    const api = window.__infiniteMines;
    const before = api.renderer.screenToCell(x, y);
    api.renderer.zoomAt(x, y, 1.25);
    const after = api.renderer.screenToCell(x, y);
    api.renderer.panBy(600, 100);
    return { before, after, frame: api.diagnostics().frameCount };
  }, focal);
  expect(navigation.after).toEqual(navigation.before);
  await waitForNextFrame(page, navigation.frame);
  const movedCenter = await page.evaluate(() => {
    const api = window.__infiniteMines;
    return api.renderer.screenToCell(api.renderer.canvas.clientWidth / 2, api.renderer.canvas.clientHeight / 2);
  });
  expect(movedCenter).not.toEqual({ x: 0, y: 0 });

  await page.getByRole("button", { name: "Overview map" }).click();
  await expect(page.locator("#overview-caption")).toContainText("Hyperbolic pentagons");
  await page.locator("#overview-close").click();

  const samples: number[] = [];
  for (let index = 0; index < 40; index += 1) {
    const previous = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
    await page.evaluate((delta) => window.__infiniteMines.renderer.panBy(delta, 0), index % 2 === 0 ? 1 : -1);
    await waitForNextFrame(page, previous);
    samples.push(await page.evaluate(() => window.__infiniteMines.diagnostics().frameMs));
  }
  samples.sort((left, right) => left - right);
  expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(35);

  const saved = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    await api.flushSave();
    return {
      view: api.renderer.createViewSnapshot(),
      cells: [...new Uint8Array(api.model.createSnapshot().cells)],
      rotation: api.renderer.rotation,
    };
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().persistenceStatus)).toBe("restored");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().backend)).toBe("canvas2d");
  const restored = await page.evaluate(() => {
    const api = window.__infiniteMines;
    return {
      view: api.renderer.createViewSnapshot(),
      cells: [...new Uint8Array(api.model.createSnapshot().cells)],
      rotation: api.renderer.rotation,
      diagnostics: api.diagnostics(),
    };
  });
  expect(restored.view).toEqual(saved.view);
  expect(restored.cells).toEqual(saved.cells);
  expect(restored.rotation).toBe(saved.rotation);
  expect(restored.diagnostics).toMatchObject({ topology: "pentagonal", backend: "canvas2d", canvasCount: 4 });
});
