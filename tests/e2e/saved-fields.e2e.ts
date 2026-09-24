import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openDeterministicGame } from "./helpers";

test("R53 — Saved fields presents exact automatic history with keep, resume, and guarded delete", async ({ page }) => {
  await openDeterministicGame(page, 0x53a7_0001);
  const archived = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    api.model.cycleMark(531, 532);
    api.renderer.restoreView({ version: 1, panX: 137.25, panY: -82.5, zoom: 1.35 });
    await api.flushSave();
    const seed = api.model.seed;
    const id = api.diagnostics().activeSavedFieldId;
    api.newGame();
    await api.listSavedFields();
    return { seed, id };
  });

  await page.getByRole("button", { name: "Saved fields" }).click();
  await expect(page.locator("#fields-dialog")).toBeVisible();
  await expect(page.locator(".field-card")).toHaveCount(2);
  await expect(page.locator(".fields-section").filter({ hasText: "Current" }).locator(".field-card")).toHaveCount(1);
  const recentCard = page.locator(`.field-card[data-field-id="${archived.id}"]`);
  await expect(recentCard).toContainText("Square · beginner");
  await recentCard.getByRole("button", { name: "KEEP" }).click();
  const keptCard = page.locator(`.field-card[data-field-id="${archived.id}"]`);
  await expect(keptCard.getByRole("button", { name: "RELEASE" })).toBeVisible();
  await expect(keptCard.locator("canvas")).toBeVisible();

  const audit = await new AxeBuilder({ page }).include("#fields-dialog").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(audit.violations).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkAudit = await new AxeBuilder({ page }).include("#fields-dialog").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(darkAudit.violations).toEqual([]);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1000, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    const bounds = await page.locator("#fields-dialog").evaluate((dialog) => ({
      left: dialog.getBoundingClientRect().left,
      right: dialog.getBoundingClientRect().right,
      viewport: document.documentElement.clientWidth,
      overflow: dialog.scrollWidth - dialog.clientWidth,
    }));
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
    expect(bounds.overflow).toBeLessThanOrEqual(1);
  }

  await keptCard.getByRole("button", { name: "RESUME" }).click();
  await expect(page.locator("#fields-dialog")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines.model.seed)).toBe(archived.seed);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().canvasCount)).toBe(3);
  expect(await page.evaluate(() => window.__infiniteMines.model.getState(531, 532))).toBe(10);
  expect(await page.evaluate(() => window.__infiniteMines.renderer.createViewSnapshot())).toEqual({
    version: 1,
    panX: 137.25,
    panY: -82.5,
    zoom: 1.35,
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.model.seed)).toBe(archived.seed);
  await page.getByRole("button", { name: "Saved fields" }).click();
  const current = page.locator(".field-card[data-current=true]");
  await expect(current.getByRole("button", { name: "RELEASE" })).toBeVisible();
  await expect(current.getByRole("button", { name: /delete/i })).toHaveCount(0);
  const deletable = page.locator(".field-card:not([data-current=true])").first();
  await deletable.getByRole("button", { name: "DELETE" }).click();
  await expect(deletable.getByRole("button", { name: "Confirm delete saved field" })).toBeVisible();
  await deletable.getByRole("button", { name: "Confirm delete saved field" }).click();
  await expect(page.locator(".field-card")).toHaveCount(1);
  expect(await page.evaluate(() => window.__infiniteMines.listSavedFields().then((fields) => fields.length))).toBe(1);
});

test("R53 — retention keeps 20 recent fields plus every explicitly kept field", async ({ page }) => {
  await openDeterministicGame(page, 0x53a7_0002);
  await page.evaluate(() => window.__infiniteMines.flushSave());
  await page.getByRole("button", { name: "Saved fields" }).click();
  await page.locator(".field-card[data-current=true]").getByRole("button", { name: "KEEP" }).click();
  await expect(page.locator(".field-card[data-current=true]").getByRole("button", { name: "RELEASE" })).toBeVisible();
  await page.locator("#fields-close").click();

  const retention = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    for (let index = 0; index < 24; index += 1) api.newGame();
    const fields = await api.listSavedFields();
    return {
      total: fields.length,
      pinned: fields.filter((field) => field.pinned).length,
      unpinned: fields.filter((field) => !field.pinned).length,
      uniqueIds: new Set(fields.map((field) => field.id)).size,
      currentPresent: fields.some((field) => field.id === api.diagnostics().activeSavedFieldId),
    };
  });
  expect(retention).toEqual({ total: 21, pinned: 1, unpinned: 20, uniqueIds: 21, currentPresent: true });
});

test("R53 — legacy per-combination slots migrate without losing inactive fields", async ({ page }) => {
  await openDeterministicGame(page, 0x53a7_0003);
  await page.evaluate(async () => {
    const api = window.__infiniteMines;
    await api.flushSave();
    const [base] = await api.listSavedFields();
    if (!base) throw new Error("Expected an initial saved field");
    const beginner = { version: 1, savedAt: base.savedAt, model: { ...base.model, mode: "beginner", density: 0.19 }, view: base.view };
    const master = { version: 1, savedAt: base.savedAt + 1, model: { ...base.model, mode: "master", density: 0.23 }, view: base.view };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("infinite-mines", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction("sessions", "readwrite");
        const store = transaction.objectStore("sessions");
        store.clear();
        store.put(beginner, "field:square:beginner:things");
        store.put(master, "field:square:master:things");
        store.put({ version: 1, topology: "square", mode: "master", thingsEnabled: true }, "active-slot");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().persistenceStatus)).toBe("restored");
  expect(await page.evaluate(() => window.__infiniteMines.model.mode)).toBe("master");
  const migrated = await page.evaluate(async () => {
    const fields = await window.__infiniteMines.listSavedFields();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const open = indexedDB.open("infinite-mines", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const request = open.result.transaction("sessions").objectStore("sessions").getAllKeys();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      };
    });
    return { modes: fields.map((field) => field.model.mode).sort(), keys };
  });
  expect(migrated.modes).toEqual(["beginner", "master"]);
  expect(migrated.keys).toContain("active-field");
  expect(migrated.keys.filter((key) => typeof key === "string" && key.startsWith("run:"))).toHaveLength(2);
  expect(migrated.keys.some((key) => typeof key === "string" && (key === "active-slot" || key.startsWith("field:")))).toBe(false);
});
