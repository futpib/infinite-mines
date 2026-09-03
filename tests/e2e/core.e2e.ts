import { expect, test } from "@playwright/test";
import { CellState } from "../../src/model";
import { openDeterministicGame, worldPoint } from "./helpers";

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

test("R32 — the production SVG favicon remains legible at browser-tab size", async ({ page, request }) => {
  const faviconResponse = await request.get("http://127.0.0.1:4175/favicon.svg", {
    headers: { Host: "claude-laptop.lan" },
  });
  expect(faviconResponse.status()).toBe(200);
  expect(faviconResponse.headers()["content-type"]).toContain("image/svg+xml");
  const source = await faviconResponse.text();
  expect(source).toContain("<title id=\"title\">Infinite Mines</title>");
  expect(source).toContain('viewBox="0 0 64 64"');

  await openDeterministicGame(page);
  const icon = page.locator('link[rel="icon"][type="image/svg+xml"]');
  await expect(icon).toHaveAttribute("href", "./favicon.svg");
  await expect(icon).toHaveAttribute("sizes", "any");
  const raster = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href;
    if (!href) throw new Error("Missing favicon URL");
    const image = new Image();
    image.src = href;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing 2D context");
    context.drawImage(image, 0, 0, 16, 16);
    const pixels = context.getImageData(0, 0, 16, 16).data;
    let opaquePixels = 0;
    const colors = new Set<string>();
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] < 128) continue;
      opaquePixels += 1;
      colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
    }
    return { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, opaquePixels, colors: colors.size };
  });
  expect(raster).toEqual({ naturalWidth: 64, naturalHeight: 64, opaquePixels: expect.any(Number), colors: expect.any(Number) });
  expect(raster.opaquePixels).toBeGreaterThan(160);
  expect(raster.colors).toBeGreaterThan(12);
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
  await expect(page.locator("#difficulty-list button")).toHaveCount(6);
  await expect(page.getByRole("button", { name: /Beginner/ })).toContainText("17.16% mines");
  await expect(page.getByRole("button", { name: /Deathmatch/ })).toContainText("1 life");
  await page.getByRole("button", { name: "Close" }).click();

  const progress = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const model = api.model;
    const thingsBefore = model.things;
    let artifact: { x: number; y: number } | null = null;
    for (let y = 50; y < 200 && !artifact; y += 1) {
      for (let x = 50; x < 200; x += 1) {
        if (model.artifactAt(x, y) && model.getState(x, y) === 0) {
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
    return {
      artifact,
      artifactClue: model.clueAt(artifact.x, artifact.y),
      mine,
      things: model.things,
      thingsDelta: model.things - thingsBefore,
      health: model.health,
      score: model.score,
    };
  });
  expect(progress.artifactClue).toBe(0);
  expect(progress.thingsDelta).toBeGreaterThanOrEqual(1);
  expect(progress.health).toBe(2);
  expect(progress.score).toBeGreaterThan(safeOpening.score);
  await expect(page.locator("#things-stat")).toHaveText(progress.things.toLocaleString());
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

test("R45 — effective presets and a persisted custom density report the active field exactly", async ({ page }) => {
  await openDeterministicGame(page);
  expect(await page.evaluate(() => window.__infiniteMines.model.density)).toBeCloseTo(0.18 * (3295 / 3456), 12);
  await expect(page.locator("#density-stat")).toHaveText("17.16%");

  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator("#current-density")).toHaveText("17.16% CURRENT");
  await expect(page.getByRole("button", { name: /Master/ })).toContainText("20.98% mines");
  await expect(page.getByRole("button", { name: /Impossible/ })).toContainText("31.46% mines");
  const customInput = page.locator("#custom-density-input");
  await customInput.fill("12.34");
  await page.getByRole("button", { name: "USE", exact: true }).click();

  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.mode)).toBe("custom");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.density)).toBeCloseTo(0.1234, 12);
  await expect(page.locator("#mode-stat")).toHaveText("CUSTOM");
  await expect(page.locator("#density-stat")).toHaveText("12.34%");
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-custom-density"))).toBe("0.1234");
  const customSeed = await page.evaluate(() => window.__infiniteMines.model.seed);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.model.seed)).toBe(customSeed);
  expect(await page.evaluate(() => window.__infiniteMines.model.density)).toBeCloseTo(0.1234, 12);
  await expect(page.locator("#density-stat")).toHaveText("12.34%");
  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator("#custom-density-option")).toHaveAttribute("data-selected", "true");
  await expect(page.getByRole("button", { name: "USE", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(customInput).toHaveValue("12.34");
  const customGeneration = await page.evaluate(() => window.__infiniteMines.model.store.generation);

  await customInput.fill("0.5");
  await page.getByRole("button", { name: "USE", exact: true }).click();
  await expect(customInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#settings-dialog")).toHaveAttribute("open", "");
  expect(await page.evaluate(() => window.__infiniteMines.model.density)).toBeCloseTo(0.1234, 12);

  await customInput.fill("13.37");
  await page.getByRole("button", { name: "USE", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.density)).toBeCloseTo(0.1337, 12);
  expect(await page.evaluate(() => window.__infiniteMines.model.store.generation)).toBeGreaterThan(customGeneration);
  await expect(page.locator("#density-stat")).toHaveText("13.37%");
  await page.evaluate(() => window.__infiniteMines.flushSave());
  const savedCustomDensity = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("infinite-mines", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction("sessions").objectStore("sessions").get("field:square:custom");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result.model.density);
        };
      }),
  );
  expect(savedCustomDensity).toBeCloseTo(0.1337, 12);
});

