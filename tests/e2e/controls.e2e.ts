import { expect, test, type Page } from "@playwright/test";
import { findCell, openDeterministicGame, worldPoint } from "./helpers";

async function gameOverActionCenter(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.locator(selector).evaluate((button) => {
    const screen = document.querySelector<HTMLElement>("#game-over-screen");
    if (!screen) throw new Error("Missing game-over screen");
    screen.style.visibility = "hidden";
    screen.hidden = false;
    const bounds = button.getBoundingClientRect();
    screen.hidden = true;
    screen.style.removeProperty("visibility");
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  });
}

async function alignFatalMine(page: Page, target: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((screenTarget) => {
    const api = window.__infiniteMines;
    api.newGame("impossible");
    const { model, renderer } = api;
    model.health = 1;
    let mine: { x: number; y: number } | null = null;
    for (let radius = 3; radius < 100 && !mine; radius += 1) {
      for (let y = -radius; y <= radius && !mine; y += 1) {
        for (let x = -radius; x <= radius; x += 1) {
          if (model.getState(x, y) === 0 && model.mineAt(x, y)) {
            mine = { x, y };
            break;
          }
        }
      }
    }
    if (!mine) throw new Error("No covered mine found");
    const polygon = renderer.cellScreenPolygon(mine.x, mine.y);
    const center = {
      x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
      y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
    };
    const board = document.querySelector<HTMLCanvasElement>("#board")?.getBoundingClientRect();
    if (!board) throw new Error("Missing board");
    renderer.panBy(screenTarget.x - board.left - center.x, screenTarget.y - board.top - center.y);
    renderer.finishPan();
    return mine;
  }, target);
}

test("R08/R10 — guarded mode protects only concealed reveal actions", async ({ page }) => {
  await openDeterministicGame(page);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().controlsMode)).toBe("guarded");
  await expect(page.locator("#reveal-key")).toHaveText("CTRL + CLICK / DOUBLE-CLICK");

  const blocked = await findCell(page, "covered-safe");
  const blockedPoint = await worldPoint(page, blocked);
  await page.mouse.click(blockedPoint.x, blockedPoint.y);
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), blocked)).toBe(0);
  await expect(page.locator("#toast")).toBeEmpty();
  await page.waitForTimeout(350);
  await expect(page.locator("#toast")).toBeEmpty();
  await expect(page.locator("#toast")).toContainText("Hold Ctrl");

  await page.keyboard.down("Control");
  await page.mouse.click(blockedPoint.x, blockedPoint.y);
  await page.keyboard.up("Control");
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), blocked)).toBeGreaterThan(0);

  const doubleClicked = await findCell(page, "covered-safe");
  const doubleClickedPoint = await worldPoint(page, doubleClicked);
  const interactionsBeforeDoubleClick = await page.evaluate(
    () => window.__infiniteMines.diagnostics().gameplayInteractionCount,
  );
  await page.evaluate(() => {
    const toast = document.querySelector<HTMLElement>("#toast");
    if (!toast) throw new Error("Missing toast");
    toast.textContent = "";
    toast.classList.remove("visible");
    const state = window as Window & {
      __guardToastMessages?: string[];
      __guardToastObserver?: MutationObserver;
    };
    state.__guardToastMessages = [];
    state.__guardToastObserver = new MutationObserver(() => {
      if (toast.textContent?.includes("Hold ")) state.__guardToastMessages?.push(toast.textContent);
    });
    state.__guardToastObserver.observe(toast, { childList: true, characterData: true, subtree: true });
  });
  await page.mouse.dblclick(doubleClickedPoint.x, doubleClickedPoint.y);
  await page.waitForTimeout(650);
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), doubleClicked)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().gameplayInteractionCount)).toBe(
    interactionsBeforeDoubleClick + 1,
  );
  await expect(page.locator("#toast")).not.toContainText("Hold Ctrl");
  expect(
    await page.evaluate(() => {
      const state = window as Window & {
        __guardToastMessages?: string[];
        __guardToastObserver?: MutationObserver;
      };
      state.__guardToastObserver?.disconnect();
      return state.__guardToastMessages ?? [];
    }),
  ).toEqual([]);

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

  const questionedDoubleClick = await findCell(page, "covered-safe");
  const questionedDoubleClickPoint = await worldPoint(page, questionedDoubleClick);
  await page.mouse.click(questionedDoubleClickPoint.x, questionedDoubleClickPoint.y, { button: "right" });
  await page.mouse.click(questionedDoubleClickPoint.x, questionedDoubleClickPoint.y, { button: "right" });
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), questionedDoubleClick)).toBe(11);
  const interactionsBeforeQuestionDoubleClick = await page.evaluate(
    () => window.__infiniteMines.diagnostics().gameplayInteractionCount,
  );
  await page.mouse.dblclick(questionedDoubleClickPoint.x, questionedDoubleClickPoint.y);
  expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), questionedDoubleClick)).toBe(0);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().gameplayInteractionCount)).toBe(
    interactionsBeforeQuestionDoubleClick + 1,
  );
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

