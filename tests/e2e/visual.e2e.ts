import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openDeterministicGame } from "./helpers";

test("R05/R07 — polished light and dark themes follow browser hints live", async ({ page }) => {
  await openDeterministicGame(page);
  expect(await page.locator('meta[name="color-scheme"]').getAttribute("content")).toBe("light dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
  expect(await page.locator('meta[name="theme-color"][media*="light"]')).toHaveAttribute("content", "#fbfaf6");
  expect(await page.locator('meta[name="theme-color"][media*="dark"]')).toHaveAttribute("content", "#151b1e");
  await expect(page.locator("html")).toHaveAttribute("data-theme-mode", "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");

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
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  const darkAudit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(darkAudit.violations).toEqual([]);
  await expect(page).toHaveScreenshot("desktop-dark.png", { animations: "disabled" });

  await page.getByRole("button", { name: "Game settings" }).click();
  const systemTheme = page.locator('#theme-options [data-theme-mode="system"]');
  const lightTheme = page.locator('#theme-options [data-theme-mode="light"]');
  const darkTheme = page.locator('#theme-options [data-theme-mode="dark"]');
  await expect(systemTheme).toHaveAttribute("aria-pressed", "true");
  await lightTheme.click();
  await expect(lightTheme).toHaveAttribute("aria-pressed", "true");
  await page.locator("#settings-dialog").getByRole("button", { name: "Close" }).click();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().backgroundColor)).toBe("#f4f1e9");
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics())).toMatchObject({ themeMode: "light", theme: "light" });
  expect(await page.evaluate(() => window.__infiniteMines.model.seed)).toBe(light.seed);
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-theme"))).toBe("light");
  await expect(page.locator('#color-scheme')).toHaveAttribute("content", "light");
  await expect(page.locator('#theme-color-light')).toHaveAttribute("media", "all");
  await expect(page.locator('#theme-color-dark')).toHaveAttribute("media", "not all");

  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().backgroundColor)).toBe("#f4f1e9");
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().backend)).toBe("webgl2");
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics())).toMatchObject({ themeMode: "light", theme: "light" });
  expect(await page.evaluate(() => window.__infiniteMines.model.seed)).toBe(light.seed);

  await page.getByRole("button", { name: "Game settings" }).click();
  await darkTheme.click();
  await page.locator("#settings-dialog").getByRole("button", { name: "Close" }).click();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().backgroundColor)).toBe("#0d1214");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics())).toMatchObject({ themeMode: "dark", theme: "dark" });

  await page.getByRole("button", { name: "Game settings" }).click();
  await systemTheme.click();
  await page.locator("#settings-dialog").getByRole("button", { name: "Close" }).click();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().backgroundColor)).toBe("#f4f1e9");
  expect(await page.evaluate(() => localStorage.getItem("infinite-mines-theme"))).toBe("system");
  await expect(page.locator('#color-scheme')).toHaveAttribute("content", "light dark");
  await expect(page.locator('#theme-color-light')).toHaveAttribute("media", "(prefers-color-scheme: light)");
  await expect(page.locator('#theme-color-dark')).toHaveAttribute("media", "(prefers-color-scheme: dark)");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().backgroundColor)).toBe("#0d1214");

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.diagnostics().backgroundColor)).toBe("#f4f1e9");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Game settings" }).click();
  await expect(page.locator("#mobile-tool")).toBeVisible();
  await expect(page.locator("#hint")).toBeHidden();
  const mobileAudit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(mobileAudit.violations).toEqual([]);
  await expect(page).toHaveScreenshot("mobile-light-settings.png", { animations: "disabled" });
});
