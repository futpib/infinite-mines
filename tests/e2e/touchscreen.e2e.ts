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

test("R22/R47 — armed reveal has a live cancel zone without panning while pre-arm drag still pans", async ({ browser }) => {
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
    await expect(page.locator("#touch-preview")).toBeHidden();
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(1, startX + 4, startY + 4)],
    });
    expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual(before.view);
    await expect(page.locator("#touch-preview")).toBeHidden();
    await page.waitForTimeout(470);
    await expect(page.locator("#touch-preview")).toBeVisible();
    const initialPreview = await page.locator("#touch-preview").boundingBox();
    if (!initialPreview) throw new Error("Missing touch preview bounds");
    expect(initialPreview.x).toBeGreaterThanOrEqual(12);
    expect(initialPreview.x + initialPreview.width).toBeLessThanOrEqual(1188);
    expect(initialPreview.y + initialPreview.height).toBeLessThan(startY - 30);
    await expect(page.locator("#touch-preview-coordinate")).toHaveCount(0);
    await expect(page.locator("#touch-preview-action > span")).toHaveText([
      "RELEASE TO REVEAL",
      "DRAG TO CANCEL",
    ]);
    await expect(page.locator("#touch-preview")).toHaveAttribute("data-release", "reveal");
    const revealVisual = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>("#touch-preview-viewport");
      const action = document.querySelector<HTMLElement>("#touch-preview-action");
      if (!viewport || !action) throw new Error("Missing armed preview");
      return {
        shadow: getComputedStyle(viewport).boxShadow,
        actionColor: getComputedStyle(action).color,
      };
    });
    const previewLayout = await page.locator(".touch-preview-card").evaluate((card) => {
      const neighborhood = card.querySelector<HTMLElement>("#touch-preview-neighborhood");
      const viewport = card.querySelector<HTMLElement>("#touch-preview-viewport");
      const action = card.querySelector<HTMLElement>("#touch-preview-action");
      if (!neighborhood || !viewport || !action) throw new Error("Missing neighborhood preview");
      const cardBounds = card.getBoundingClientRect();
      const neighborhoodBounds = neighborhood.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      const actionBounds = action.getBoundingClientRect();
      const style = getComputedStyle(card);
      const viewportStyle = getComputedStyle(viewport);
      return {
        card: { width: cardBounds.width, height: cardBounds.height },
        neighborhood: { width: neighborhoodBounds.width, height: neighborhoodBounds.height },
        viewport: { width: viewportBounds.width, height: viewportBounds.height, bottom: viewportBounds.bottom },
        action: { width: actionBounds.width, height: actionBounds.height, top: actionBounds.top },
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        viewportClip: {
          overflow: viewportStyle.overflow,
          borderRadius: viewportStyle.borderRadius,
          outlineWidth: viewportStyle.outlineWidth,
          borderWidth: viewportStyle.borderWidth,
          boxShadow: viewportStyle.boxShadow,
        },
      };
    });
    expect(previewLayout.padding).toEqual(["0px", "0px", "0px", "0px"]);
    expect(previewLayout.viewportClip).toEqual({
      overflow: "visible",
      borderRadius: "0px",
      outlineWidth: "0px",
      borderWidth: "0px",
      boxShadow: previewLayout.viewportClip.boxShadow,
    });
    expect(previewLayout.viewportClip.boxShadow).not.toBe("none");
    expect(previewLayout.viewportClip.boxShadow).not.toContain("inset");
    expect(previewLayout.viewport).toMatchObject(previewLayout.neighborhood);
    expect(previewLayout.action.top).toBeGreaterThanOrEqual(previewLayout.viewport.bottom);
    expect(previewLayout.card.width).toBeCloseTo(previewLayout.neighborhood.width, 5);
    expect(previewLayout.card.height).toBeGreaterThan(previewLayout.neighborhood.height);

    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(1, startX + 80, startY + 30)],
    });
    await expect(page.locator("#touch-preview")).toBeVisible();
    await expect(page.locator("#touch-preview")).toHaveAttribute("data-release", "cancel");
    await expect(page.locator("#touch-preview-action > span")).toHaveText([
      "RELEASE TO CANCEL",
      "DRAG BACK TO REVEAL",
    ]);
    const cancelVisual = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>("#touch-preview-viewport");
      const action = document.querySelector<HTMLElement>("#touch-preview-action");
      if (!viewport || !action) throw new Error("Missing cancelled preview");
      return {
        shadow: getComputedStyle(viewport).boxShadow,
        actionColor: getComputedStyle(action).color,
        view: window.__infiniteMines.renderer.createViewSnapshot(),
      };
    });
    expect(cancelVisual.shadow).not.toBe(revealVisual.shadow);
    expect(cancelVisual.actionColor).not.toBe(revealVisual.actionColor);
    expect(cancelVisual.view).toEqual(before.view);

    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(1, startX + 4, startY + 4)],
    });
    await expect(page.locator("#touch-preview")).toHaveAttribute("data-release", "reveal");
    await expect(page.locator("#touch-preview-action > span")).toHaveText([
      "RELEASE TO REVEAL",
      "DRAG TO CANCEL",
    ]);
    const returnedVisual = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>("#touch-preview-viewport");
      const action = document.querySelector<HTMLElement>("#touch-preview-action");
      if (!viewport || !action) throw new Error("Missing re-armed preview");
      return {
        shadow: getComputedStyle(viewport).boxShadow,
        actionColor: getComputedStyle(action).color,
        view: window.__infiniteMines.renderer.createViewSnapshot(),
      };
    });
    expect(returnedVisual.shadow).toBe(revealVisual.shadow);
    expect(returnedVisual.actionColor).toBe(revealVisual.actionColor);
    expect(returnedVisual.view).toEqual(before.view);

    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(1, startX + 80, startY + 30)],
    });
    await expect(page.locator("#touch-preview")).toHaveAttribute("data-release", "cancel");
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().pixelRatio)).toBe(2);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator("#touch-preview")).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().pixelRatio)).toBe(2);
    const afterCancel = await page.evaluate(() => ({
      view: window.__infiniteMines.renderer.createViewSnapshot(),
      openedCells: window.__infiniteMines.diagnostics().openedCells,
      score: window.__infiniteMines.diagnostics().score,
      storeVersion: window.__infiniteMines.model.store.version,
    }));
    expect(afterCancel.view).toEqual(before.view);
    expect(afterCancel.openedCells).toBe(before.openedCells);
    expect(afterCancel.score).toBe(before.score);
    expect(afterCancel.storeVersion).toBe(before.storeVersion);

    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint(2, startX, startY)],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(2, startX + 80, startY + 30)],
    });
    await expect(page.locator("#touch-preview")).toBeHidden();
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const afterPan = await page.evaluate(() => ({
      view: window.__infiniteMines.renderer.createViewSnapshot(),
      openedCells: window.__infiniteMines.diagnostics().openedCells,
      score: window.__infiniteMines.diagnostics().score,
      storeVersion: window.__infiniteMines.model.store.version,
    }));
    expect(afterPan.view.panX).toBeCloseTo(before.view.panX + 80, 5);
    expect(afterPan.view.panY).toBeCloseTo(before.view.panY + 30, 5);
    expect(afterPan.view.zoom).toBe(before.view.zoom);
    expect(afterPan.openedCells).toBe(before.openedCells);
    expect(afterPan.score).toBe(before.score);
    expect(afterPan.storeVersion).toBe(before.storeVersion);

    const edgeX = bounds.x + bounds.width / 2;
    const edgeY = bounds.y + 100;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint(3, edgeX, edgeY)],
    });
    await expect(page.locator("#touch-preview")).toBeHidden();
    await page.waitForTimeout(470);
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

