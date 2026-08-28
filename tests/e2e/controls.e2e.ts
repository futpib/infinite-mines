import { expect, test } from "@playwright/test";
import { findCell, openDeterministicGame, worldPoint } from "./helpers";

test("R08/R10 — guarded mode protects only concealed reveal actions", async ({ page }) => {
  await openDeterministicGame(page);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().controlsMode)).toBe("guarded");
  await expect(page.locator("#reveal-key")).toHaveText("CTRL + CLICK");

  const blocked = await findCell(page, "covered-safe");
  const blockedPoint = await worldPoint(page, blocked);
  await page.mouse.click(blockedPoint.x, blockedPoint.y);
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), blocked)).toBe(0);
  await expect(page.locator("#toast")).toContainText("Hold Ctrl");

  await page.keyboard.down("Control");
  await page.mouse.click(blockedPoint.x, blockedPoint.y);
  await page.keyboard.up("Control");
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), blocked)).toBeGreaterThan(0);

  const opened = await findCell(page, "opened");
  const openedPoint = await worldPoint(page, opened);
  await page.evaluate(() => {
    const toast = document.querySelector<HTMLElement>("#toast");
    if (toast) toast.textContent = "";
  });
  await page.mouse.click(openedPoint.x, openedPoint.y);
  await expect(page.locator("#toast")).not.toContainText("Hold Ctrl / ⌘");

  const flagged = await findCell(page, "covered");
  const flaggedPoint = await worldPoint(page, flagged);
  await page.mouse.click(flaggedPoint.x, flaggedPoint.y, { button: "right" });
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), flagged)).toBe(10);
  await page.evaluate(() => {
    const toast = document.querySelector<HTMLElement>("#toast");
    if (toast) toast.textContent = "";
  });
  await page.mouse.click(flaggedPoint.x, flaggedPoint.y);
  await expect(page.locator("#toast")).not.toContainText("Hold Ctrl / ⌘");

  const shifted = await findCell(page, "covered");
  const shiftedPoint = await worldPoint(page, shifted);
  await page.keyboard.down("Shift");
  await page.mouse.click(shiftedPoint.x, shiftedPoint.y);
  await page.keyboard.up("Shift");
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), shifted)).toBe(10);

  const controlRight = await findCell(page, "covered-safe");
  const controlRightPoint = await worldPoint(page, controlRight);
  await page.keyboard.down("Control");
  await page.mouse.click(controlRightPoint.x, controlRightPoint.y, { button: "right" });
  await page.keyboard.up("Control");
  const controlRightState = await page.evaluate(
    ({ x, y }) => window.__infiniteMines.model.getState(x, y),
    controlRight,
  );
  expect(controlRightState).toBeGreaterThan(0);
  expect(controlRightState).not.toBe(10);

  const questioned = await findCell(page, "covered");
  const questionedPoint = await worldPoint(page, questioned);
  await page.mouse.click(questionedPoint.x, questionedPoint.y, { button: "right" });
  await page.mouse.click(questionedPoint.x, questionedPoint.y, { button: "right" });
  await page.mouse.click(questionedPoint.x, questionedPoint.y);
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), questioned)).toBe(11);
  await expect(page.locator("#toast")).toContainText("Hold Ctrl");
});

test("R08 — Classic controls restore click-to-reveal and persist", async ({ page }) => {
  await openDeterministicGame(page);
  await page.getByRole("button", { name: "Game settings" }).click();
  const classic = page.locator('#control-options [data-controls="classic"]');
  await classic.click();
  await expect(classic).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#reveal-key")).toHaveText("CLICK");

  const cell = await findCell(page, "covered-safe");
  const point = await worldPoint(page, cell);
  await page.mouse.click(point.x, point.y);
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), cell)).toBeGreaterThan(0);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().controlsMode)).toBe("classic");
  await expect(page.locator("#reveal-key")).toHaveText("CLICK");
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-controls"))).toBe("classic");
});

test("R08 — touch reveal, explicit Flag tool, and long-press marking bypass keyboard modifiers", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await openDeterministicGame(page);
    await expect(page.locator("#mobile-tool")).toBeVisible();
    await expect(page.locator("#hint")).toBeHidden();

    const revealCell = await findCell(page, "covered-safe");
    const revealPoint = await worldPoint(page, revealCell);
    await page.touchscreen.tap(revealPoint.x, revealPoint.y);
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), revealCell)).toBeGreaterThan(0);

    await page.locator("#mobile-tool").click();
    await expect(page.locator("#mobile-tool")).toContainText("FLAG");
    const toolMarked = await findCell(page, "covered");
    const toolPoint = await worldPoint(page, toolMarked);
    await page.touchscreen.tap(toolPoint.x, toolPoint.y);
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), toolMarked)).toBe(10);

    await page.locator("#mobile-tool").click();
    const longPressed = await findCell(page, "covered");
    const longPoint = await worldPoint(page, longPressed);
    await page.evaluate(({ x, y }) => {
      const canvas = document.querySelector<HTMLCanvasElement>("#board");
      if (!canvas) throw new Error("Missing board");
      canvas.setPointerCapture = () => undefined;
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: x,
          clientY: y,
          pointerId: 91,
          pointerType: "touch",
        }),
      );
    }, longPoint);
    await page.waitForTimeout(470);
    await page.evaluate(({ x, y }) => {
      document.querySelector("#board")?.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y,
          pointerId: 91,
          pointerType: "touch",
        }),
      );
    }, longPoint);
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), longPressed)).toBe(10);
  } finally {
    await context.close();
  }
});