test("R02/R30 — chording works and automatic flagging stays silent", async ({ page }) => {
  await openDeterministicGame(page);
  const result = await page.evaluate(() => {
    const api = window.__infiniteMines;
    const model = api.model;
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

    model.reset("beginner", 1, false);
    model.mineAt = checkerboard;
    model.reveal(0, 0);
    model.reveal(0, -1);
    model.reveal(1, 0);
    model.reveal(0, 1);
    model.reveal(-1, 0);
    api.reveal(0, 0);
    const appliedCornerState = model.getState(1, 1);

    model.reset("ultimate", 1, false);
    model.score = 999;
    model.mineAt = (x: number, y: number) => x === 1 && y === 0;
    model.reveal(0, 0);
    return {
      chordChanged: chord.changed,
      autoFlagged: autoFlag.autoFlagged,
      cornerState,
      appliedCornerState,
      milestoneScore: model.score,
      milestoneHealth: model.health,
    };
  });
  expect(result.chordChanged).toBe(4);
  expect(result.autoFlagged).toBe(4);
  expect(result.cornerState).toBe(10);
  expect(result.appliedCornerState).toBe(10);
  await expect(page.locator("#toast")).toBeEmpty();
  expect(result.milestoneScore).toBe(1000);
  expect(result.milestoneHealth).toBe(4);
});

