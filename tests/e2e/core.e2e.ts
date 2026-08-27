import { expect, test } from "@playwright/test";
import { openDeterministicGame } from "./helpers";

test("R01/R03 — the LAN host serves the Infinite-only WebGL app", async ({ page, request }) => {
  const lanResponse = await request.get("http://127.0.0.1:4175/", { headers: { Host: "claude-laptop.lan" } });
  expect(lanResponse.status()).toBe(200);
  expect(await lanResponse.text()).toContain("<title>Infinite Mines</title>");

  await openDeterministicGame(page);
  await expect(page).toHaveTitle("Infinite Mines");
  await expect(page.getByText("INFINITE", { exact: true })).toBeVisible();
  expect(
    await page.locator("#board").evaluate((element) => Boolean((element as HTMLCanvasElement).getContext("webgl2"))),
  ).toBe(true);
  expect(await page.locator("#board").count()).toBe(1);
  expect(await page.locator("[data-cell], .cell").count()).toBe(0);
  const sparsity = await page.evaluate(() => {
    const model = window.__infiniteMines.model;
    const before = model.store.chunkCount;
    model.mineAt(1_000_000, -1_000_000);
    return {
      before,
      after: model.store.chunkCount,
      stored: model.store.nonZeroCells,
      visible: window.__infiniteMines.diagnostics().visibleCells,
    };
  });
  expect(sparsity.after).toBe(sparsity.before);
  expect(sparsity.stored).toBeLessThan(sparsity.visible);
});

test("R02 — the original Infinite gameplay loop is present end to end", async ({ page }) => {
  await openDeterministicGame(page);
  const safeOpening = await page.evaluate(() => {
    const model = window.__infiniteMines.model;
    const safe: boolean[] = [];
    for (let y = -2; y <= 2; y += 1) {
      for (let x = -2; x <= 2; x += 1) safe.push(!model.mineAt(x, y));
    }
    return { safe, opened: model.store.openedCells, score: model.score, health: model.health };
  });
  expect(safeOpening.safe.every(Boolean)).toBe(true);
  expect(safeOpening.opened).toBeGreaterThanOrEqual(25);
  expect(safeOpening.score).toBeGreaterThan(0);
  expect(safeOpening.health).toBe(3);
  expect(await page.evaluate(() => window.__infiniteMines.renderer.cellSize)).toBe(25);

  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator("#difficulty-list button")).toHaveCount(5);
  await expect(page.getByRole("button", { name: /Beginner/ })).toContainText("18% mines");
  await expect(page.getByRole("button", { name: /Deathmatch/ })).toContainText("1 life");
  await page.getByRole("button", { name: "Close" }).click();

  const progress = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const model = api.model;
    let artifact: { x: number; y: number } | null = null;
    for (let y = 50; y < 200 && !artifact; y += 1) {
      for (let x = 50; x < 200; x += 1) {
        if (model.artifactAt(x, y) && model.clueAt(x, y) > 0 && model.getState(x, y) === 0) {
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
    return { artifact, mine, things: model.things, health: model.health, score: model.score };
  });
  expect(progress.things).toBe(1);
  expect(progress.health).toBe(2);
  expect(progress.score).toBeGreaterThan(safeOpening.score);
  await expect(page.locator("#things-stat")).toHaveText("1");
  await expect(page.locator("#health-stat")).toHaveText("♥♥");
  await expect(page.locator("#high-stat")).toHaveText(progress.score.toLocaleString());

  await page.evaluate(() => {
    const renderer = window.__infiniteMines.renderer;
    renderer.panBy(180, -90);
    renderer.finishPan();
  });
  await page.getByRole("button", { name: "Return to origin" }).click();
  expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual({
    version: 1,
    panX: 0,
    panY: 0,
    zoom: 1,
  });
  await page.getByRole("button", { name: "Overview map" }).click();
  await expect(page.locator("#overview-dialog")).toBeVisible();
  await expect(page.locator("#overview-caption")).toContainText("revealed");
});

test("R02 — chording and automatic flagging execute in the production browser bundle", async ({ page }) => {
  await openDeterministicGame(page);
  const result = await page.evaluate(() => {
    const model = window.__infiniteMines.model;
    const checkerboard = (x: number, y: number) => Math.abs(x % 2) === 1 && Math.abs(y % 2) === 1;
    model.reset("beginner", 1, false);
    model.mineAt = checkerboard;
    model.reveal(0, 0);
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) model.cycleMark(x, y);
    const chord = model.reveal(0, 0);

    model.reset("beginner", 1, false);
    model.mineAt = checkerboard;
    model.reveal(0, 0);
    model.reveal(0, -1);
    model.reveal(1, 0);
    model.reveal(0, 1);
    model.reveal(-1, 0);
    const autoFlag = model.reveal(0, 0);
    const cornerState = model.getState(1, 1);

    model.reset("ultimate", 1, false);
    model.score = 999;
    model.mineAt = (x: number, y: number) => x === 1 && y === 0;
    model.reveal(0, 0);
    return {
      chordChanged: chord.changed,
      autoFlagged: autoFlag.autoFlagged,
      cornerState,
      milestoneScore: model.score,
      milestoneHealth: model.health,
    };
  });
  expect(result.chordChanged).toBe(4);
  expect(result.autoFlagged).toBe(4);
  expect(result.cornerState).toBe(10);
  expect(result.milestoneScore).toBe(1000);
  expect(result.milestoneHealth).toBe(4);
});