test("R47 — the board-scale neighborhood stays topology-aware and usable at pixel zoom", async ({ browser }) => {
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
      let best: {
        x: number;
        y: number;
        screenX: number;
        screenY: number;
        width: number;
        height: number;
        distance: number;
      } | null = null;
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
          if (!best || distance < best.distance) best = { x, y, screenX, screenY, width, height, distance };
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
      await expect(page.locator("#touch-preview")).toBeHidden();
      await page.waitForTimeout(470);
      await expect(page.locator("#touch-preview")).toHaveAttribute("data-topology", topology);
      await expect(page.locator("#touch-preview-coordinate")).toHaveCount(0);
      const previewGeometry = await page.evaluate(() => {
        const neighborhood = document.querySelector<HTMLCanvasElement>("#touch-preview-neighborhood");
        const viewport = document.querySelector<HTMLElement>("#touch-preview-viewport");
        const targetPolygon = document.querySelector<SVGGraphicsElement>("#touch-preview-target");
        const action = document.querySelector<HTMLElement>("#touch-preview-action");
        if (!neighborhood || !viewport || !targetPolygon || !action) {
          throw new Error("Missing neighborhood preview geometry");
        }
        const neighborhoodBounds = neighborhood.getBoundingClientRect();
        const viewportBounds = viewport.getBoundingClientRect();
        const targetBounds = targetPolygon.getBBox();
        const actionBounds = action.getBoundingClientRect();
        const context = neighborhood.getContext("2d");
        if (!context) throw new Error("Missing neighborhood preview context");
        const board = document.querySelector<HTMLCanvasElement>("#board");
        const gl = board?.getContext("webgl2");
        const preview = window.__infiniteMines.diagnostics().touchPreview;
        if (!board || !gl || !preview) throw new Error("Missing board-scale preview source");
        const previewPixels = context.getImageData(0, 0, neighborhood.width, neighborhood.height).data;
        const sourcePixelX = Math.round(preview.sourceX * window.__infiniteMines.diagnostics().pixelRatio);
        const sourcePixelY = Math.round(preview.sourceY * window.__infiniteMines.diagnostics().pixelRatio);
        const cells = [{ x: preview.x, y: preview.y }];
        window.__infiniteMines.model.topology.forEachNeighbor(preview.x, preview.y, (x, y) => cells.push({ x, y }));
        const completeNeighborhood = cells.flatMap(({ x, y }) => window.__infiniteMines.renderer.cellScreenPolygon(x, y));
        const minX = Math.min(...completeNeighborhood.map((point) => point.x));
        const minY = Math.min(...completeNeighborhood.map((point) => point.y));
        const maxX = Math.max(...completeNeighborhood.map((point) => point.x));
        const maxY = Math.max(...completeNeighborhood.map((point) => point.y));
        const pixelRatio = window.__infiniteMines.diagnostics().pixelRatio;
        const tolerance = 1 / pixelRatio + 0.01;
        const containsCompleteNeighborhood =
          minX >= preview.sourceX - tolerance &&
          minY >= preview.sourceY - tolerance &&
          maxX <= preview.sourceX + neighborhoodBounds.width + tolerance &&
          maxY <= preview.sourceY + neighborhoodBounds.height + tolerance;
        const ownedEdgeExtension = window.__infiniteMines.model.topologyId === "square"
          ? window.__infiniteMines.diagnostics().borderCssPixels
          : 0;
        const tightToRenderedNeighborhood =
          preview.neighborhoodRings === 1 &&
          minX - preview.sourceX >= -tolerance &&
          minX - preview.sourceX < tolerance &&
          minY - preview.sourceY >= -tolerance &&
          minY - preview.sourceY < tolerance &&
          preview.sourceX + neighborhoodBounds.width - maxX >= ownedEdgeExtension - tolerance &&
          preview.sourceX + neighborhoodBounds.width - maxX < ownedEdgeExtension + tolerance &&
          preview.sourceY + neighborhoodBounds.height - maxY >= ownedEdgeExtension - tolerance &&
          preview.sourceY + neighborhoodBounds.height - maxY < ownedEdgeExtension + tolerance;
        const targetScreenPolygon = window.__infiniteMines.renderer.cellScreenPolygon(preview.x, preview.y);
        const sampleCssX =
          targetScreenPolygon.reduce((sum, point) => sum + point.x, 0) / targetScreenPolygon.length - preview.sourceX;
        const sampleCssY =
          targetScreenPolygon.reduce((sum, point) => sum + point.y, 0) / targetScreenPolygon.length - preview.sourceY;
        const samplePixelX = Math.min(neighborhood.width - 1, Math.max(0, Math.floor(sampleCssX * pixelRatio)));
        const samplePixelY = Math.min(neighborhood.height - 1, Math.max(0, Math.floor(sampleCssY * pixelRatio)));
        const sourcePixel = new Uint8Array(4);
        gl.readPixels(
          sourcePixelX + samplePixelX,
          board.height - sourcePixelY - samplePixelY - 1,
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          sourcePixel,
        );
        const previewOffset = (samplePixelY * neighborhood.width + samplePixelX) * 4;
        const sampleMatches = sourcePixel.every((channel, index) => channel === previewPixels[previewOffset + index]);
        return {
          neighborhood: {
            width: neighborhoodBounds.width,
            height: neighborhoodBounds.height,
            backingWidth: neighborhood.width,
            backingHeight: neighborhood.height,
          },
          target: { width: targetBounds.width, height: targetBounds.height },
          actionStartsAfterNeighborhood: actionBounds.top >= viewportBounds.bottom,
          containsCompleteNeighborhood,
          tightToRenderedNeighborhood,
          sampleMatches,
          pixelRatio,
          cellSize: window.__infiniteMines.renderer.cellSize,
          previewCellSize: window.__infiniteMines.diagnostics().touchPreview?.cellSize,
          neighborhoodCells: preview.neighborhoodCells,
          neighborhoodRings: preview.neighborhoodRings,
          captureMs: window.__infiniteMines.diagnostics().touchPreview?.captureMs,
        };
      });
      expect(previewGeometry.neighborhood.width).toBeGreaterThanOrEqual(64);
      expect(previewGeometry.neighborhood.height).toBeGreaterThanOrEqual(64);
      expect(previewGeometry.neighborhood.backingWidth).toBe(Math.round(previewGeometry.neighborhood.width * previewGeometry.pixelRatio));
      expect(previewGeometry.neighborhood.backingHeight).toBe(Math.round(previewGeometry.neighborhood.height * previewGeometry.pixelRatio));
      expect(previewGeometry.target.width).toBeCloseTo(target.width, 2);
      expect(previewGeometry.target.height).toBeCloseTo(target.height, 2);
      expect(previewGeometry.previewCellSize).toBeCloseTo(previewGeometry.cellSize, 3);
      expect(previewGeometry.neighborhoodRings).toBe(1);
      expect(previewGeometry.neighborhoodCells).toBeGreaterThan(1);
      expect(previewGeometry.captureMs).toBeLessThan(8);
      expect(previewGeometry.actionStartsAfterNeighborhood).toBe(true);
      expect(previewGeometry.containsCompleteNeighborhood).toBe(true);
      expect(previewGeometry.tightToRenderedNeighborhood).toBe(true);
      expect(previewGeometry.sampleMatches).toBe(true);
      await cancel();
    }

    await page.evaluate(() => {
      const renderer = window.__infiniteMines.renderer;
      renderer.zoomAt(195, 422, 0.001);
    });
    await expect.poll(() => page.evaluate(() => window.__infiniteMines.renderer.cellSize)).toBe(1);
    const pixelTarget = await page.evaluate(() => {
      const point = { x: 245, y: 610 };
      const cell = window.__infiniteMines.renderer.screenToCell(point.x, point.y);
      const polygon = window.__infiniteMines.renderer.cellScreenPolygon(cell.x, cell.y);
      return {
        ...point,
        cell,
        width: Math.max(...polygon.map((vertex) => vertex.x)) - Math.min(...polygon.map((vertex) => vertex.x)),
        height: Math.max(...polygon.map((vertex) => vertex.y)) - Math.min(...polygon.map((vertex) => vertex.y)),
      };
    });
    await startAt(pixelTarget);
    await expect(page.locator("#touch-preview")).toBeHidden();
    await page.waitForTimeout(470);
    await expect(page.locator("#touch-preview")).toBeVisible();
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics().touchPreview)).toMatchObject({
      ...pixelTarget.cell,
      action: "reveal",
      armed: true,
      cellSize: 1,
    });
    const previewBounds = await page.locator("#touch-preview").boundingBox();
    const pixelNeighborhoodBounds = await page.locator("#touch-preview-neighborhood").boundingBox();
    const pixelActionBounds = await page.locator("#touch-preview-action").boundingBox();
    if (!previewBounds || !pixelNeighborhoodBounds || !pixelActionBounds) throw new Error("Missing pixel-zoom preview bounds");
    expect(pixelNeighborhoodBounds.width).toBeGreaterThanOrEqual(64);
    expect(pixelNeighborhoodBounds.height).toBeGreaterThanOrEqual(64);
    expect(pixelActionBounds.y).toBeGreaterThanOrEqual(pixelNeighborhoodBounds.y + pixelNeighborhoodBounds.height);
    expect(previewBounds.y + previewBounds.height).toBeLessThan(pixelTarget.y - 30);
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics().touchPreview?.neighborhoodRings)).toBe(1);
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics().touchPreview?.captureMs)).toBeLessThan(8);
    const pixelTargetBounds = await page.locator("#touch-preview-target").evaluate((target) => {
      const bounds = (target as SVGGraphicsElement).getBBox();
      return { width: bounds.width, height: bounds.height };
    });
    expect(pixelTargetBounds.width).toBeCloseTo(pixelTarget.width, 2);
    expect(pixelTargetBounds.height).toBeCloseTo(pixelTarget.height, 2);
    await cancel();
  } finally {
    await session.detach();
    await context.close();
  }
});

