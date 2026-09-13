import { expect, test } from "@playwright/test";
import { findCell, openDeterministicGame, worldPoint } from "./helpers";

test("R49 — Thing art defaults to Simple and keeps separate persisted fields per style", async ({ page }) => {
  await openDeterministicGame(page, 0x49a7_0001);

  expect(await page.evaluate(() => window.__infiniteMines.diagnostics())).toMatchObject({
    thingStyle: "simple",
    fieldGeneration: "original-things",
    thingSprites: 0,
    thingTexturePixels: 0,
    thingSpritesReady: false,
  });
  expect(await page.locator('[data-thing-style="simple"]').getAttribute("aria-pressed")).toBe("true");
  expect(
    await page.evaluate(() => ({
      atlasAllocated: Boolean(
        (window.__infiniteMines.renderer as unknown as { thingEmojiAtlas: HTMLCanvasElement | null }).thingEmojiAtlas,
      ),
      svgRequests: performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("emoji_u"))
        .length,
    })),
  ).toEqual({ atlasAllocated: false, svgRequests: 0 });
  expect(
    await page.evaluate(() => {
      const model = window.__infiniteMines.model;
      for (let y = -24; y < 48; y += 1) {
        for (let x = -24; x < 48; x += 1) {
          if (model.artifactAt(x, y)) return model.thingVisualAt(x, y);
        }
      }
      throw new Error("No Simple Thing found");
    }),
  ).toBeNull();

  await page.evaluate(async () => {
    const api = window.__infiniteMines;
    api.model.store.set(120, 120, 10);
    await api.flushSave();
  });
  await page.locator("#settings-button").click();
  await page.locator('[data-thing-style="illustrated"]').click();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().thingStyle)).toBe("illustrated");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().thingSpritesReady)).toBe(true);
  expect(await page.evaluate(() => window.__infiniteMines.model.fieldGeneration)).toBe("illustrated-things-v3");
  expect(await page.evaluate(() => window.__infiniteMines.model.getState(120, 120))).toBe(0);
  await page.evaluate(async () => {
    const api = window.__infiniteMines;
    api.model.store.set(121, 121, 11);
    await api.flushSave();
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics())).toMatchObject({
    thingStyle: "illustrated",
    fieldGeneration: "illustrated-things-v3",
  });
  expect(await page.evaluate(() => window.__infiniteMines.model.getState(121, 121))).toBe(11);

  await page.evaluate(() => window.__infiniteMines.setThingStyle("simple"));
  await expect
    .poll(() => page.evaluate(() => window.__infiniteMines.diagnostics()))
    .toMatchObject({
      thingStyle: "simple",
      fieldGeneration: "original-things",
      thingSprites: 0,
      thingTexturePixels: 0,
      thingSpritesReady: false,
    });
  expect(await page.evaluate(() => window.__infiniteMines.model.getState(120, 120))).toBe(10);
  expect(await page.evaluate(() => window.__infiniteMines.model.getState(121, 121))).toBe(0);

  await page.evaluate(() => window.__infiniteMines.setThingStyle("illustrated"));
  expect(await page.evaluate(() => window.__infiniteMines.model.getState(120, 120))).toBe(0);
  expect(await page.evaluate(() => window.__infiniteMines.model.getState(121, 121))).toBe(11);

  const priorIllustrated = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    api.model.reset("beginner", 0x49a7_0002, false, "square", undefined, "illustrated-things");
    api.renderer.syncThingStyle();
    let visual: ReturnType<typeof api.model.thingVisualAt> = null;
    for (let y = 0; y < 24 && !visual; y += 1) {
      for (let x = 0; x < 24; x += 1) {
        if (!api.model.artifactAt(x, y)) continue;
        visual = api.model.thingVisualAt(x, y);
        break;
      }
    }
    if (!visual) throw new Error("No prior-generation Illustrated Thing found");
    await api.flushSave();
    return {
      generation: api.model.fieldGeneration,
      seed: api.model.seed,
      sprite: visual.sprite,
      reservation: visual.reservedCells.map((cell) => `${cell.x},${cell.y}`),
    };
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.model.fieldGeneration)).toBe("illustrated-things");
  expect(
    await page.evaluate(() => {
      const api = window.__infiniteMines;
      let visual: ReturnType<typeof api.model.thingVisualAt> = null;
      for (let y = 0; y < 24 && !visual; y += 1) {
        for (let x = 0; x < 24; x += 1) {
          if (!api.model.artifactAt(x, y)) continue;
          visual = api.model.thingVisualAt(x, y);
          break;
        }
      }
      if (!visual) throw new Error("No restored prior-generation Illustrated Thing found");
      return {
        generation: api.model.fieldGeneration,
        seed: api.model.seed,
        sprite: visual.sprite,
        reservation: visual.reservedCells.map((cell) => `${cell.x},${cell.y}`),
      };
    }),
  ).toEqual(priorIllustrated);

  await page.locator("#restart-button").click();
  expect(await page.evaluate(() => window.__infiniteMines.model.fieldGeneration)).toBe("illustrated-things-v3");
});