test("R47 — guarded touch marks on tap and reveals only after a held release", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  let touchId = 90;
  const touchStart = async (point: { x: number; y: number }) => {
    touchId += 1;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ id: touchId, x: point.x, y: point.y, radiusX: 2, radiusY: 2, force: 1 }],
    });
  };
  const touchEnd = async () => {
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  try {
    await openDeterministicGame(page);
    await expect(page.locator("#mobile-tool")).toBeVisible();
    await expect(page.locator("#mobile-tool")).toContainText("FLAG");
    await expect(page.locator("#mobile-tool")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#hint")).toBeHidden();

    const heldCell = await findCell(page, "covered-safe");
    const heldPoint = await worldPoint(page, heldCell);
    await touchStart(heldPoint);
    await expect(page.locator("#touch-preview")).toBeHidden();
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics().touchPreview)).toBeNull();
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), heldCell)).toBe(0);
    await page.waitForTimeout(470);
    await expect(page.locator("#touch-preview")).toBeVisible();
    await expect(page.locator("#touch-preview-action")).toHaveText("RELEASE TO REVEAL");
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics().touchPreview)).toMatchObject({
      ...heldCell,
      action: "reveal",
      armed: true,
    });
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), heldCell)).toBe(0);
    await touchEnd();
    await expect(page.locator("#touch-preview")).toBeHidden();
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), heldCell)).toBeGreaterThan(0);

    const markedMine = await page.evaluate(() => {
      const model = window.__infiniteMines.model;
      for (let radius = 1; radius < 100; radius += 1) {
        for (let y = -radius; y <= radius; y += 1) {
          for (let x = -radius; x <= radius; x += 1) {
            if (model.getState(x, y) === 0 && model.mineAt(x, y)) return { x, y };
          }
        }
      }
      throw new Error("No covered mine found");
    });
    const markedPoint = await worldPoint(page, markedMine);
    const healthBeforeMark = await page.evaluate(() => window.__infiniteMines.model.health);
    const framesBeforePreview = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
    await touchStart(markedPoint);
    await expect(page.locator("#touch-preview")).toBeHidden();
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBe(framesBeforePreview);
    await touchEnd();
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), markedMine)).toBe(10);
    expect(await page.evaluate(() => window.__infiniteMines.model.health)).toBe(healthBeforeMark);

    await touchStart(markedPoint);
    await expect(page.locator("#touch-preview")).toBeHidden();
    await page.waitForTimeout(470);
    await expect(page.locator("#touch-preview")).toBeHidden();
    await touchEnd();
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), markedMine)).toBe(10);

    await page.touchscreen.tap(markedPoint.x, markedPoint.y);
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), markedMine)).toBe(11);
    await touchStart(markedPoint);
    await expect(page.locator("#touch-preview")).toBeHidden();
    await page.waitForTimeout(470);
    await expect(page.locator("#touch-preview")).toBeVisible();
    await expect(page.locator("#touch-preview-action")).toHaveText("RELEASE TO REVEAL");
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), markedMine)).toBe(11);
    await touchEnd();
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), markedMine)).toBe(12);
    expect(await page.evaluate(() => window.__infiniteMines.model.health)).toBe(healthBeforeMark - 1);

    const explicitLocked = await findCell(page, "covered");
    const explicitLockedPoint = await worldPoint(page, explicitLocked);
    await page.touchscreen.tap(explicitLockedPoint.x, explicitLockedPoint.y);
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), explicitLocked)).toBe(10);
    await page.locator("#mobile-tool").click();
    await expect(page.locator("#mobile-tool")).toContainText("REVEAL");
    await expect(page.locator("#mobile-tool")).toHaveAttribute("aria-pressed", "true");
    await touchStart(explicitLockedPoint);
    await expect(page.locator("#touch-preview")).toBeHidden();
    await touchEnd();
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), explicitLocked)).toBe(10);
    const explicitReveal = await findCell(page, "covered-safe");
    const explicitPoint = await worldPoint(page, explicitReveal);
    await page.touchscreen.tap(explicitPoint.x, explicitPoint.y);
    await expect(page.locator("#touch-preview")).toBeHidden();
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), explicitReveal)).toBeGreaterThan(0);
  } finally {
    await session.detach();
    await context.close();
  }
});

