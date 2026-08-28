import { expect, test } from "@playwright/test";
import { CellState } from "../../src/model";
import { openDeterministicGame, worldPoint } from "./helpers";

const waitForNextFrame = async (page: import("@playwright/test").Page, previous: number): Promise<void> => {
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBeGreaterThan(previous);
};

test("R37 — Square is default and topology selection drives exact gameplay, geometry, hover, and pixel LOD", async ({
  page,
}) => {
  await openDeterministicGame(page, 0x71a9_0025);
  expect(await page.evaluate(() => window.__infiniteMines.model.topologyId)).toBe("square");
  await expect(page.locator("#topology-pill")).toHaveText("SQUARE");

  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator("#topology-options button")).toHaveCount(3);
  await expect(page.getByRole("button", { name: /Square/ })).toHaveAttribute("aria-pressed", "true");
  const squareField = await page.evaluate(() => ({
    seed: window.__infiniteMines.model.seed,
    generation: window.__infiniteMines.model.store.generation,
  }));
  await page.getByRole("button", { name: /Square/ }).click();
  expect(
    await page.evaluate(() => ({
      seed: window.__infiniteMines.model.seed,
      generation: window.__infiniteMines.model.store.generation,
    })),
  ).toEqual(squareField);
  await page.getByRole("button", { name: /Triangular/ }).click();
  await expect(page.locator("#topology-pill")).toHaveText("TRIANGULAR");

  const triangular = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const topology = api.model.topology;
    const neighbors: Array<{ x: number; y: number }> = [];
    topology.forEachNeighbor(0, 0, (x, y) => neighbors.push({ x, y }));
    const hitTests = [
      { x: 0, y: 0 },
      { x: -7, y: 4 },
      { x: 12, y: -9 },
    ].map((cell) => {
      const center = topology.geometry(cell.x, cell.y).center;
      return topology.hitTest(center.x, center.y);
    });
    return {
      topology: api.model.topologyId,
      neighbors,
      hitTests,
      originState: api.model.getState(0, 0),
      diagnostics: api.diagnostics(),
    };
  });
  expect(triangular.topology).toBe("triangular");
  expect(triangular.neighbors).toHaveLength(12);
  expect(new Set(triangular.neighbors.map((cell) => `${cell.x},${cell.y}`)).size).toBe(12);
  expect(triangular.hitTests).toEqual([
    { x: 0, y: 0 },
    { x: -7, y: 4 },
    { x: 12, y: -9 },
  ]);
  expect(triangular.originState).not.toBe(CellState.Covered);
  expect(triangular.diagnostics.drawCalls).toBe(1);
  expect(triangular.diagnostics.cachedTiles).toBe(0);

  const beforeTriangleFrame = triangular.diagnostics.frameCount;
  await page.evaluate((opened12) => {
    const api = window.__infiniteMines;
    api.model.store.clear();
    api.model.store.set(0, 0, opened12);
    api.renderer.home();
  }, CellState.Opened12);
  await waitForNextFrame(page, beforeTriangleFrame);
  const trianglePoint = await worldPoint(page, { x: 0, y: 0 });
  await page.mouse.move(trianglePoint.x, trianglePoint.y);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible")).toHaveCount(13);
  expect(await page.locator("#hover-overlay .hover-cell.is-visible").first().evaluate((node) => (node as HTMLElement).style.clipPath)).toContain(
    "polygon",
  );

  const trianglePixels = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const polygon = api.renderer.cellScreenPolygon(0, 0);
    const center = {
      x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
      y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
    };
    const minX = Math.min(...polygon.map((point) => point.x));
    const minY = Math.min(...polygon.map((point) => point.y));
    const gl = api.renderer.gl;
    const read = (x: number, y: number): number[] => {
      const pixel = new Uint8Array(4);
      const dpr = api.renderer.diagnostics.pixelRatio;
      gl.readPixels(
        Math.max(0, Math.min(api.renderer.canvas.width - 1, Math.round(x * dpr))),
        Math.max(0, Math.min(api.renderer.canvas.height - 1, api.renderer.canvas.height - 1 - Math.round(y * dpr))),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      return [...pixel];
    };
    return { center: read(center.x, center.y), outside: read(minX + 1, minY + 1) };
  });
  expect(trianglePixels.center).not.toEqual(trianglePixels.outside);

  const beforePixelFrame = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
  await page.evaluate(() => window.__infiniteMines.renderer.restoreView({ version: 1, zoom: 0.04, panX: 0, panY: 0 }));
  await waitForNextFrame(page, beforePixelFrame);
  const trianglePixelLod = await page.evaluate(() => window.__infiniteMines.diagnostics());
  expect(trianglePixelLod).toMatchObject({ topology: "triangular", lod: "pixel", cellSize: 1, drawCalls: 1, glyphs: false });
  expect(trianglePixelLod.visibleCells).toBeGreaterThan(1_000_000);
  expect(trianglePixelLod.frameMs).toBeLessThan(35);

  await page.getByRole("button", { name: "Game settings" }).click();
  await page.getByRole("button", { name: /Rhombille/ }).click();
  const rhombille = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const neighbors: Array<{ x: number; y: number }> = [];
    api.model.topology.forEachNeighbor(0, 0, (x, y) => neighbors.push({ x, y }));
    return { topology: api.model.topologyId, neighbors, diagnostics: api.diagnostics() };
  });
  expect(rhombille.topology).toBe("rhombille");
  expect(rhombille.neighbors).toHaveLength(10);
  expect(rhombille.diagnostics.drawCalls).toBe(1);

  const beforeRhombilleFrame = rhombille.diagnostics.frameCount;
  await page.evaluate((opened10) => {
    const api = window.__infiniteMines;
    api.model.store.clear();
    api.model.store.set(0, 0, opened10);
    api.renderer.home();
  }, CellState.Opened10);
  await waitForNextFrame(page, beforeRhombilleFrame);
  const rhombillePoint = await worldPoint(page, { x: 0, y: 0 });
  await page.mouse.move(rhombillePoint.x, rhombillePoint.y);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible")).toHaveCount(11);

  await page.evaluate(() => window.__infiniteMines.flushSave());
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.model.topologyId)).toBe("rhombille");
  await expect(page.locator("#topology-pill")).toHaveText("RHOMBILLE");
});