test("R49 — the full Thing catalog loads lazily into a bounded GPU atlas", async ({ page }) => {
  await openDeterministicGame(page, 0x49a7_0002);
  expect(
    await page.evaluate(() =>
      performance.getEntriesByType("resource").some((entry) => entry.name.includes("thing-catalog-full")),
    ),
  ).toBe(false);

  const result = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    await api.setThingStyle("illustrated");
    await api.renderer.waitForThingSprites();
    const initial = api.diagnostics();
    const extraSprites = [12, 1000, 3730, ...Array.from({ length: 50 }, (_, index) => index + 13)];
    for (const sprite of extraSprites) await api.renderer.waitForThingSprite(sprite);
    const privateModel = api.model as unknown as {
      artifactForZone(zoneX: number, zoneY: number): { x: number; y: number };
    };
    let nonCurated: ReturnType<typeof api.model.thingVisualAt> = null;
    search: for (let zoneY = -32; zoneY <= 32; zoneY += 1) {
      for (let zoneX = -32; zoneX <= 32; zoneX += 1) {
        const anchor = privateModel.artifactForZone(zoneX, zoneY);
        const visual = api.model.thingVisualAt(anchor.x, anchor.y);
        if (visual?.sprite !== 1000) continue;
        nonCurated = visual;
        break search;
      }
    }
    if (!nonCurated) throw new Error("The complete deck did not contain Thing 1000");
    const nonCuratedArtClues = nonCurated.artCells.map((cell) => api.model.clueAt(cell.x, cell.y));
    const nonCuratedNeighborReservations = nonCurated.artCells.flatMap((cell) => {
      const reservations: boolean[] = [];
      api.model.topology.forEachNeighbor(cell.x, cell.y, (x, y) => {
        reservations.push(api.model.thingFootprintAt(x, y));
      });
      return reservations;
    });
    api.reveal(nonCurated.x, nonCurated.y);
    const minX = Math.min(...nonCurated.cells.map((cell) => cell.x));
    const maxX = Math.max(...nonCurated.cells.map((cell) => cell.x));
    const minY = Math.min(...nonCurated.cells.map((cell) => cell.y));
    const maxY = Math.max(...nonCurated.cells.map((cell) => cell.y));
    api.renderer.restoreView({
      version: 1,
      zoom: 1,
      panX: -((minX + maxX) / 2 - api.model.topology.origin.x) * 25,
      panY: -((minY + maxY) / 2 - api.model.topology.origin.y) * 25,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const afterFill = api.diagnostics();
    const evictedCurated = Array.from({ length: 12 }, (_, sprite) => sprite).filter(
      (sprite) => api.renderer.thingAtlasSlotForSprite(sprite) === null,
    );
    if (evictedCurated.length === 0) throw new Error("Expected the bounded atlas to evict a curated slot");
    const requestedSlotsReady = [12, 1000, 3730, 62].map(
      (sprite) => api.renderer.thingAtlasSlotForSprite(sprite) !== null,
    );
    await api.renderer.waitForThingSprite(evictedCurated[0]);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const privateRenderer = api.renderer as unknown as {
      thingEmojiAtlas: HTMLCanvasElement;
      instanceCount: number;
      resources: { instanceBuffer: WebGLBuffer };
    };
    const loadedNonCuratedSlot = api.renderer.thingAtlasSlotForSprite(1000);
    if (loadedNonCuratedSlot === null) throw new Error("Thing 1000 was evicted before rendering");
    const gl = api.renderer.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, privateRenderer.resources.instanceBuffer);
    const instances = new Float32Array(privateRenderer.instanceCount * 5);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, instances);
    let renderedNonCuratedFragments = 0;
    for (let offset = 0; offset < instances.length; offset += 5) {
      if (instances[offset + 3] === 3 && Math.round(instances[offset + 2]) === loadedNonCuratedSlot) {
        renderedNonCuratedFragments += 1;
      }
    }
    return {
      initial,
      afterFill,
      afterReload: api.diagnostics(),
      requestedSlotsReady,
      reloadedSlot: api.renderer.thingAtlasSlotForSprite(evictedCurated[0]),
      renderedNonCuratedFragments,
      nonCuratedArtClues,
      nonCuratedNeighborReservations,
      atlas: {
        width: privateRenderer.thingEmojiAtlas.width,
        height: privateRenderer.thingEmojiAtlas.height,
      },
      catalogChunk: performance
        .getEntriesByType("resource")
        .some((entry) => entry.name.includes("thing-catalog-full")),
      svgRequests: new Set(
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => name.includes("/things/emoji_u") && name.endsWith(".svg")),
      ).size,
    };
  });

  expect(result.initial).toMatchObject({
    fieldGeneration: "illustrated-things-v3",
    thingSprites: 3731,
    thingSpritesLoaded: 12,
    thingSpritesReady: true,
  });
  expect(result.afterFill.thingSpritesLoaded).toBe(64);
  expect(result.afterReload).toMatchObject({ thingSprites: 3731, thingSpritesLoaded: 64, drawCalls: 1, canvasCount: 3 });
  expect(result.requestedSlotsReady).toEqual([true, true, true, true]);
  expect(result.reloadedSlot).not.toBeNull();
  expect(result.renderedNonCuratedFragments).toBeGreaterThan(0);
  expect(result.nonCuratedArtClues).toEqual(Array(result.nonCuratedArtClues.length).fill(0));
  expect(result.nonCuratedNeighborReservations).toEqual(Array(result.nonCuratedNeighborReservations.length).fill(true));
  expect(result.atlas).toEqual({ width: 4096, height: 4096 });
  expect(result.catalogChunk).toBe(true);
  expect(result.svgRequests).toBeGreaterThanOrEqual(65);
});

