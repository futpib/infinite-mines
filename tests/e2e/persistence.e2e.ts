import { expect, test } from "@playwright/test";
import { findCell, hexToRgb, openDeterministicGame, worldPoint } from "./helpers";

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
      new Promise<{ version: number; cellBytes: number; records: number; active: string }>((resolve, reject) => {
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
                cellBytes: get.result.model.cells.byteLength,
                records: get.result.model.cells.byteLength / 9,
                active: key,
              });
          };
        };
      }),
  );
  expect(databaseRecord.version).toBe(3);
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

test("R45 — legacy fields retain their original density until an explicit restart", async ({ page }) => {
  await openDeterministicGame(page);
  await page.evaluate(async () => {
    const api = window.__infiniteMines;
    api.model.reset("beginner", 0x18_00_00_01, true, "square", 0.18);
    const current = api.model.createSnapshot();
    const legacyModel = { ...current, version: 2 } as Record<string, unknown>;
    delete legacyModel.density;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infinite-mines", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("sessions", "readwrite");
      const store = transaction.objectStore("sessions");
      store.put({ version: 2, savedAt: Date.now(), model: legacyModel, view: api.renderer.createViewSnapshot() }, "field:square:beginner");
      store.put({ version: 1, topology: "square", mode: "beginner" }, "active-slot");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.model.density)).toBe(0.18);
  await expect(page.locator("#density-stat")).toHaveText("18%");
  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator("#current-density")).toHaveText("18% CURRENT · SAVED FIELD");
  await page.getByRole("button", { name: "Close" }).click();

  await page.locator("#restart-button").click();
  expect(await page.evaluate(() => window.__infiniteMines.model.density)).toBeCloseTo(0.18 * (3295 / 3456), 12);
  await expect(page.locator("#density-stat")).toHaveText("17.16%");
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
    renderer.restoreView({
      version: 1,
      panX: -artifact.x * 25,
      panY: -artifact.y * 25,
      zoom: 1,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = document.querySelector<HTMLCanvasElement>("#board");
    if (!canvas) throw new Error("Missing board");
    const bounds = canvas.getBoundingClientRect();
    const dpr = canvas.width / bounds.width;
    const pixel = new Uint8Array(4);
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
    return {
      state: api.model.getState(artifact.x, artifact.y),
      clue: api.model.clueAt(artifact.x, artifact.y),
      artifact: api.model.artifactAt(artifact.x, artifact.y),
      pixel: Array.from(pixel.slice(0, 3)),
      expected: getComputedStyle(document.documentElement).getPropertyValue("--board-artifact").trim(),
    };
  }, stale);
  expect(migrated.state).toBe(1);
  expect(migrated.clue).toBe(0);
  expect(migrated.artifact).toBe(true);
  expect(migrated.pixel).toEqual(hexToRgb(migrated.expected));
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
      new Promise<{ keys: IDBValidKey[]; active: { topology: string; mode: string } }>((resolve, reject) => {
        const open = indexedDB.open("infinite-mines", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const store = open.result.transaction("sessions").objectStore("sessions");
          const keys = store.getAllKeys();
          const active = store.get("active-slot");
          keys.onerror = () => reject(keys.error);
          active.onerror = () => reject(active.error);
          let resultKeys: IDBValidKey[] | null = null;
          let resultActive: { topology: string; mode: string } | null = null;
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
  expect(slots.active).toEqual({ version: 1, topology: "rhombille", mode: "master" });

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
