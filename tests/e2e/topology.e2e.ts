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
  expect(await page.locator("#topology-options button b").allTextContents()).toEqual([
    "Square",
    "Rhombille",
    "Triangular",
  ]);
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
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.topologyId)).toBe("rhombille");
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

test("R48 — boundary lines continue one edge-neighbor cell into covered fog", async ({ page }) => {
  await openDeterministicGame(page, 0xf09b_0048);

  for (const topology of ["square", "triangular", "rhombille"] as const) {
    const previousFrame = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
    await page.evaluate(
      ({ topologyId, opened }) => {
        const api = window.__infiniteMines;
        api.newGame("beginner", topologyId);
        api.model.store.clear();
        api.model.store.set(0, 0, opened);
        api.renderer.home();
      },
      { topologyId: topology, opened: CellState.Opened1 },
    );
    await waitForNextFrame(page, previousFrame);

    const detail = await page.evaluate(() => {
      const api = window.__infiniteMines;
      const canvas = api.renderer.canvas;
      const gl = api.renderer.gl;
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const styles = getComputedStyle(document.documentElement);
      const parseHex = (value: string) => [
        Number.parseInt(value.slice(1, 3), 16),
        Number.parseInt(value.slice(3, 5), 16),
        Number.parseInt(value.slice(5, 7), 16),
      ];
      const background = parseHex(styles.getPropertyValue("--board-bg").trim());
      const border = parseHex(styles.getPropertyValue("--board-cell-border").trim());
      const distance = (pixel: Uint8Array, expected: number[]) =>
        Math.hypot(pixel[0] - expected[0], pixel[1] - expected[1], pixel[2] - expected[2]);
      const readCssPixel = (x: number, y: number) => {
        const pixel = new Uint8Array(4);
        gl.readPixels(
          Math.floor(x * dpr),
          canvas.height - 1 - Math.floor(y * dpr),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixel,
        );
        return pixel;
      };
      const neighbors = api.model.topology.edgeNeighbors(0, 0);
      const sourcePolygon = api.renderer.cellScreenPolygon(0, 0);
      const samePoint = (left: { x: number; y: number }, right: { x: number; y: number }) =>
        Math.hypot(left.x - right.x, left.y - right.y) < 0.01;
      const hasLineNear = (x: number, y: number) => {
        for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
          for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
            if (distance(readCssPixel(x + offsetX / dpr, y + offsetY / dpr), background) > 10) return true;
          }
        }
        return false;
      };
      gl.finish();
      const samples = neighbors.map((cell) => {
        const polygon = api.renderer.cellScreenPolygon(cell.x, cell.y);
        const center = {
          x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
          y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
        };
        const left = Math.floor(Math.min(...polygon.map((point) => point.x)) * dpr);
        const right = Math.ceil(Math.max(...polygon.map((point) => point.x)) * dpr);
        const top = Math.floor(Math.min(...polygon.map((point) => point.y)) * dpr);
        const bottom = Math.ceil(Math.max(...polygon.map((point) => point.y)) * dpr);
        const pixels = new Uint8Array(Math.max(1, right - left) * Math.max(1, bottom - top) * 4);
        gl.readPixels(
          left,
          canvas.height - bottom,
          Math.max(1, right - left),
          Math.max(1, bottom - top),
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        let borderPixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (distance(pixels.subarray(offset, offset + 4), border) < 35) borderPixels += 1;
        }
        const sharedEdge = polygon.findIndex((point, index) => {
          const next = polygon[(index + 1) % polygon.length];
          return (
            sourcePolygon.some((source) => samePoint(source, point)) &&
            sourcePolygon.some((source) => samePoint(source, next))
          );
        });
        const paintedEdges = polygon.map((point, index) => {
          const next = polygon[(index + 1) % polygon.length];
          return hasLineNear((point.x + next.x) / 2, (point.y + next.y) / 2);
        });
        const expectedPainted = paintedEdges.map(
          (_painted, index) =>
            index === sharedEdge ||
            index === (sharedEdge + polygon.length - 1) % polygon.length ||
            index === (sharedEdge + 1) % polygon.length,
        );
        return {
          state: api.model.getState(cell.x, cell.y),
          centerIsFog: distance(readCssPixel(center.x, center.y), background) < 3,
          borderPixels,
          sharedEdge,
          paintedEdges,
          expectedPainted,
        };
      });
      return { diagnostics: api.diagnostics(), neighborCount: neighbors.length, samples };
    });

    expect(detail.diagnostics.lod).toBe("detail");
    expect(detail.diagnostics.frontierCells).toBe(detail.neighborCount);
    expect(detail.diagnostics.frontierEdges).toBe(detail.neighborCount * 3);
    expect(detail.diagnostics.drawnCells).toBe(detail.neighborCount + 1);
    expect(detail.samples.every((sample) => sample.state === CellState.Covered)).toBe(true);
    expect(detail.samples.every((sample) => sample.centerIsFog)).toBe(true);
    expect(detail.samples.every((sample) => sample.borderPixels > 0)).toBe(true);
    expect(detail.samples.every((sample) => sample.sharedEdge >= 0)).toBe(true);
    expect(
      detail.samples.every((sample) =>
        sample.paintedEdges.every((painted, index) => painted === sample.expectedPainted[index]),
      ),
      JSON.stringify({ topology, samples: detail.samples }),
    ).toBe(true);

    if (topology === "square") {
      const beforeMarkFrame = detail.diagnostics.frameCount;
      await page.evaluate((flagged) => {
        const api = window.__infiniteMines;
        api.model.store.set(10, 0, flagged);
        api.renderer.requestRender({ minX: 10, minY: 0, maxX: 10, maxY: 0 });
      }, CellState.Flagged);
      await waitForNextFrame(page, beforeMarkFrame);
      expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frontierCells)).toBe(4);
      const beforeClearFrame = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
      await page.evaluate(() => {
        const api = window.__infiniteMines;
        api.model.store.set(10, 0, 0);
        api.renderer.requestRender({ minX: 10, minY: 0, maxX: 10, maxY: 0 });
      });
      await waitForNextFrame(page, beforeClearFrame);
    }

    const beforePixelFrame = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
    await page.evaluate(() => {
      window.__infiniteMines.renderer.restoreView({ version: 1, zoom: 0.04, panX: 0, panY: 0 });
    });
    await waitForNextFrame(page, beforePixelFrame);
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics())).toMatchObject({
      lod: "pixel",
      borderCssPixels: 0,
      drawnCells: 1,
      frontierCells: 0,
      frontierEdges: 0,
    });
  }

  const beforeSeamFrame = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
  await page.evaluate((opened) => {
    const api = window.__infiniteMines;
    api.newGame("beginner", "square");
    api.model.store.clear();
    api.model.store.set(63, 0, opened);
    api.renderer.restoreView({ version: 1, zoom: 1, panX: -63 * 25, panY: 0 });
  }, CellState.Opened1);
  await waitForNextFrame(page, beforeSeamFrame);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frontierCells)).toBe(4);

  const beforeAdvanceFrame = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
  await page.evaluate((opened) => {
    const api = window.__infiniteMines;
    api.model.store.set(64, 0, opened);
    api.renderer.requestRender({ minX: 64, minY: 0, maxX: 64, maxY: 0 });
  }, CellState.Opened1);
  await waitForNextFrame(page, beforeAdvanceFrame);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frontierCells)).toBe(6);

  const beforeRetractionFrame = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
  await page.evaluate(() => {
    const api = window.__infiniteMines;
    api.model.store.set(64, 0, 0);
    api.renderer.requestRender({ minX: 64, minY: 0, maxX: 64, maxY: 0 });
  });
  await waitForNextFrame(page, beforeRetractionFrame);
  const partial = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const pixels = new Uint8Array(api.renderer.canvas.width * api.renderer.canvas.height * 4);
    api.renderer.gl.readPixels(
      0,
      0,
      api.renderer.canvas.width,
      api.renderer.canvas.height,
      api.renderer.gl.RGBA,
      api.renderer.gl.UNSIGNED_BYTE,
      pixels,
    );
    let hash = 2166136261;
    for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return { hash, diagnostics: api.diagnostics() };
  });
  expect(partial.diagnostics.frontierCells).toBe(4);
  expect(partial.diagnostics.redrawMode).toBe("damage");

  const beforeFullFrame = partial.diagnostics.frameCount;
  await page.evaluate(() => window.__infiniteMines.renderer.requestRender());
  await waitForNextFrame(page, beforeFullFrame);
  expect(
    await page.evaluate(() => {
      const api = window.__infiniteMines;
      const pixels = new Uint8Array(api.renderer.canvas.width * api.renderer.canvas.height * 4);
      api.renderer.gl.readPixels(
        0,
        0,
        api.renderer.canvas.width,
        api.renderer.canvas.height,
        api.renderer.gl.RGBA,
        api.renderer.gl.UNSIGNED_BYTE,
        pixels,
      );
      let hash = 2166136261;
      for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      return hash;
    }),
  ).toBe(partial.hash);
});