test("R49 — prior 12-scene Illustrated saves restore unchanged and restart into the full catalog", async ({ page }) => {
  await openDeterministicGame(page, 0x49a7_0003);
  await page.evaluate(async () => {
    const api = window.__infiniteMines;
    await api.setThingStyle("illustrated");
    api.model.reset("beginner", 0x49a7_0004, false, "rhombille", undefined, "illustrated-things-v2");
    api.model.store.set(321, -123, 11);
    api.renderer.syncThingStyle();
    await api.flushSave();
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("restored");
  expect(
    await page.evaluate(() => ({
      generation: window.__infiniteMines.model.fieldGeneration,
      seed: window.__infiniteMines.model.seed,
      state: window.__infiniteMines.model.getState(321, -123),
    })),
  ).toEqual({ generation: "illustrated-things-v2", seed: 0x49a7_0004, state: 11 });

  await page.locator("#restart-button").click();
  expect(await page.evaluate(() => window.__infiniteMines.model.fieldGeneration)).toBe("illustrated-things-v3");
});

test("R09 — refresh restores the exact field, progress, marks, and viewport from a compact snapshot", async ({ page }) => {
  await openDeterministicGame(page);
  const progress = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const model = api.model;
    let artifact: { x: number; y: number } | null = null;
    for (let y = 50; y < 200 && !artifact; y += 1) {
      for (let x = 50; x < 200; x += 1) {
        if (model.artifactAt(x, y) && model.clueAt(x, y) === 0 && model.getState(x, y) === 0) {
          artifact = { x, y };
          break;
        }
      }
    }
    if (!artifact) throw new Error("No artifact found");
    api.reveal(artifact.x, artifact.y);
    let mine: { x: number; y: number } | null = null;
    for (let y = 300; y < 400 && !mine; y += 1) {
      for (let x = 300; x < 400; x += 1) {
        if (model.mineAt(x, y) && model.getState(x, y) === 0) {
          mine = { x, y };
          break;
        }
      }
    }
    if (!mine) throw new Error("No mine found");
    api.reveal(mine.x, mine.y);
    return { artifact, mine };
  });

  const flag = await findCell(page, "covered");
  const flagPoint = await worldPoint(page, flag);
  await page.mouse.click(flagPoint.x, flagPoint.y, { button: "right" });
  await page.mouse.move(700, 500);
  await page.mouse.down();
  await page.mouse.move(840, 590);
  await page.mouse.up();
  await page.dispatchEvent("#board", "wheel", { clientX: 760, clientY: 470, deltaY: -260 });

  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("saved");
  const before = await page.evaluate(
    ({ artifact, mine, flag }) => {
      const api = window.__infiniteMines;
      return {
        seed: api.model.seed,
        topology: api.model.topologyId,
        mode: api.model.mode,
        density: api.model.density,
        generation: api.model.fieldGeneration,
        score: api.model.score,
        things: api.model.things,
        health: api.model.health,
        opened: api.model.store.openedCells,
        stored: api.model.store.nonZeroCells,
        bounds: api.model.bounds,
        artifactState: api.model.getState(artifact.x, artifact.y),
        mineState: api.model.getState(mine.x, mine.y),
        flagState: api.model.getState(flag.x, flag.y),
        view: api.renderer.createViewSnapshot(),
      };
    },
    { ...progress, flag },
  );
  const databaseRecord = await page.evaluate(
    () =>
      new Promise<{
        version: number;
        modelVersion: number;
        generation: string;
        cellBytes: number;
        records: number;
        active: string;
      }>((resolve, reject) => {
        const open = indexedDB.open("infinite-mines", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction("sessions");
          const store = transaction.objectStore("sessions");
          const active = store.get("active-slot");
          active.onerror = () => reject(active.error);
          active.onsuccess = () => {
            const key = `field:${active.result.topology}:${active.result.mode}`;
            const get = store.get(key);
            get.onerror = () => reject(get.error);
            get.onsuccess = () =>
              resolve({
                version: get.result.version,
                modelVersion: get.result.model.version,
                generation: get.result.model.generation,
                cellBytes: get.result.model.cells.byteLength,
                records: get.result.model.cells.byteLength / 9,
                active: key,
              });
          };
        };
      }),
  );
  expect(databaseRecord.version).toBe(4);
  expect(databaseRecord.modelVersion).toBe(4);
  expect(databaseRecord.generation).toBe("original-things");
  expect(databaseRecord.active).toBe("field:square:beginner");
  expect(databaseRecord.cellBytes).toBe(before.stored * 9);
  expect(databaseRecord.records).toBe(before.stored);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("restored");
  const after = await page.evaluate(
    ({ artifact, mine, flag }) => {
      const api = window.__infiniteMines;
      return {
        seed: api.model.seed,
        topology: api.model.topologyId,
        mode: api.model.mode,
        density: api.model.density,
        generation: api.model.fieldGeneration,
        score: api.model.score,
        things: api.model.things,
        health: api.model.health,
        opened: api.model.store.openedCells,
        stored: api.model.store.nonZeroCells,
        bounds: api.model.bounds,
        artifactState: api.model.getState(artifact.x, artifact.y),
        mineState: api.model.getState(mine.x, mine.y),
        flagState: api.model.getState(flag.x, flag.y),
        view: api.renderer.createViewSnapshot(),
      };
    },
    { ...progress, flag },
  );
  expect(after).toEqual(before);
});