test("R47 — preview pixels stay aligned and unobscured across zoom and device scale", async ({ browser }) => {
  test.setTimeout(120_000);
  const matrix: Array<{
    topology: "square" | "rhombille" | "triangular";
    deviceScaleFactor: number;
    rendererPixelRatio: number;
    cellSize: number;
    width: number;
    height: number;
    edgeSlack: number;
    ownedEdgeExtension: number;
    rightOwnedEdgePresent: boolean;
    bottomOwnedEdgePresent: boolean;
    rightOwnedEdgePixels: boolean;
    bottomOwnedEdgePixels: boolean;
    targetAlignmentError: number;
    viewBoxAlignmentError: number;
    labelOverlap: number;
    captureMs: number;
  }> = [];

  for (const deviceScaleFactor of [1, 1.25, 1.5, 2, 3]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    const session = await context.newCDPSession(page);
    let pointerId = 200;
    try {
      await openDeterministicGame(page);
      for (const topology of ["square", "rhombille", "triangular"] as const) {
        const target = await page.evaluate((topologyId) => {
          const api = window.__infiniteMines;
          api.model.reset("beginner", 0x5eed_1234, false, topologyId);
          for (let y = -2; y <= 2; y += 1) {
            for (let x = -2; x <= 2; x += 1) {
              if (x !== 0 || y !== 0) api.model.store.set(x, y, 2);
            }
          }
          api.renderer.requestRender();
          return { x: 0, y: 0 };
        }, topology);
        for (const cellSize of [1, 4, 8, 25, 34.25, 55]) {
        const touch = await page.evaluate(({ nextCellSize, cell }) => {
          const api = window.__infiniteMines;
          const board = document.querySelector<HTMLCanvasElement>("#board");
          if (!board) throw new Error("Missing board");
          const bounds = board.getBoundingClientRect();
          const localTarget = { x: bounds.width / 2, y: 600 };
          api.renderer.restoreView({
            version: 1,
            zoom: nextCellSize / 25,
            panX: 0,
            panY: 0,
          });
          const polygon = api.renderer.cellScreenPolygon(cell.x, cell.y);
          const center = {
            x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
            y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
          };
          api.renderer.restoreView({
            version: 1,
            zoom: nextCellSize / 25,
            panX: localTarget.x - center.x,
            panY: localTarget.y - center.y,
          });
          return { cell, pageX: bounds.left + localTarget.x, pageY: bounds.top + localTarget.y };
        }, { nextCellSize: cellSize, cell: { x: target.x, y: target.y } });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), touch.cell)).toBe(0);
        pointerId += 1;
        await session.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [touchPoint(pointerId, touch.pageX, touch.pageY)],
        });
        await page.waitForTimeout(450);
        await expect(page.locator("#touch-preview")).toBeVisible();
        const measurement = await page.evaluate(() => {
          const api = window.__infiniteMines;
          const preview = api.diagnostics().touchPreview;
          const canvas = document.querySelector<HTMLCanvasElement>("#touch-preview-neighborhood");
          const viewport = document.querySelector<HTMLElement>("#touch-preview-viewport");
          const action = document.querySelector<HTMLElement>("#touch-preview-action");
          const targetOverlay = document.querySelector<SVGSVGElement>("#touch-preview-target-overlay");
          const target = document.querySelector<SVGGraphicsElement>("#touch-preview-target");
          const targetClip = document.querySelector<SVGGraphicsElement>("#touch-preview-target-clip-polygon");
          const board = document.querySelector<HTMLCanvasElement>("#board");
          const gl = board?.getContext("webgl2");
          const context2d = canvas?.getContext("2d");
          if (!preview || !canvas || !viewport || !action || !targetOverlay || !target || !targetClip || !board || !gl || !context2d) {
            throw new Error("Missing preview measurement surface");
          }
          const pixelRatio = api.diagnostics().pixelRatio;
          const borderCssPixels = api.diagnostics().borderCssPixels;
          const viewportBounds = viewport.getBoundingClientRect();
          const actionBounds = action.getBoundingClientRect();
          const cells = [{ x: preview.x, y: preview.y }];
          api.model.topology.forEachNeighbor(preview.x, preview.y, (x, y) => cells.push({ x, y }));
          const points = cells.flatMap(({ x, y }) => api.renderer.cellScreenPolygon(x, y));
          const minX = Math.min(...points.map((point) => point.x));
          const minY = Math.min(...points.map((point) => point.y));
          const maxX = Math.max(...points.map((point) => point.x));
          const maxY = Math.max(...points.map((point) => point.y));
          const tolerance = 1 / pixelRatio + 0.01;
          const completeRing =
            minX >= preview.sourceX - tolerance &&
            minY >= preview.sourceY - tolerance &&
            maxX <= preview.sourceX + viewportBounds.width + tolerance &&
            maxY <= preview.sourceY + viewportBounds.height + tolerance;
          const ringWidth = maxX - minX;
          const ringHeight = maxY - minY;
          const ownedEdgeExtension = api.model.topologyId === "square" ? borderCssPixels : 0;
          const rightOwnedEdgePresent =
            preview.sourceX + viewportBounds.width >= maxX + ownedEdgeExtension - tolerance;
          const bottomOwnedEdgePresent =
            preview.sourceY + viewportBounds.height >= maxY + ownedEdgeExtension - tolerance;
          const borderColor = getComputedStyle(document.documentElement).getPropertyValue("--board-cell-border").trim();
          const borderRgb = [
            Number.parseInt(borderColor.slice(1, 3), 16),
            Number.parseInt(borderColor.slice(3, 5), 16),
            Number.parseInt(borderColor.slice(5, 7), 16),
          ];
          const hasBorderPixel = (screenX: number, screenY: number, horizontal: boolean): boolean => {
            const baseX = Math.floor((screenX - preview.sourceX) * pixelRatio);
            const baseY = Math.floor((screenY - preview.sourceY) * pixelRatio);
            const radius = Math.ceil(pixelRatio) + 1;
            for (let offset = -1; offset <= radius; offset += 1) {
              const sampleX = horizontal ? baseX + offset : baseX;
              const sampleY = horizontal ? baseY : baseY + offset;
              if (sampleX < 0 || sampleX >= canvas.width || sampleY < 0 || sampleY >= canvas.height) continue;
              const sample = context2d.getImageData(sampleX, sampleY, 1, 1).data;
              if (borderRgb.every((channel, index) => Math.abs(channel - sample[index]) <= 3)) return true;
            }
            return false;
          };
          const detailedBorders = api.model.topologyId === "square" && api.diagnostics().detailMix > 0.999;
          const rightOwnedEdgePixels = !detailedBorders || [0.5, 1.5, 2.5].every((row) =>
            hasBorderPixel(maxX, minY + row * api.renderer.cellSize, true),
          );
          const bottomOwnedEdgePixels = !detailedBorders || [0.5, 1.5, 2.5].every((column) =>
            hasBorderPixel(minX + column * api.renderer.cellSize, maxY, false),
          );
          const edgeSlack = Math.max(
            minX - preview.sourceX,
            minY - preview.sourceY,
            preview.sourceX + viewportBounds.width - maxX,
            preview.sourceY + viewportBounds.height - maxY,
          );
          const targetPoints = api.renderer.cellScreenPolygon(preview.x, preview.y);
          const targetCoordinates = (target.getAttribute("points") ?? "").split(" ").map((pair) => {
            const [x, y] = pair.split(",").map(Number);
            return { x, y };
          });
          const targetTransform = target.getScreenCTM();
          if (!targetTransform || targetCoordinates.length !== targetPoints.length) {
            throw new Error("Missing painted target transform");
          }
          const paintedTargetPoints = targetCoordinates.map((point) =>
            new DOMPoint(point.x, point.y).matrixTransform(targetTransform),
          );
          const expectedTargetPoints = targetPoints.map((point) => ({
            x: viewportBounds.left + (point.x - preview.sourceX) * viewportBounds.width / preview.width,
            y: viewportBounds.top + (point.y - preview.sourceY) * viewportBounds.height / preview.height,
          }));
          const targetAlignmentError = Math.max(...paintedTargetPoints.flatMap((point, index) => [
            Math.abs(point.x - expectedTargetPoints[index].x),
            Math.abs(point.y - expectedTargetPoints[index].y),
          ]));
          const viewBoxAlignmentError = Math.max(
            Math.abs(targetOverlay.viewBox.baseVal.width - preview.width),
            Math.abs(targetOverlay.viewBox.baseVal.height - preview.height),
          );
          const sampleCssX =
            targetPoints.reduce((sum, point) => sum + point.x, 0) / targetPoints.length - preview.sourceX;
          const sampleCssY =
            targetPoints.reduce((sum, point) => sum + point.y, 0) / targetPoints.length - preview.sourceY;
          const samplePixelX = Math.min(canvas.width - 1, Math.max(0, Math.floor(sampleCssX * pixelRatio)));
          const samplePixelY = Math.min(canvas.height - 1, Math.max(0, Math.floor(sampleCssY * pixelRatio)));
          const sourcePixel = new Uint8Array(4);
          gl.readPixels(
            Math.round(preview.sourceX * pixelRatio) + samplePixelX,
            board.height - Math.round(preview.sourceY * pixelRatio) - samplePixelY - 1,
            1,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            sourcePixel,
          );
          const previewPixels = context2d.getImageData(samplePixelX, samplePixelY, 1, 1).data;
          const style = getComputedStyle(viewport);
          const targetStyle = getComputedStyle(target);
          const targetClipStyle = getComputedStyle(targetClip);
          return {
            topology: api.model.topologyId,
            rendererPixelRatio: pixelRatio,
            cellSize: api.renderer.cellSize,
            width: viewportBounds.width,
            height: viewportBounds.height,
            backingWidth: canvas.width,
            backingHeight: canvas.height,
            ringWidth,
            ringHeight,
            edgeSlack,
            ownedEdgeExtension,
            rightOwnedEdgePresent,
            bottomOwnedEdgePresent,
            rightOwnedEdgePixels,
            bottomOwnedEdgePixels,
            completeRing,
            targetAlignmentError,
            viewBoxAlignmentError,
            targetClipMatches: target.getAttribute("points") === targetClip.getAttribute("points"),
            targetPaint: {
              clipPath: targetStyle.clipPath,
              strokeWidth: targetStyle.strokeWidth,
              clipFill: targetClipStyle.fill,
              clipStroke: targetClipStyle.stroke,
            },
            labelOverlap: Math.max(
              0,
              Math.min(viewportBounds.right, actionBounds.right) - Math.max(viewportBounds.left, actionBounds.left),
            ) * Math.max(0, Math.min(viewportBounds.bottom, actionBounds.bottom) - Math.max(viewportBounds.top, actionBounds.top)),
            actionBelow: actionBounds.top >= viewportBounds.bottom,
            paint: {
              overflow: style.overflow,
              borderRadius: style.borderRadius,
              borderWidth: style.borderWidth,
              outlineWidth: style.outlineWidth,
              boxShadow: style.boxShadow,
            },
            framebufferMatches: sourcePixel.every((channel, index) => channel === previewPixels[index]),
            captureMs: preview.captureMs,
          };
        });
        expect(measurement.rendererPixelRatio).toBeCloseTo(Math.min(deviceScaleFactor, 2), 8);
        expect(measurement.cellSize).toBeCloseTo(cellSize, 8);
        expect(measurement.topology).toBe(topology);
        expect(measurement.width).toBeGreaterThanOrEqual(64);
        expect(measurement.height).toBeGreaterThanOrEqual(64);
        expect(measurement.backingWidth).toBe(Math.round(measurement.width * measurement.rendererPixelRatio));
        expect(measurement.backingHeight).toBe(Math.round(measurement.height * measurement.rendererPixelRatio));
        expect(measurement.completeRing).toBe(true);
        expect(
          measurement.rightOwnedEdgePresent,
          `${cellSize}px cells at ${deviceScaleFactor}x device scale: ${JSON.stringify(measurement)}`,
        ).toBe(true);
        expect(
          measurement.rightOwnedEdgePixels,
          `${cellSize}px cells at ${deviceScaleFactor}x device scale: ${JSON.stringify(measurement)}`,
        ).toBe(true);
        expect(
          measurement.bottomOwnedEdgePixels,
          `${cellSize}px cells at ${deviceScaleFactor}x device scale: ${JSON.stringify(measurement)}`,
        ).toBe(true);
        expect(
          measurement.bottomOwnedEdgePresent,
          `${cellSize}px cells at ${deviceScaleFactor}x device scale: ${JSON.stringify(measurement)}`,
        ).toBe(true);
        if (measurement.ringWidth >= 64 && measurement.ringHeight >= 64) {
          expect(measurement.edgeSlack).toBeLessThan(
            measurement.ownedEdgeExtension + 1 / measurement.rendererPixelRatio + 0.01,
          );
        }
        expect(measurement.targetAlignmentError).toBeLessThan(0.001);
        expect(measurement.viewBoxAlignmentError).toBeLessThan(0.001);
        expect(measurement.targetClipMatches).toBe(true);
        expect(measurement.targetPaint.clipPath).toContain("touch-preview-target-clip");
        expect(measurement.targetPaint.strokeWidth).toBe("4px");
        expect(measurement.targetPaint.clipFill).toBe("rgb(0, 0, 0)");
        expect(measurement.targetPaint.clipStroke).toBe("none");
        expect(measurement.labelOverlap).toBe(0);
        expect(measurement.actionBelow).toBe(true);
        expect(measurement.paint).toEqual({
          overflow: "visible",
          borderRadius: "0px",
          borderWidth: "0px",
          outlineWidth: "0px",
          boxShadow: measurement.paint.boxShadow,
        });
        expect(measurement.paint.boxShadow).not.toBe("none");
        expect(measurement.paint.boxShadow).not.toContain("inset");
        expect(measurement.framebufferMatches).toBe(true);
        expect(measurement.captureMs, `${cellSize}px cells at ${deviceScaleFactor}x device scale`).toBeLessThan(35);
        matrix.push({
          topology,
          deviceScaleFactor,
          rendererPixelRatio: measurement.rendererPixelRatio,
          cellSize: measurement.cellSize,
          width: measurement.width,
          height: measurement.height,
          edgeSlack: measurement.edgeSlack,
          ownedEdgeExtension: measurement.ownedEdgeExtension,
          rightOwnedEdgePresent: measurement.rightOwnedEdgePresent,
          bottomOwnedEdgePresent: measurement.bottomOwnedEdgePresent,
          rightOwnedEdgePixels: measurement.rightOwnedEdgePixels,
          bottomOwnedEdgePixels: measurement.bottomOwnedEdgePixels,
          targetAlignmentError: measurement.targetAlignmentError,
          viewBoxAlignmentError: measurement.viewBoxAlignmentError,
          labelOverlap: measurement.labelOverlap,
          captureMs: measurement.captureMs,
        });
        await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        await expect(page.locator("#touch-preview")).toBeHidden();
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await session.detach();
      await context.close();
    }
  }
  console.log("TOUCH_PREVIEW_MATRIX", JSON.stringify(matrix));
});