test("R27/R44 — fatal mouse and touch input cannot choose game over, including hidden controls", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true, isMobile: false });
  const page = await context.newPage();
  try {
    await openDeterministicGame(page);
    await page.locator("#mobile-tool").click();
    expect(await page.evaluate(() => window.__infiniteMines.diagnostics().touchTool)).toBe("reveal");
    const cheatTarget = await gameOverActionCenter(page, "#cheat-death-button");
    const restartTarget = await gameOverActionCenter(page, "#game-over-restart-button");

    let mine = await alignFatalMine(page, cheatTarget);
    await page.keyboard.down("Control");
    await page.mouse.click(cheatTarget.x, cheatTarget.y);
    await page.keyboard.up("Control");
    await expect(page.locator("#game-over-screen")).toBeVisible();
    expect(await page.evaluate(() => window.__infiniteMines.model.cheats)).toBe(0);
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), mine)).toBe(12);
    await expect(page.getByRole("button", { name: /Cheat death/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#game-over-screen")).toBeHidden();

    mine = await alignFatalMine(page, cheatTarget);
    await page.touchscreen.tap(cheatTarget.x, cheatTarget.y);
    await expect(page.locator("#game-over-screen")).toBeVisible();
    expect(await page.evaluate(() => window.__infiniteMines.model.cheats)).toBe(0);
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), mine)).toBe(12);
    await page.touchscreen.tap(cheatTarget.x, cheatTarget.y);
    await expect(page.locator("#game-over-screen")).toBeHidden();
    expect(await page.evaluate(() => window.__infiniteMines.model.cheats)).toBe(1);

    mine = await alignFatalMine(page, restartTarget);
    await page.touchscreen.tap(restartTarget.x, restartTarget.y);
    await expect(page.locator("#game-over-screen")).toBeVisible();
    expect(await page.evaluate(() => window.__infiniteMines.model.cheats)).toBe(0);
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), mine)).toBe(12);
    await page.touchscreen.tap(cheatTarget.x, cheatTarget.y);
    await expect(page.locator("#game-over-screen")).toBeHidden();
    expect(await page.evaluate(() => window.__infiniteMines.model.cheats)).toBe(1);

    mine = await alignFatalMine(page, cheatTarget);
    await page.getByRole("button", { name: "Hide controls" }).click();
    await expect(page.locator("body")).toHaveClass(/ui-hidden/);
    await page.touchscreen.tap(cheatTarget.x, cheatTarget.y);
    await expect(page.locator("#game-over-screen")).toBeVisible();
    expect(await page.evaluate(() => window.__infiniteMines.model.cheats)).toBe(0);
    expect(await page.evaluate(({ x, y }) => window.__infiniteMines.model.getState(x, y), mine)).toBe(12);
    await page.touchscreen.tap(cheatTarget.x, cheatTarget.y);
    await expect(page.locator("#game-over-screen")).toBeHidden();
    await expect(page.getByRole("button", { name: "Show controls" })).toBeVisible();
    expect(await page.evaluate(() => window.__infiniteMines.model.cheats)).toBe(1);
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
    await expect(page.locator("#reveal-key")).toHaveText("⌘ + CLICK / DOUBLE-CLICK");
    await page.getByRole("button", { name: "Game settings" }).click();
    await expect(page.locator("#guarded-description")).toHaveText("Command (⌘) + click or double-click reveals");
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "How to play" }).click();
    await expect(page.locator("#help-guarded-description")).toContainText(
      "with Command (⌘) + click or double-click",
    );
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
  const hiddenHealth = page.locator("#hidden-health");
  await expect(hiddenHealth).toBeVisible();
  await expect(hiddenHealth).toHaveText("♥ 3");
  await expect(hiddenHealth).toHaveAttribute("aria-label", "3 health");
  await expect(hiddenHealth).toHaveCSS("opacity", "0.58");
  await expect(hiddenHealth).toHaveCSS("pointer-events", "none");
  await expect(page.locator("#hint")).toBeHidden();
  await expect(page.locator("#cell-locator")).toBeHidden();
  await expect(page.locator("#hover-overlay")).toBeVisible();
  expect(
    await page.locator("#game").evaluate((container) =>
      [...container.children]
        .filter((child) => getComputedStyle(child).display !== "none")
        .map((child) => child.id || child.className),
    ),
  ).toEqual(["board", "hover-overlay", "controls", "hidden-health"]);
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

  await page.evaluate(() => {
    const api = window.__infiniteMines;
    for (let y = 100; y < 200; y += 1) {
      for (let x = 100; x < 200; x += 1) {
        if (api.model.mineAt(x, y)) {
          api.reveal(x, y);
          return;
        }
      }
    }
    throw new Error("No mine found");
  });
  await expect(hiddenHealth).toHaveText("♥ 2");
  await expect(hiddenHealth).toHaveAttribute("aria-label", "2 health");

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
  await expect(hiddenHealth).toBeHidden();
  await expect(page.locator("#health-stat")).toHaveText("♥♥");
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
  const hoverBeforeAutoHide = await page.evaluate(() => window.__infiniteMines.renderer.hoverPreview);
  const visibleMarkersBeforeAutoHide = await page.locator("#hover-overlay .hover-cell.is-visible").count();
  expect(visibleMarkersBeforeAutoHide).toBeGreaterThan(0);
  await page.mouse.up({ button: "right" });
  await expect(restart).toBeHidden();
  await expect(page.getByRole("button", { name: "Show controls" })).toBeVisible();
  await expect(page.locator("#hover-overlay")).toBeVisible();
  await expect(page.locator("#hover-overlay .hover-cell.is-visible")).toHaveCount(visibleMarkersBeforeAutoHide);
  expect(await page.evaluate(() => window.__infiniteMines.renderer.hoverPreview)).toEqual(hoverBeforeAutoHide);
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