test("R45 — pre-footprint fields retain their exact rules until an explicit restart", async ({ page }) => {
  await openDeterministicGame(page);
  await page.evaluate(async () => {
    const api = window.__infiniteMines;
    api.model.reset("beginner", 0x18_00_00_01, false, "square", 0.18);
    const current = api.model.createSnapshot();
    const legacyModel = {
      ...current,
      version: 3,
      density: 0.18 * (3295 / 3456),
    } as Record<string, unknown>;
    delete legacyModel.generation;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infinite-mines", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("sessions", "readwrite");
      const store = transaction.objectStore("sessions");
      store.put({ version: 3, savedAt: Date.now(), model: legacyModel, view: api.renderer.createViewSnapshot() }, "field:square:beginner");
      store.put({ version: 1, topology: "square", mode: "beginner" }, "active-slot");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.model.density)).toBeCloseTo(0.18 * (3295 / 3456), 12);
  expect(await page.evaluate(() => window.__infiniteMines.model.fieldGeneration)).toBe("legacy-flat");
  expect(await page.evaluate(() => window.__infiniteMines.model.thingFootprintAt(0, 0))).toBe(false);
  await expect(page.locator("#density-stat")).toHaveText("17.16%");
  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator("#current-density")).toHaveText("17.16% CURRENT · SAVED FIELD");
  await page.getByRole("button", { name: "Close" }).click();

  await page.locator("#restart-button").click();
  expect(await page.evaluate(() => window.__infiniteMines.model.density)).toBe(0.18);
  expect(await page.evaluate(() => window.__infiniteMines.model.fieldGeneration)).toBe("original-things");
  expect(
    await page.evaluate(() => {
      const model = window.__infiniteMines.model;
      let reserved = 0;
      for (let y = 0; y < 24; y += 1) {
        for (let x = 0; x < 24; x += 1) reserved += Number(model.thingFootprintAt(x, y));
      }
      return reserved;
    }),
  ).toBeGreaterThanOrEqual(25);
  await expect(page.locator("#density-stat")).toHaveText("18%");
});