test("R42 — invalid negative-coordinate chords and mine chains remain bounded", async ({ page }) => {
  test.setTimeout(10_000);
  await openDeterministicGame(page, 84);
  await page.evaluate(() => {
    const model = window.__infiniteMines.model;
    const auditWindow = window as typeof window & {
      __r42Actions?: Array<{ x: number; y: number; durationMs: number; result: ReturnType<typeof model.reveal> }>;
    };
    auditWindow.__r42Actions = [];
    const reveal = model.reveal.bind(model);
    model.reveal = (x, y) => {
      const startedAt = performance.now();
      const result = reveal(x, y);
      auditWindow.__r42Actions!.push({ x, y, durationMs: performance.now() - startedAt, result });
      return result;
    };
  });

  const overFlagged = await page.evaluate(
    ({ opened2, flagged }) => {
      const api = window.__infiniteMines;
      const center = { x: -6, y: -1 };
      api.model.reset("impossible", 84, false, "triangular", 0.33);
      api.model.store.set(center.x, center.y, opened2);
      const safeNeighbors: Array<{ x: number; y: number }> = [];
      api.model.topology.forEachNeighbor(center.x, center.y, (x, y) => {
        if (!api.model.mineAt(x, y)) safeNeighbors.push({ x, y });
      });
      for (const cell of safeNeighbors.slice(0, 3)) api.model.store.set(cell.x, cell.y, flagged);
      api.renderer.home();
      api.renderer.requestRender();
      return { center, flags: safeNeighbors.slice(0, 3), health: api.model.health };
    },
    { opened2: CellState.Opened2, flagged: CellState.Flagged },
  );
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const noOpFrame = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
  const overFlaggedPoint = await worldPoint(page, overFlagged.center);
  await page.mouse.click(overFlaggedPoint.x, overFlaggedPoint.y);
  const noOp = await page.evaluate(() => {
    const auditWindow = window as typeof window & {
      __r42Actions: Array<{ x: number; y: number; durationMs: number; result: { changed: number; damage: unknown } }>;
    };
    return {
      action: auditWindow.__r42Actions.at(-1),
      health: window.__infiniteMines.model.health,
      frameCount: window.__infiniteMines.diagnostics().frameCount,
    };
  });
  expect(noOp.action).toMatchObject({ x: -6, y: -1, result: { changed: 0, damage: null } });
  expect(noOp.action!.durationMs).toBeLessThan(50);
  expect(noOp.health).toBe(overFlagged.health);
  expect(noOp.frameCount).toBe(noOpFrame);

  const reproduction = await page.evaluate(
    ({ opened2, opened4, flagged, covered }) => {
      const api = window.__infiniteMines;
      const center = { x: -7, y: -1 };
      const nearbyTwo = { x: -6, y: -1 };
      const wrongFlags = [
        { x: -8, y: -2 },
        { x: -7, y: -2 },
        { x: -6, y: -2 },
        { x: -5, y: -1 },
      ];
      api.model.reset("impossible", 84, false, "triangular", 0.33);
      api.model.store.set(center.x, center.y, opened4);
      api.model.store.set(nearbyTwo.x, nearbyTwo.y, opened2);
      for (const cell of wrongFlags) api.model.store.set(cell.x, cell.y, flagged);

      const initialKeys = new Set<string>();
      const initialMines: Array<{ x: number; y: number }> = [];
      api.model.topology.forEachNeighbor(center.x, center.y, (x, y) => {
        initialKeys.add(`${x},${y}`);
        if (api.model.mineAt(x, y)) initialMines.push({ x, y });
      });
      let secondaryMine: { x: number; y: number } | null = null;
      for (const mine of initialMines) {
        const candidates: Array<{ x: number; y: number }> = [];
        api.model.topology.forEachNeighbor(mine.x, mine.y, (x, y) => candidates.push({ x, y }));
        const found = candidates.find(
          ({ x, y }) =>
            (x !== center.x || y !== center.y) &&
            !initialKeys.has(`${x},${y}`) &&
            api.model.getState(x, y) === covered &&
            api.model.mineAt(x, y),
        );
        if (found) {
          secondaryMine = found;
          break;
        }
      }
      if (secondaryMine === null) throw new Error("Seed 84 no longer exposes the connected-mine reproduction");
      api.renderer.home();
      api.renderer.requestRender();
      return {
        center,
        nearbyTwo,
        wrongFlags,
        initialMines,
        secondaryMine,
        centerClue: api.model.clueAt(center.x, center.y),
        nearbyClue: api.model.clueAt(nearbyTwo.x, nearbyTwo.y),
      };
    },
    {
      opened2: CellState.Opened2,
      opened4: CellState.Opened4,
      flagged: CellState.Flagged,
      covered: CellState.Covered,
    },
  );
  expect(reproduction.centerClue).toBe(4);
  expect(reproduction.nearbyClue).toBe(2);
  expect(reproduction.initialMines).toHaveLength(4);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const chordPoint = await worldPoint(page, reproduction.center);
  await page.mouse.click(chordPoint.x, chordPoint.y);

  const completed = await page.evaluate(({ initialMines, secondaryMine }) => {
    const api = window.__infiniteMines;
    const auditWindow = window as typeof window & {
      __r42Actions: Array<{
        x: number;
        y: number;
        durationMs: number;
        result: {
          changed: number;
          exploded: boolean;
          healthDelta: number;
          damage: { minX: number; minY: number; maxX: number; maxY: number } | null;
        };
      }>;
    };
    return {
      action: auditWindow.__r42Actions.at(-1),
      health: api.model.health,
      initialMineStates: initialMines.map(({ x, y }) => api.model.getState(x, y)),
      secondaryMineState: api.model.getState(secondaryMine.x, secondaryMine.y),
      packedBytes: api.model.createSnapshot().cells.byteLength,
      storedCells: api.model.store.nonZeroCells,
    };
  }, reproduction);
  expect(completed.action).toMatchObject({
    x: -7,
    y: -1,
    result: { exploded: true, healthDelta: -1 },
  });
  expect(completed.action!.durationMs).toBeLessThan(100);
  expect(completed.action!.result.changed).toBeGreaterThanOrEqual(4);
  expect(completed.action!.result.changed).toBeLessThan(256);
  expect(completed.action!.result.damage).not.toBeNull();
  expect(completed.action!.result.damage!.maxX - completed.action!.result.damage!.minX).toBeLessThan(32);
  expect(completed.action!.result.damage!.maxY - completed.action!.result.damage!.minY).toBeLessThan(32);
  expect(completed.health).toBe(2);
  expect(completed.initialMineStates).toEqual(Array(4).fill(CellState.Exploded));
  expect(completed.secondaryMineState).toBe(CellState.Covered);
  expect(completed.packedBytes).toBe(completed.storedCells * 9);
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
  await expect(page.locator("#cheat-death-health")).toHaveText("Continue with 1 health");
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
  await expect(page.locator("#cheat-death-health")).toHaveText("Continue with 1 health");
  await page.getByRole("button", { name: /Cheat death/ }).click();
  await expect(page.locator("#health-stat")).toHaveText("♥");
  await expect(page.locator("#cheats-stat")).toHaveText("2");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("saved");

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().persistenceStatus)).toBe("restored");
  await expect(page.locator("#cheats-stat-card")).toBeVisible();
  await expect(page.locator("#cheats-stat")).toHaveText("2");
  expect(await page.evaluate(() => window.__infiniteMines.model.cheats)).toBe(2);

  await page.evaluate(() => {
    const api = window.__infiniteMines;
    const model = api.model;
    for (let y = 300; y < 400; y += 1) {
      for (let x = 300; x < 400; x += 1) {
        if (model.mineAt(x, y) && model.getState(x, y) === 0) {
          api.reveal(x, y);
          return;
        }
      }
    }
    throw new Error("No third mine found");
  });
  await expect(page.locator("#game-over-screen")).toBeVisible();
  await expect(page.locator("#cheat-death-health")).toHaveText("Continue with 2 health");
  await page.getByRole("button", { name: /Cheat death/ }).click();
  await expect(page.locator("#health-stat")).toHaveText("♥♥");
  await expect(page.locator("#cheats-stat")).toHaveText("3");

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
