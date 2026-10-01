import { expect, test } from "@playwright/test";
import { CellState } from "../../src/model";
import { openDeterministicGame } from "./helpers";

test("R57 — batched cells match instanced pixels across themes, topologies, rotation, zoom, and DPR", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  let comparisons = 0;
  const errors: string[] = [];
  for (const deviceScaleFactor of [1, 1.5, 2]) {
    const context = await browser.newContext({ viewport: { width: 480, height: 360 }, deviceScaleFactor });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    try {
      await openDeterministicGame(page);
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
        for (const topology of ["square", "hexagonal", "triangular", "rhombille"] as const) {
          const result = await page.evaluate(async ({ topology, flagged, question, exploded }) => {
            const { model, renderer } = window.__infiniteMines;
            const internal = renderer as unknown as { batchDetail: boolean; cellDataFits: boolean; thingSpriteLoads: Map<number, Promise<unknown>> };
            const privateModel = model as unknown as { artifactForZone(x: number, y: number): { x: number; y: number } };
            model.reset("beginner", 0x555123, false, topology, undefined, true);
            for (let y = -12; y <= 12; y += 1) {
              for (let x = -12; x <= 12; x += 1) {
                if ((x + y) % 5 === 0) continue;
                model.store.set(x, y, ((x * x + y * y) % 9 + 1) as CellState);
              }
            }
            model.store.set(-3, 0, flagged);
            model.store.set(0, 0, question);
            model.store.set(3, 0, exploded);
            for (let y = -1; y <= 1; y += 1) {
              for (let x = -1; x <= 1; x += 1) {
                const anchor = privateModel.artifactForZone(x, y);
                const visual = model.thingVisualAt(anchor.x, anchor.y);
                if (!visual) throw new Error("Missing Thing fixture");
                for (const cell of visual.reservedCells) model.store.set(cell.x, cell.y, 1);
              }
            }
            renderer.restoreView({ version: 1, zoom: 8 / 25, panX: 0.27, panY: -0.61 });
            renderer.render();
            await renderer.waitForThingSprites();
            await Promise.all([...internal.thingSpriteLoads.values()]);
            const gl = renderer.gl;
            const pixels = () => {
              const buffer = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
              gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
              return buffer;
            };
            let comparisons = 0;
            const mismatches: string[] = [];
            renderer.render();
            const loadedSprites = renderer.diagnostics.thingSpritesLoaded;
            const version = model.store.version;
            for (const rotation of [0, 90, 180, 270] as const) {
              renderer.setRotation(rotation);
              for (const size of [1, 4, 4.125, 6, 8, 25]) {
                renderer.setFogFrontierMode(size === 4.125 ? "off" : size === 6 ? "edge" : "cell");
                renderer.restoreView({ version: 1, zoom: size / 25, panX: 0.27, panY: -0.61 });
                renderer.render();
                await Promise.all([...internal.thingSpriteLoads.values()]);
                internal.batchDetail = false;
                renderer.render();
                const reference = pixels();
                internal.batchDetail = true;
                renderer.render();
                const actual = pixels();
                let different = 0;
                for (let index = 0; index < reference.length; index += 1) {
                  if (reference[index] !== actual[index]) different += 1;
                }
                if (different) mismatches.push(`${rotation}/${size}: ${different} channels`);
                if (!internal.cellDataFits || renderer.diagnostics.drawCalls !== 1 || gl.getError() !== gl.NO_ERROR) {
                  mismatches.push(`${rotation}/${size}: missing batch or WebGL error`);
                }
                comparisons += 1;
              }
            }
            // Force the capacity fallback and compare it with the successful batch.
            renderer.render();
            const batched = pixels();
            internal.cellDataFits = false;
            renderer.render();
            const fallback = pixels();
            if (batched.some((value, index) => value !== fallback[index])) mismatches.push("capacity fallback");
            internal.cellDataFits = true;
            return { comparisons, mismatches, loadedSprites, unchangedModel: version === model.store.version };
          }, { topology, flagged: CellState.Flagged, question: CellState.Question, exploded: CellState.Exploded });
          expect(result.mismatches, `${colorScheme}/${topology}/${deviceScaleFactor}`).toEqual([]);
          expect(result.loadedSprites).toBeGreaterThan(0);
          expect(result.unchangedModel).toBe(true);
          comparisons += result.comparisons;
        }
      }
    } finally {
      await context.close();
    }
  }
  expect(comparisons).toBe(576);
  expect(errors).toEqual([]);
  await testInfo.attach("batched-framebuffer-parity", { body: JSON.stringify({ comparisons }), contentType: "application/json" });
});