test("R37 — v1 saved fields migrate to Square and v2 topology damage matches a full redraw", async ({ page }) => {
  await openDeterministicGame(page, 0x51a7_10a0);
  await page.evaluate(async () => {
    const api = window.__infiniteMines;
    api.model.reset("beginner", 0x51a7_10a0, true, "square", 0.18);
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
      const store = transaction.objectStore("sessions");
      store.clear();
      store.put(
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
  expect(
    await page.evaluate(
      () =>
        new Promise<IDBValidKey[]>((resolve, reject) => {
          const open = indexedDB.open("infinite-mines", 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const keys = open.result.transaction("sessions").objectStore("sessions").getAllKeys();
            keys.onerror = () => reject(keys.error);
            keys.onsuccess = () => resolve(keys.result);
          };
        }),
    ),
  ).toEqual(expect.arrayContaining(["active-slot", "field:square:beginner"]));

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

test("R38 — every topology tessellates without background cracks and Rhombille content stays upright", async ({
  page,
}) => {
  await openDeterministicGame(page, 0x5ea1_5afe);
  for (const topology of ["square", "triangular", "rhombille"] as const) {
    const previousFrame = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
    await page.evaluate(
      ({ topologyId, opened }) => {
        const api = window.__infiniteMines;
        api.model.reset("master", 0x5ea1_5afe, false, topologyId);
        api.model.store.clear();
        const bounds =
          topologyId === "square"
            ? { minX: -40, maxX: 40, minY: -28, maxY: 28 }
            : topologyId === "triangular"
              ? { minX: -90, maxX: 90, minY: -35, maxY: 35 }
              : { minX: -100, maxX: 100, minY: -32, maxY: 32 };
        for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
          for (let x = bounds.minX; x <= bounds.maxX; x += 1) api.model.store.set(x, y, opened);
        }
        api.renderer.restoreView({ version: 1, zoom: 1.7, panX: 0.37, panY: 0.61 });
      },
      { topologyId: topology, opened: CellState.Opened },
    );
    await waitForNextFrame(page, previousFrame);
    const coverage = await page.evaluate(() => {
      const api = window.__infiniteMines;
      const gl = api.renderer.gl;
      const { width, height } = api.renderer.canvas;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const background = api
        .diagnostics()
        .backgroundColor.slice(1)
        .match(/.{2}/g)!
        .map((channel) => Number.parseInt(channel, 16));
      const dpr = api.renderer.diagnostics.pixelRatio;
      const sampleWidth = Math.round(320 * dpr);
      const sampleHeight = Math.round(240 * dpr);
      const startX = Math.round((width - sampleWidth) / 2);
      const startY = Math.round((height - sampleHeight) / 2);
      let backgroundPixels = 0;
      for (let y = startY; y < startY + sampleHeight; y += 1) {
        for (let x = startX; x < startX + sampleWidth; x += 1) {
          const pixel = (y * width + x) * 4;
          if (
            pixels[pixel] === background[0] &&
            pixels[pixel + 1] === background[1] &&
            pixels[pixel + 2] === background[2]
          ) {
            backgroundPixels += 1;
          }
        }
      }
      return { backgroundPixels, sampledPixels: sampleWidth * sampleHeight };
    });
    expect(coverage.backgroundPixels, `${topology} background cracks`).toBe(0);
  }

  const glyphMoments: Array<{ count: number; varianceX: number; varianceY: number }> = [];
  for (const x of [0, 1, 2]) {
    const previousFrame = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
    await page.evaluate(
      ({ cellX, opened1 }) => {
        const api = window.__infiniteMines;
        api.model.reset("master", 0x5ea1_5afe, false, "rhombille");
        api.model.store.clear();
        api.model.store.set(cellX, 0, opened1);
        api.renderer.restoreView({ version: 1, zoom: 2, panX: 0.37, panY: 0.61 });
      },
      { cellX: x, opened1: CellState.Opened1 },
    );
    await waitForNextFrame(page, previousFrame);
    glyphMoments.push(
      await page.evaluate((cellX) => {
        const api = window.__infiniteMines;
        const gl = api.renderer.gl;
        const { width, height } = api.renderer.canvas;
        const dpr = api.renderer.diagnostics.pixelRatio;
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const polygon = api.renderer.cellScreenPolygon(cellX, 0);
        const minX = Math.floor(Math.min(...polygon.map((point) => point.x)) * dpr);
        const maxX = Math.ceil(Math.max(...polygon.map((point) => point.x)) * dpr);
        const minY = Math.floor(Math.min(...polygon.map((point) => point.y)) * dpr);
        const maxY = Math.ceil(Math.max(...polygon.map((point) => point.y)) * dpr);
        const points: Array<[number, number]> = [];
        for (let screenY = minY; screenY <= maxY; screenY += 1) {
          for (let screenX = minX; screenX <= maxX; screenX += 1) {
            const glY = height - 1 - screenY;
            if (screenX < 0 || screenX >= width || glY < 0 || glY >= height) continue;
            const pixel = (glY * width + screenX) * 4;
            const red = pixels[pixel];
            const green = pixels[pixel + 1];
            const blue = pixels[pixel + 2];
            if (blue > red + 35 && blue > green + 20) points.push([screenX / dpr, screenY / dpr]);
          }
        }
        const meanX = points.reduce((sum, point) => sum + point[0], 0) / points.length;
        const meanY = points.reduce((sum, point) => sum + point[1], 0) / points.length;
        return {
          count: points.length,
          varianceX: points.reduce((sum, point) => sum + (point[0] - meanX) ** 2, 0) / points.length,
          varianceY: points.reduce((sum, point) => sum + (point[1] - meanY) ** 2, 0) / points.length,
        };
      }, x),
    );
  }
  for (const moments of glyphMoments) {
    expect(moments.count).toBeGreaterThan(25);
    expect(moments.varianceY / moments.varianceX).toBeGreaterThan(1.4);
  }
});

test("R39 — non-square hover separates hint neighborhoods from click effects without WebGL work", async ({
  page,
}) => {
  await openDeterministicGame(page, 0x417e_c7ed);
  for (const topology of ["rhombille", "triangular"] as const) {
    const frameBeforeReset = await page.evaluate((topologyId) => {
      const api = window.__infiniteMines;
      const frameCount = api.diagnostics().frameCount;
      api.model.reset("master", 0x417e_c7ed, false, topologyId);
      api.renderer.home();
      return frameCount;
    }, topology);
    await waitForNextFrame(page, frameBeforeReset);
    const center = await worldPoint(page, { x: 0, y: 0 });
    const frameBeforeHover = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
    await page.mouse.move(center.x + 40, center.y);
    await page.mouse.move(center.x, center.y);
    const expectedCells = topology === "triangular" ? 13 : 11;
    await expect(page.locator("#hover-overlay .hover-cell.is-visible")).toHaveCount(expectedCells);
    await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-hint")).toHaveCount(expectedCells - 1);
    await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-affected")).toHaveCount(1);
    const colors = await page.locator("#hover-overlay .hover-cell.is-visible").evaluateAll((markers) => ({
      affected: getComputedStyle(markers.find((marker) => marker.classList.contains("is-affected"))!).backgroundColor,
      hint: getComputedStyle(markers.find((marker) => marker.classList.contains("is-hint"))!).backgroundColor,
    }));
    expect(colors.hint).not.toBe(colors.affected);
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBe(frameBeforeHover);

    const revealedNeighbors = await page.evaluate(
      ({ opened1, opened2, exploded }) => {
        const api = window.__infiniteMines;
        const neighbors: Array<{ x: number; y: number }> = [];
        api.model.topology.forEachNeighbor(0, 0, (x, y) => neighbors.push({ x, y }));
        api.model.store.set(neighbors[0].x, neighbors[0].y, opened1);
        api.model.store.set(neighbors[1].x, neighbors[1].y, opened2);
        api.model.store.set(neighbors[2].x, neighbors[2].y, exploded);
        return neighbors.slice(0, 3);
      },
      { opened1: CellState.Opened1, opened2: CellState.Opened2, exploded: CellState.Exploded },
    );
    await page.mouse.move(center.x + 40, center.y);
    await page.mouse.move(center.x, center.y);
    await expect(page.locator("#hover-overlay .hover-cell.is-visible")).toHaveCount(expectedCells - 3);
    await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-hint")).toHaveCount(expectedCells - 4);
    for (const revealed of revealedNeighbors) {
      await expect(
        page.locator(`#hover-overlay .hover-cell.is-visible[data-x="${revealed.x}"][data-y="${revealed.y}"]`),
      ).toHaveCount(0);
    }
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBe(frameBeforeHover);

    await page.getByRole("button", { name: "Hide controls" }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-hint")).toHaveCount(expectedCells - 4);
    await page.getByRole("button", { name: "Show controls" }).evaluate((button: HTMLButtonElement) => button.click());
  }
});

test("R41 — hint-neighborhood hover can be disabled independently and persists", async ({ page }) => {
  await openDeterministicGame(page, 0x41a1_0ff0);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().hintHoverMode)).toBe("show");
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-hint-hover"))).toBeNull();

  const frameBeforeTopology = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const frameCount = api.diagnostics().frameCount;
    api.model.reset("master", 0x41a1_0ff0, false, "triangular");
    api.renderer.home();
    return frameCount;
  });
  await waitForNextFrame(page, frameBeforeTopology);
  const center = await worldPoint(page, { x: 0, y: 0 });
  await page.mouse.move(center.x, center.y);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-hint")).toHaveCount(12);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-affected")).toHaveCount(1);

  const frameBeforeSetting = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator('#hint-hover-options button[data-hint-hover="show"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#hint-hover-options").getByRole("button", { name: /^Hide/ }).click();
  await expect(page.locator('#hint-hover-options button[data-hint-hover="hide"]')).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-hint-hover"))).toBe("hide");
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().hintHoverMode)).toBe("hide");
  await page.locator("#settings-dialog").getByRole("button", { name: "Close" }).click();
  await page.mouse.move(center.x, center.y);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-hint")).toHaveCount(0);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-affected")).toHaveCount(1);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBe(frameBeforeSetting);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().hintHoverMode)).toBe("hide");
  const frameBeforeRestoredTopology = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const frameCount = api.diagnostics().frameCount;
    api.model.reset("master", 0x41a1_0ff0, false, "triangular");
    api.renderer.home();
    return frameCount;
  });
  await waitForNextFrame(page, frameBeforeRestoredTopology);
  const restoredCenter = await worldPoint(page, { x: 0, y: 0 });
  await page.mouse.move(restoredCenter.x, restoredCenter.y);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-hint")).toHaveCount(0);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-affected")).toHaveCount(1);

  await page.getByRole("button", { name: "Game settings" }).click();
  await page.locator("#hint-hover-options").getByRole("button", { name: /^Show/ }).click();
  await page.locator("#settings-dialog").getByRole("button", { name: "Close" }).click();
  await page.mouse.move(restoredCenter.x, restoredCenter.y);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-hint")).toHaveCount(12);
  await expect(page.locator("#hover-overlay .hover-cell.is-visible.is-affected")).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-hint-hover"))).toBe("show");
});