test("R11/R14 — the arrow cursor and 7 px dead zone distinguish clicks from drags", async ({ page }) => {
  await openDeterministicGame(page);
  const board = page.locator("#board");
  await expect(board).toHaveCSS("cursor", "default");
  const cell = await findCell(page, "covered-safe");
  const point = await worldPoint(page, cell);
  const initialView = await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot());

  await page.keyboard.down("Control");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect(board).toHaveCSS("cursor", "default");
  await page.mouse.move(point.x + 4, point.y + 4);
  await expect(board).toHaveCSS("cursor", "default");
  expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual(initialView);
  await page.mouse.up();
  await page.keyboard.up("Control");
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), cell)).toBeGreaterThan(0);

  await page.mouse.move(700, 500);
  await page.mouse.down();
  await expect(board).toHaveCSS("cursor", "default");
  await page.mouse.move(708, 500);
  await expect(board).toHaveCSS("cursor", "grabbing");
  expect((await page.evaluate(() => window.__infiniteMines.renderer.panX)) - initialView.panX).toBe(8);
  await page.mouse.up();
  await expect(board).toHaveCSS("cursor", "default");
});

test("R19 — guarded guidance follows the browser platform", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "MacIntel" });
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      configurable: true,
      get: () => ({ platform: "macOS" }),
    });
  });
  try {
    await openDeterministicGame(page);
    await expect(page.locator("#reveal-key")).toHaveText("⌘ + CLICK");
    await page.getByRole("button", { name: "Game settings" }).click();
    await expect(page.locator("#guarded-description")).toHaveText("Command (⌘) + click reveals");
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "How to play" }).click();
    await expect(page.locator("#help-guarded-description")).toContainText("need Command (⌘) only");
    await page.getByRole("button", { name: "Close" }).click();

    const cell = await findCell(page, "covered-safe");
    const point = await worldPoint(page, cell);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator("#toast")).toContainText("Hold Command (⌘)");
    await page.keyboard.down("Meta");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("Meta");
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), cell)).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("R28 — fullscreen and hidden controls stay synchronized and recoverable", async ({ page }) => {
  await openDeterministicGame(page);
  const fullscreen = page.getByRole("button", { name: "Enter fullscreen" });
  const hide = page.getByRole("button", { name: "Hide controls" });
  const fixedScreenPoint = { x: 720, y: 450 };
  const cellAtFixedScreenPoint = () =>
    page.evaluate((point) => {
      const canvas = document.querySelector<HTMLCanvasElement>("#board");
      if (!canvas) throw new Error("Board is missing");
      const bounds = canvas.getBoundingClientRect();
      return window.__infiniteMines.renderer.screenToCell(point.x - bounds.left, point.y - bounds.top);
    }, fixedScreenPoint);
  const initial = await page.evaluate(() => ({
    seed: window.__infiniteMines.model.seed,
    view: window.__infiniteMines.renderer.createViewSnapshot(),
  }));
  const initialBoard = await page.locator("#board").boundingBox();
  const initialFixedCell = await cellAtFixedScreenPoint();
  expect(initialBoard).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  await expect(page.locator(".topbar")).toHaveCSS("position", "absolute");
  expect(await page.evaluate(() => document.elementFromPoint(720, 32)?.closest(".topbar") !== null)).toBe(true);

  expect(await page.evaluate(() => document.fullscreenEnabled)).toBe(true);
  await fullscreen.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  await expect(page.getByRole("button", { name: "Exit fullscreen" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().fullscreen)).toBe(true);

  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
  await expect(fullscreen).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const beforeHideFrames = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);

  await hide.click();
  await expect(page.locator("body")).toHaveClass(/ui-hidden/);
  await expect(page.locator("#game")).toHaveAttribute("data-ui", "hidden");
  await expect(page.locator(".topbar")).toBeHidden();
  await expect(page.locator(".stats")).toBeHidden();
  await expect(page.locator("#hint")).toBeHidden();
  await expect(page.locator("#cell-locator")).toBeHidden();
  await expect(page.locator("#hover-overlay")).toBeHidden();
  expect(
    await page.locator("#game").evaluate((container) =>
      [...container.children]
        .filter((child) => getComputedStyle(child).display !== "none")
        .map((child) => child.id || child.className),
    ),
  ).toEqual(["board", "controls"]);
  expect(
    await page.locator(".controls").evaluate((container) =>
      [...container.children]
        .filter((child) => getComputedStyle(child).display !== "none")
        .map((child) => child.id),
    ),
  ).toEqual(["ui-toggle-button"]);
  await expect(fullscreen).toBeHidden();
  const show = page.getByRole("button", { name: "Show controls" });
  await expect(show).toBeVisible();
  await expect(show).toHaveAttribute("aria-pressed", "true");
  const hiddenBoard = await page.locator("#board").boundingBox();
  expect(hiddenBoard).toEqual(initialBoard);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBe(beforeHideFrames);
  expect(await cellAtFixedScreenPoint()).toEqual(initialFixedCell);
  expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual(initial.view);
  expect(await page.evaluate(() => window.__infiniteMines.model.seed)).toBe(initial.seed);

  await page.mouse.move(fixedScreenPoint.x, fixedScreenPoint.y);
  await page.mouse.wheel(0, -180);
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.renderer.cellSize)).toBeGreaterThan(25);
  expect(await cellAtFixedScreenPoint()).toEqual(initialFixedCell);

  const board = page.locator("#board");
  const bounds = await board.boundingBox();
  if (!bounds) throw new Error("Board is not visible");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 24, bounds.y + bounds.height / 2);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__infiniteMines.renderer.panX)).not.toBe(initial.view.panX);
  const hiddenView = await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot());
  const hiddenFixedCell = await cellAtFixedScreenPoint();
  await page.evaluate(() => window.__infiniteMines.flushSave());
  const beforeShowFrames = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);

  await show.click();
  await expect(page.locator("body")).not.toHaveClass(/ui-hidden/);
  await expect(page.locator("#game")).toHaveAttribute("data-ui", "visible");
  await expect(page.locator(".topbar")).toBeVisible();
  await expect(page.locator(".stats")).toBeVisible();
  await expect(hide).toBeVisible();
  await expect(hide).toHaveAttribute("aria-pressed", "false");
  expect(await page.locator("#board").boundingBox()).toEqual(initialBoard);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBe(beforeShowFrames);
  expect(await cellAtFixedScreenPoint()).toEqual(hiddenFixedCell);
  expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual(hiddenView);
  expect(await page.evaluate(() => window.__infiniteMines.model.seed)).toBe(initial.seed);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().persistenceStatus)).toBe("restored");
  await expect(page.locator("body")).not.toHaveClass(/ui-hidden/);
  expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual(hiddenView);
});

