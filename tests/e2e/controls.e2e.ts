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
