import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openDeterministicGame } from "./helpers";

test("R05/R07 — polished light and dark themes follow browser hints live", async ({ page }) => {
  await openDeterministicGame(page);
  expect(await page.locator('meta[name="color-scheme"]').getAttribute("content")).toBe("light dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
  expect(await page.locator('meta[name="theme-color"][media*="light"]')).toHaveAttribute("content", "#fbfaf6");
  expect(await page.locator('meta[name="theme-color"][media*="dark"]')).toHaveAttribute("content", "#151b1e");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toContain("light");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toContain("dark");

  const light = await page.evaluate(() => ({
    seed: window.__infiniteMines.model.seed,
    css: getComputedStyle(document.documentElement).getPropertyValue("--board-bg").trim(),
    renderer: window.__infiniteMines.diagnostics().backgroundColor,
  }));
  expect(light.css).toBe("#f4f1e9");
  expect(light.renderer).toBe(light.css);
  const lightAudit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(lightAudit.violations).toEqual([]);
  await expect(page).toHaveScreenshot("desktop-light.png", { animations: "disabled" });

  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().backgroundColor))
    .toBe("#0d1214");
  const dark = await page.evaluate(() => ({
    seed: window.__infiniteMines.model.seed,
    css: getComputedStyle(document.documentElement).getPropertyValue("--board-bg").trim(),
    renderer: window.__infiniteMines.diagnostics().backgroundColor,
  }));
  expect(dark.seed).toBe(light.seed);
  expect(dark.css).toBe("#0d1214");
  expect(dark.renderer).toBe(dark.css);
  const darkAudit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(darkAudit.violations).toEqual([]);
  await expect(page).toHaveScreenshot("desktop-dark.png", { animations: "disabled" });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator("#mobile-tool")).toBeVisible();
  await expect(page.locator("#hint")).toBeHidden();
  const mobileAudit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(mobileAudit.violations).toEqual([]);
  await expect(page).toHaveScreenshot("mobile-light-settings.png", { animations: "disabled" });
});