test("R29 — only 50 successful cell actions auto-hide controls, with a persisted opt-out", async ({ page }) => {
  await openDeterministicGame(page);
  const board = page.locator("#board");
  const restart = page.getByRole("button", { name: "New game" });
  const center = async () => {
    const bounds = await board.boundingBox();
    if (!bounds) throw new Error("Board is not visible");
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  };
  const drag = async () => {
    const point = await center();
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 12, point.y);
    await page.mouse.up();
  };

  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().autoHideMode)).toBe("after-fifty");
  await page.mouse.move(400, 400);
  await page.mouse.move(420, 420);
  await drag();
  const centerPoint = await center();
  await page.mouse.move(centerPoint.x, centerPoint.y);
  await page.mouse.wheel(0, 60);
  await page.mouse.wheel(0, 60);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().gameplayInteractionCount)).toBe(0);

  const guardedCell = await findCell(page, "covered-safe");
  const guardedPoint = await worldPoint(page, guardedCell);
  await page.mouse.click(guardedPoint.x, guardedPoint.y);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().gameplayInteractionCount)).toBe(0);

  const markedCell = await findCell(page, "covered");
  let markedPoint = await worldPoint(page, markedCell);
  for (let index = 0; index < 3; index += 1) {
    await page.mouse.click(markedPoint.x, markedPoint.y, { button: "right" });
  }
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().gameplayInteractionCount)).toBe(3);
  await expect(restart).toBeVisible();

  await page.getByRole("button", { name: "Return to origin" }).click();
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().gameplayInteractionCount)).toBe(0);

  markedPoint = await worldPoint(page, markedCell);
  for (let index = 0; index < 49; index += 1) {
    await page.mouse.click(markedPoint.x, markedPoint.y, { button: "right" });
  }
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().gameplayInteractionCount)).toBe(49);
  await expect(restart).toBeVisible();
  await page.mouse.move(markedPoint.x, markedPoint.y);
  await page.mouse.down({ button: "right" });
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().uiHidden)).toBe(false);
  await expect(restart).toBeVisible();
  await page.mouse.up({ button: "right" });
  await expect(restart).toBeHidden();
  await expect(page.getByRole("button", { name: "Show controls" })).toBeVisible();
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().uiHidden)).toBe(true);

  await page.getByRole("button", { name: "Show controls" }).click();
  await page.getByRole("button", { name: "Game settings" }).click();
  const never = page.locator('#auto-hide-options [data-auto-hide="never"]');
  await never.click();
  await expect(never).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close" }).click();

  for (let index = 0; index < 51; index += 1) {
    await page.mouse.click(markedPoint.x, markedPoint.y, { button: "right" });
  }
  await expect(restart).toBeVisible();
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().gameplayInteractionCount)).toBe(0);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().autoHideMode)).toBe("never");
  await expect(restart).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-auto-hide-controls"))).toBe("never");
});