test("R35 — an old saved number at a current Thing migrates to rendered clue zero", async ({ page }) => {
  await openDeterministicGame(page);
  const stale = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    let artifact: { x: number; y: number } | null = null;
    for (let y = -100; y <= 100 && !artifact; y += 1) {
      for (let x = -100; x <= 100; x += 1) {
        if (api.model.artifactAt(x, y)) {
          artifact = { x, y };
          break;
        }
      }
    }
    if (!artifact) throw new Error("No artifact found for old-save fixture");
    api.model.store.set(artifact.x, artifact.y, 5);
    await api.flushSave();
    return artifact;
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().persistenceStatus)).toBe("restored");
  const migrated = await page.evaluate(async (artifact) => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    const pixelCellSize = 4;
    renderer.restoreView({
      version: 1,
      panX: -artifact.x * pixelCellSize,
      panY: -artifact.y * pixelCellSize,
      zoom: pixelCellSize / 25,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = document.querySelector<HTMLCanvasElement>("#board");
    if (!canvas) throw new Error("Missing board");
    const bounds = canvas.getBoundingClientRect();
    const dpr = canvas.width / bounds.width;
    const pixel = new Uint8Array(4);
    const normalPixel = new Uint8Array(4);
    renderer.gl.finish();
    renderer.gl.readPixels(
      Math.floor((bounds.width / 2) * dpr),
      canvas.height - 1 - Math.floor((bounds.height / 2) * dpr),
      1,
      1,
      renderer.gl.RGBA,
      renderer.gl.UNSIGNED_BYTE,
      pixel,
    );
    renderer.gl.readPixels(
      Math.floor((bounds.width / 2 + pixelCellSize) * dpr),
      canvas.height - 1 - Math.floor((bounds.height / 2) * dpr),
      1,
      1,
      renderer.gl.RGBA,
      renderer.gl.UNSIGNED_BYTE,
      normalPixel,
    );
    return {
      state: api.model.getState(artifact.x, artifact.y),
      clue: api.model.clueAt(artifact.x, artifact.y),
      artifact: api.model.artifactAt(artifact.x, artifact.y),
      pixel: Array.from(pixel.slice(0, 3)),
      normalPixel: Array.from(normalPixel.slice(0, 3)),
    };
  }, stale);
  expect(migrated.state).toBe(1);
  expect(migrated.clue).toBe(0);
  expect(migrated.artifact).toBe(true);
  expect(migrated.pixel).not.toEqual(migrated.normalPixel);
});