test("R02/R27 — Deathmatch can cheat death with a persisted, conditional run counter", async ({ page }) => {
  await openDeterministicGame(page);
  await expect(page.locator("#game-over-screen")).toBeHidden();
  await expect(page.locator("#cheats-stat-card")).toBeHidden();
  const result = await page.evaluate(() => {
    const api = window.__infiniteMines;
    api.newGame("deathmatch");
    const model = api.model;
    for (let y = 100; y < 200; y += 1) {
      for (let x = 100; x < 200; x += 1) {
        if (model.mineAt(x, y)) {
          api.reveal(x, y);
          return {
            x,
            y,
            health: model.health,
            alive: model.alive,
            state: model.getState(x, y),
            seed: model.seed,
            score: model.score,
            stored: model.store.nonZeroCells,
          };
        }
      }
    }
    throw new Error("No mine found");
  });
  expect(result.health).toBe(0);
  expect(result.alive).toBe(false);
  expect(result.state).toBe(12);
  await expect(page.locator("#game")).toHaveClass(/game-over/);
  await expect(page.locator("#health-stat")).toHaveText("♡ × 0");
  await expect(page.locator("#game-over-screen")).toBeVisible();
  await expect(page.getByRole("button", { name: /Cheat death/ })).toBeFocused();
  await page.getByRole("button", { name: /Cheat death/ }).click();
  await expect(page.locator("#game")).not.toHaveClass(/game-over/);
  await expect(page.locator("#game-over-screen")).toBeHidden();
  await expect(page.locator("#health-stat")).toHaveText("♥");
  await expect(page.locator("#cheats-stat-card")).toBeVisible();
  await expect(page.locator("#cheats-stat")).toHaveText("1");
  expect(
    await page.evaluate(() => ({
      seed: window.__infiniteMines.model.seed,
      score: window.__infiniteMines.model.score,
      stored: window.__infiniteMines.model.store.nonZeroCells,
    })),
  ).toEqual({ seed: result.seed, score: result.score, stored: result.stored });

  await page.evaluate(() => {
    const api = window.__infiniteMines;
    const model = api.model;
    for (let y = 200; y < 300; y += 1) {
      for (let x = 200; x < 300; x += 1) {
        if (model.mineAt(x, y) && model.getState(x, y) === 0) {
          api.reveal(x, y);
          return;
        }
      }
    }
    throw new Error("No second mine found");
  });
  await expect(page.locator("#game-over-screen")).toBeVisible();
  await page.getByRole("button", { name: /Cheat death/ }).click();
  await expect(page.locator("#cheats-stat")).toHaveText("2");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("saved");

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().persistenceStatus)).toBe("restored");
  await expect(page.locator("#cheats-stat-card")).toBeVisible();
  await expect(page.locator("#cheats-stat")).toHaveText("2");
  expect(await page.evaluate(() => window.__infiniteMines.model.cheats)).toBe(2);

  await page.getByRole("button", { name: "New game" }).click();
  await expect(page.locator("#cheats-stat-card")).toBeHidden();
  expect(await page.evaluate(() => window.__infiniteMines.model.cheats)).toBe(0);
});

test("R17 — health starts and advances at the original mode thresholds", async ({ page }) => {
  await openDeterministicGame(page);
  const expected = [
    { mode: "beginner", startingHealth: 3, threshold: 25_000 },
    { mode: "master", startingHealth: 3, threshold: 5_000 },
    { mode: "ultimate", startingHealth: 3, threshold: 1_000 },
    { mode: "impossible", startingHealth: 3, threshold: 1_000 },
    { mode: "deathmatch", startingHealth: 1, threshold: 1_000_000_000 },
  ] as const;
  const actual = await page.evaluate((modes) => {
    const model = window.__infiniteMines.model;
    return modes.map(({ mode, threshold }) => {
      model.reset(mode, 1, false);
      const startingHealth = model.health;
      model.score = threshold - 1;
      model.mineAt = (x: number, y: number) => x === 1 && y === 0;
      const result = model.reveal(0, 0);
      return { mode, startingHealth, threshold, score: model.score, health: model.health, healthDelta: result.healthDelta };
    });
  }, expected);
  expect(actual).toEqual(
    expected.map(({ mode, startingHealth, threshold }) => ({
      mode,
      startingHealth,
      threshold,
      score: threshold,
      health: startingHealth + 1,
      healthDelta: 1,
    })),
  );
});
