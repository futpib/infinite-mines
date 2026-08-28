import { expect, test } from "@playwright/test";
import { findCell, openDeterministicGame, worldPoint } from "./helpers";

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
      new Promise<{ version: number; cellBytes: number; records: number }>((resolve, reject) => {
        const open = indexedDB.open("infinite-mines", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction("sessions").objectStore("sessions").get("active");
          get.onerror = () => reject(get.error);
          get.onsuccess = () =>
            resolve({
              version: get.result.version,
              cellBytes: get.result.model.cells.byteLength,
              records: get.result.model.cells.byteLength / 9,
            });
        };
      }),
  );
  expect(databaseRecord.version).toBe(2);
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

test("R09 — starting a new density replaces the saved session atomically", async ({ page }) => {
  await openDeterministicGame(page);
  expect(await page.evaluate(() => window.__infiniteMines.model.cycleMark(500, 500).changed)).toBe(1);
  expect(await page.evaluate(() => window.__infiniteMines.model.getState(500, 500))).toBe(10);
  await page.getByRole("button", { name: "Game settings" }).click();
  await page.getByRole("button", { name: /Master/ }).click();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("saved");
  expect(await page.evaluate(() => window.__infiniteMines.model.mode)).toBe("master");
  expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual({
    version: 1,
    panX: 0,
    panY: 0,
    zoom: 1,
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.model.mode)).toBe("master");
  expect(await page.evaluate(() => window.__infiniteMines.model.getState(500, 500))).toBe(0);
});