test("R40 — every topology and difficulty restores its own field, progress, and viewport", async ({ page }) => {
  await openDeterministicGame(page);
  const capture = async (cell: { x: number; y: number }) =>
    page.evaluate((target) => {
      const api = window.__infiniteMines;
      return {
        topology: api.model.topologyId,
        mode: api.model.mode,
        density: api.model.density,
        seed: api.model.seed,
        score: api.model.score,
        stored: api.model.store.nonZeroCells,
        state: api.model.getState(target.x, target.y),
        view: api.renderer.createViewSnapshot(),
      };
    }, cell);
  const switchChoice = async (name: RegExp) => {
    await page.getByRole("button", { name: "Game settings" }).click();
    await page.getByRole("button", { name }).click();
  };

  await page.evaluate(() => {
    const api = window.__infiniteMines;
    api.model.cycleMark(500, 500);
    api.renderer.restoreView({ version: 1, panX: 123.5, panY: -77.25, zoom: 1.4 });
  });
  await page.evaluate(() => window.__infiniteMines.flushSave());
  const squareBeginner = await capture({ x: 500, y: 500 });

  await switchChoice(/Master/);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.mode)).toBe("master");
  await page.evaluate(() => {
    const api = window.__infiniteMines;
    api.model.cycleMark(600, 600);
    api.renderer.restoreView({ version: 1, panX: -211.75, panY: 95.5, zoom: 0.8 });
  });
  await page.evaluate(() => window.__infiniteMines.flushSave());
  const squareMaster = await capture({ x: 600, y: 600 });

  await switchChoice(/Rhombille/);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.topologyId)).toBe("rhombille");
  await page.evaluate(() => {
    const api = window.__infiniteMines;
    api.model.cycleMark(700, 700);
    api.renderer.restoreView({ version: 1, panX: 48.25, panY: 310.75, zoom: 1.9 });
  });
  await page.evaluate(() => window.__infiniteMines.flushSave());
  const rhombilleMaster = await capture({ x: 700, y: 700 });

  await switchChoice(/Square/);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.topologyId)).toBe("square");
  expect(await capture({ x: 600, y: 600 })).toEqual(squareMaster);

  await switchChoice(/Beginner/);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.mode)).toBe("beginner");
  expect(await capture({ x: 500, y: 500 })).toEqual(squareBeginner);

  await switchChoice(/Rhombille/);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.topologyId)).toBe("rhombille");
  await switchChoice(/Master/);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.mode)).toBe("master");
  expect(await capture({ x: 700, y: 700 })).toEqual(rhombilleMaster);

  const slots = await page.evaluate(
    () =>
      new Promise<{ keys: IDBValidKey[]; active: { topology: string; mode: string; generation: string } }>((resolve, reject) => {
        const open = indexedDB.open("infinite-mines", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const store = open.result.transaction("sessions").objectStore("sessions");
          const keys = store.getAllKeys();
          const active = store.get("active-slot");
          keys.onerror = () => reject(keys.error);
          active.onerror = () => reject(active.error);
          let resultKeys: IDBValidKey[] | null = null;
          let resultActive: { topology: string; mode: string; generation: string } | null = null;
          const finish = () => {
            if (resultKeys && resultActive) resolve({ keys: resultKeys, active: resultActive });
          };
          keys.onsuccess = () => {
            resultKeys = keys.result;
            finish();
          };
          active.onsuccess = () => {
            resultActive = active.result;
            finish();
          };
        };
      }),
  );
  expect(slots.keys).toEqual(
    expect.arrayContaining([
      "active-slot",
      "field:square:beginner",
      "field:square:master",
      "field:rhombille:beginner",
      "field:rhombille:master",
    ]),
  );
  expect(slots.active).toEqual({ version: 2, topology: "rhombille", mode: "master", generation: "original-things" });

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("restored");
  expect(await capture({ x: 700, y: 700 })).toEqual(rhombilleMaster);
});

test("R40 — Restart replaces only the active topology and difficulty slot", async ({ page }) => {
  await openDeterministicGame(page);
  await page.evaluate(() => {
    window.__infiniteMines.model.cycleMark(500, 500);
    return window.__infiniteMines.flushSave();
  });
  await page.getByRole("button", { name: "Game settings" }).click();
  await page.getByRole("button", { name: /Master/ }).click();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.mode)).toBe("master");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("saved");
  const oldMasterSeed = await page.evaluate(() => window.__infiniteMines.model.seed);
  await page.evaluate((nextSeed) => {
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: (array: Uint32Array) => {
        array.fill(nextSeed);
        return array;
      },
    });
  }, (oldMasterSeed ^ 0xa5a5_a5a5) >>> 0);
  await page.locator("#restart-button").click();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.seed)).not.toBe(oldMasterSeed);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("1");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.mode)).toBe("beginner");
  expect(await page.evaluate(() => window.__infiniteMines.model.getState(500, 500))).toBe(10);
  await page.keyboard.press("2");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.mode)).toBe("master");
  expect(await page.evaluate(() => window.__infiniteMines.model.seed)).not.toBe(oldMasterSeed);
  expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual({
    version: 1,
    panX: 0,
    panY: 0,
    zoom: 1,
  });
});
