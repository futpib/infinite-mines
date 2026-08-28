import { expect, type Page } from "@playwright/test";

export interface WorldCell {
  x: number;
  y: number;
}

export async function openDeterministicGame(page: Page, seed = 0x5eed_1234): Promise<void> {
  await page.addInitScript((fixedSeed) => {
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: (array: Uint32Array) => {
        array.fill(fixedSeed);
        return array;
      },
    });
  }, seed);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__infiniteMines?.diagnostics().backend)).toBe("webgl2");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function findCell(
  page: Page,
  kind: "covered-safe" | "covered" | "opened" | "flagged",
): Promise<WorldCell> {
  return page.evaluate((requestedKind) => {
    const model = window.__infiniteMines.model;
    for (let radius = 0; radius < 200; radius += 1) {
      for (let y = -radius; y <= radius; y += 1) {
        for (let x = -radius; x <= radius; x += 1) {
          const state = model.getState(x, y);
          if (requestedKind === "covered-safe" && state === 0 && !model.mineAt(x, y)) return { x, y };
          if (requestedKind === "covered" && state === 0) return { x, y };
          if (requestedKind === "opened" && state >= 1 && state <= 9) return { x, y };
          if (requestedKind === "flagged" && state === 10) return { x, y };
        }
      }
    }
    throw new Error(`Unable to find ${requestedKind} cell`);
  }, kind);
}

export async function worldPoint(page: Page, cell: WorldCell): Promise<{ x: number; y: number }> {
  const bounds = await page.locator("#board").boundingBox();
  if (!bounds) throw new Error("Board is not visible");
  const center = await page.evaluate(({ x, y }) => {
    const polygon = window.__infiniteMines.renderer.cellScreenPolygon(x, y);
    return {
      x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
      y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
    };
  }, cell);
  return {
    x: bounds.x + center.x,
    y: bounds.y + center.y,
  };
}

export function hexToRgb(color: string): number[] {
  const value = color.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}