test("R37 — v1 saved fields migrate to Square and v2 topology damage matches a full redraw", async ({ page }) => {
  await openDeterministicGame(page, 0x51a7_10a0);
  await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const model = api.model.createSnapshot();
    const legacyModel = { ...model, version: 1 } as Record<string, unknown>;
    delete legacyModel.topology;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infinite-mines", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("sessions", "readwrite");
      transaction.objectStore("sessions").put(
        { version: 1, savedAt: Date.now(), model: legacyModel, view: api.renderer.createViewSnapshot() },
        "active",
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.model.topologyId)).toBe("square");

  await page.evaluate(() => window.__infiniteMines.newGame("master", "rhombille"));
  const beforePrepared = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
  await page.evaluate((opened) => {
    const api = window.__infiniteMines;
    api.model.store.clear();
    api.model.store.set(0, 0, opened);
    api.renderer.requestRender();
  }, CellState.Opened);
  await waitForNextFrame(page, beforePrepared);
  const before = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
  const partial = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const neighbor = api.model.topology.edgeNeighbors(0, 0)[0];
    const result = api.model.cycleMark(neighbor.x, neighbor.y);
    api.renderer.requestRender(result.damage ?? undefined);
    return result;
  });
  expect(partial.changed).toBe(1);
  await waitForNextFrame(page, before);
  const partialResult = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const gl = api.renderer.gl;
    const pixels = new Uint8Array(api.renderer.canvas.width * api.renderer.canvas.height * 4);
    gl.readPixels(0, 0, api.renderer.canvas.width, api.renderer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let hash = 2166136261;
    for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return { hash, diagnostics: api.diagnostics() };
  });
  expect(partialResult.diagnostics.redrawMode).toBe("damage");
  expect(partialResult.diagnostics.redrawnPixels).toBeLessThan(partialResult.diagnostics.canvasPixels * 0.4);

  const beforeFull = partialResult.diagnostics.frameCount;
  await page.evaluate(() => window.__infiniteMines.renderer.requestRender());
  await waitForNextFrame(page, beforeFull);
  const fullHash = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const gl = api.renderer.gl;
    const pixels = new Uint8Array(api.renderer.canvas.width * api.renderer.canvas.height * 4);
    gl.readPixels(0, 0, api.renderer.canvas.width, api.renderer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let hash = 2166136261;
    for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
  });
  expect(fullHash).toBe(partialResult.hash);
});

test("R37 — dense Triangular and Rhombille fields retain one-draw, no-upload camera movement", async ({ page }) => {
  test.setTimeout(45_000);
  await openDeterministicGame(page, 0x7e11_1a95);
  for (const topology of ["triangular", "rhombille"] as const) {
    await page.evaluate(({ topologyId, opened1 }) => {
      const api = window.__infiniteMines;
      api.newGame("master", topologyId);
      api.model.store.clear();
      for (let y = -64; y < 64; y += 1) {
        for (let x = -128; x < 128; x += 1) api.model.store.set(x, y, opened1);
      }
      api.renderer.restoreView({ version: 1, zoom: 0.08, panX: 0, panY: 0 });
    }, { topologyId: topology, opened1: CellState.Opened1 });
    await expect
      .poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().drawnCells))
      .toBe(32_768);

    const report = await page.evaluate(async () => {
      const api = window.__infiniteMines;
      const before = api.diagnostics();
      const intervals: number[] = [];
      const renderTimes: number[] = [];
      let previousTime = 0;
      let previousFrame = before.frameCount;
      await new Promise<void>((resolve) => {
        let frame = 0;
        const step = (time: number) => {
          if (previousTime !== 0) intervals.push(time - previousTime);
          previousTime = time;
          const diagnostics = api.diagnostics();
          if (diagnostics.frameCount !== previousFrame) {
            renderTimes.push(diagnostics.frameMs);
            previousFrame = diagnostics.frameCount;
          }
          api.renderer.panBy(frame % 2 === 0 ? 1 : -1, 0);
          frame += 1;
          if (frame < 30) requestAnimationFrame(step);
          else requestAnimationFrame(() => resolve());
        };
        requestAnimationFrame(step);
      });
      const after = api.diagnostics();
      const percentile = (values: number[], fraction: number) => {
        const sorted = [...values].sort((left, right) => left - right);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
      };
      return {
        before,
        after,
        intervalP95: percentile(intervals, 0.95),
        renderP95: percentile(renderTimes, 0.95),
      };
    });
    expect(report.before).toMatchObject({ topology, lod: "pixel", drawCalls: 1, drawnCells: 32_768 });
    expect(report.after.instanceUploads - report.before.instanceUploads).toBe(0);
    expect(report.after.drawCalls).toBe(1);
    expect(report.intervalP95).toBeGreaterThan(0);
    expect(report.renderP95).toBeLessThan(35);
  }
});
