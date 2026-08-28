import { expect, test } from "@playwright/test";
import { openDeterministicGame } from "./helpers";

interface Distribution {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

interface ScenarioResult {
  inputMs: Distribution;
  frameIntervalMs: Distribution;
  renderMs: Distribution;
  webglFrames: number;
  instanceUploads: number;
  longTasks: number;
  longTaskMs: number;
}

test("R21 — production interaction benchmark stays within the performance contract", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await openDeterministicGame(page);
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const readMetrics = async (): Promise<Record<string, number>> => {
    const response = await session.send("Performance.getMetrics");
    return Object.fromEntries(response.metrics.map(({ name, value }) => [name, value]));
  };
  const metricsBefore = await readMetrics();

  const report = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    const canvas = document.querySelector<HTMLCanvasElement>("#board");
    if (!canvas) throw new Error("Missing board");
    canvas.setPointerCapture = () => undefined;

    const distribution = (samples: number[]): Distribution => {
      if (samples.length === 0) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
      const sorted = [...samples].sort((a, b) => a - b);
      const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
      return {
        count: sorted.length,
        mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        max: sorted[sorted.length - 1],
      };
    };
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const runFrames = async (
      frames: number,
      step: (frame: number) => void,
      finish?: () => void,
    ): Promise<ScenarioResult> => {
      await settle();
      const before = api.diagnostics();
      const inputSamples: number[] = [];
      const frameIntervals: number[] = [];
      const renderSamples: number[] = [];
      let priorTimestamp = 0;
      let priorRenderFrame = before.frameCount;
      let longTasks = 0;
      let longTaskMs = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks += 1;
          longTaskMs += entry.duration;
        }
      });
      try {
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        // Older engines can still run the timing and architectural checks.
      }

      await new Promise<void>((resolve) => {
        let frame = 0;
        const tick = (timestamp: number) => {
          if (priorTimestamp > 0) frameIntervals.push(timestamp - priorTimestamp);
          priorTimestamp = timestamp;
          const diagnostics = api.diagnostics();
          if (diagnostics.frameCount !== priorRenderFrame) {
            renderSamples.push(diagnostics.frameMs);
            priorRenderFrame = diagnostics.frameCount;
          }
          const startedAt = performance.now();
          step(frame);
          inputSamples.push(performance.now() - startedAt);
          frame += 1;
          if (frame < frames) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      finish?.();
      await settle();
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      observer.disconnect();
      const after = api.diagnostics();
      if (after.frameCount !== priorRenderFrame) renderSamples.push(after.frameMs);
      return {
        inputMs: distribution(inputSamples),
        frameIntervalMs: distribution(frameIntervals),
        renderMs: distribution(renderSamples),
        webglFrames: after.frameCount - before.frameCount,
        instanceUploads: after.instanceUploads - before.instanceUploads,
        longTasks,
        longTaskMs,
      };
    };

    renderer.home();
    await settle();
    const bounds = canvas.getBoundingClientRect();
    const hoverDetail = await runFrames(120, (frame) => {
      canvas.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: bounds.left + 100 + frame * 3,
          clientY: bounds.top + 300,
          pointerId: 31,
          pointerType: "mouse",
        }),
      );
    });

    renderer.zoom = 0.04;
    renderer.requestRender();
    await settle();
    const hoverPixel = await runFrames(120, (frame) => {
      canvas.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: bounds.left + 100 + frame * 3,
          clientY: bounds.top + 300,
          pointerId: 32,
          pointerType: "mouse",
        }),
      );
    });

    renderer.home();
    await settle();
    const dragStartX = bounds.left + 500;
    const dragStartY = bounds.top + 400;
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: dragStartX,
        clientY: dragStartY,
        pointerId: 33,
        pointerType: "mouse",
      }),
    );
    const drag = await runFrames(
      120,
      (frame) => {
        canvas.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            button: 0,
            buttons: 1,
            clientX: dragStartX + frame + 1,
            clientY: dragStartY,
            pointerId: 33,
            pointerType: "mouse",
          }),
        );
      },
      () => {
        canvas.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            button: 0,
            clientX: dragStartX + 120,
            clientY: dragStartY,
            pointerId: 33,
            pointerType: "mouse",
          }),
        );
      },
    );

    renderer.home();
    await settle();
    const pinchCenterX = bounds.left + bounds.width / 2;
    const pinchCenterY = bounds.top + bounds.height / 2;
    const touchEvent = (type: "pointerdown" | "pointermove" | "pointerup", pointerId: number, x: number, y: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
          pointerId,
          pointerType: "touch",
        }),
      );
    touchEvent("pointerdown", 41, pinchCenterX - 50, pinchCenterY);
    touchEvent("pointerdown", 42, pinchCenterX + 50, pinchCenterY);
    const pinch = await runFrames(
      90,
      (frame) => {
        const spread = 50 + frame * 0.45;
        const shiftX = frame * 0.2;
        touchEvent("pointermove", 41, pinchCenterX - spread + shiftX, pinchCenterY);
        touchEvent("pointermove", 42, pinchCenterX + spread + shiftX, pinchCenterY);
      },
      () => {
        touchEvent("pointerup", 41, pinchCenterX - 90, pinchCenterY);
        touchEvent("pointerup", 42, pinchCenterX + 90, pinchCenterY);
      },
    );

    renderer.home();
    await settle();
    const zoom = await runFrames(90, (frame) => {
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
          deltaY: frame % 2 === 0 ? 40 : -40,
        }),
      );
    });

    renderer.home();
    api.model.reset("beginner", 0x5eed_1234, false);
    renderer.requestRender();
    await settle();
    const target = { x: 0, y: 0 };
    const targetX = bounds.left + bounds.width / 2 + target.x * renderer.cellSize;
    const targetY = bounds.top + bounds.height / 2 + target.y * renderer.cellSize;
    const openedBefore = api.diagnostics().openedCells;
    const revealStartedAt = performance.now();
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        ctrlKey: true,
        clientX: targetX,
        clientY: targetY,
        pointerId: 34,
        pointerType: "mouse",
      }),
    );
    canvas.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        ctrlKey: true,
        clientX: targetX,
        clientY: targetY,
        pointerId: 34,
        pointerType: "mouse",
      }),
    );
    const revealInputMs = performance.now() - revealStartedAt;
    await settle();
    const openedByReveal = api.diagnostics().openedCells - openedBefore;
    const saveStartedAt = performance.now();
    await api.flushSave();
    const saveMs = performance.now() - saveStartedAt;

    const idleFramesBefore = api.diagnostics().frameCount;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    const idleFrames = api.diagnostics().frameCount - idleFramesBefore;
    const gl = renderer.gl;
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
    return {
      environment: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        devicePixelRatio: window.devicePixelRatio,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        webglRenderer: String(
          gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        ),
      },
      hoverDetail,
      hoverPixel,
      drag,
      pinch,
      zoom,
      reveal: { inputMs: revealInputMs, openedCells: openedByReveal },
      saveMs,
      idleFrames,
    };
  });

  const metricsAfter = await readMetrics();
  await session.detach();
  const metricNames = [
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "LayoutCount",
    "RecalcStyleCount",
    "JSHeapUsedSize",
    "Nodes",
  ];
  const browserMetricDelta = Object.fromEntries(
    metricNames.map((name) => [name, (metricsAfter[name] ?? 0) - (metricsBefore[name] ?? 0)]),
  );
  const completeReport = { ...report, browserMetricDelta };
  console.log(`\nPERF_BENCHMARK ${JSON.stringify(completeReport, null, 2)}`);
  await testInfo.attach("performance-benchmark.json", {
    body: JSON.stringify(completeReport, null, 2),
    contentType: "application/json",
  });

  for (const scenario of [report.hoverDetail, report.hoverPixel, report.drag, report.pinch, report.zoom]) {
    expect(scenario.inputMs.p95).toBeLessThan(8);
    expect(scenario.frameIntervalMs.p95).toBeLessThan(35);
    expect(scenario.longTasks).toBe(0);
  }
  expect(report.hoverDetail.webglFrames).toBe(0);
  expect(report.hoverDetail.instanceUploads).toBe(0);
  expect(report.hoverPixel.webglFrames).toBe(0);
  expect(report.hoverPixel.instanceUploads).toBe(0);
  expect(report.pinch.instanceUploads).toBeLessThanOrEqual(2);
  expect(report.zoom.instanceUploads).toBeLessThanOrEqual(2);
  expect(report.drag.renderMs.p95).toBeLessThan(12);
  expect(report.zoom.renderMs.p95).toBeLessThan(12);
  expect(report.reveal.inputMs).toBeLessThan(100);
  expect(report.reveal.openedCells).toBeGreaterThanOrEqual(25);
  expect(report.saveMs).toBeLessThan(100);
  expect(report.idleFrames).toBe(0);
  expect(browserMetricDelta.LayoutCount).toBeLessThan(100);
  expect(browserMetricDelta.RecalcStyleCount).toBeLessThan(220);
  expect(browserMetricDelta.TaskDuration).toBeLessThan(1);
});

test("R24 — interaction cost stays bounded with a densely revealed field", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await openDeterministicGame(page);

  const report = await page.evaluate(async () => {
    const api = window.__infiniteMines;
    const renderer = api.renderer;
    const canvas = document.querySelector<HTMLCanvasElement>("#board");
    if (!canvas) throw new Error("Missing board");
    canvas.setPointerCapture = () => undefined;

    const percentile = (samples: number[], fraction: number) => {
      if (samples.length === 0) return 0;
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    };
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const measureFrames = async (frames: number, step: (frame: number) => void, finish?: () => void) => {
      await settle();
      const before = api.diagnostics();
      const input: number[] = [];
      const intervals: number[] = [];
      const renders: number[] = [];
      let previousTime = 0;
      let previousRender = before.frameCount;
      let longTasks = 0;
      const observer = new PerformanceObserver((list) => {
        longTasks += list.getEntries().length;
      });
      try {
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        // The bundled browser supports this; timing assertions remain useful elsewhere.
      }
      await new Promise<void>((resolve) => {
        let frame = 0;
        const tick = (timestamp: number) => {
          if (previousTime > 0) intervals.push(timestamp - previousTime);
          previousTime = timestamp;
          const diagnostics = api.diagnostics();
          if (diagnostics.frameCount !== previousRender) {
            renders.push(diagnostics.frameMs);
            previousRender = diagnostics.frameCount;
          }
          const startedAt = performance.now();
          step(frame);
          input.push(performance.now() - startedAt);
          frame += 1;
          if (frame < frames) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      finish?.();
      await settle();
      observer.disconnect();
      const after = api.diagnostics();
      if (after.frameCount !== previousRender) renders.push(after.frameMs);
      return {
        inputP95: percentile(input, 0.95),
        frameP95: percentile(intervals, 0.95),
        renderP95: percentile(renders, 0.95),
        webglFrames: after.frameCount - before.frameCount,
        instanceUploads: after.instanceUploads - before.instanceUploads,
        longTasks,
      };
    };

    const runField = async (width: number, height: number) => {
      api.model.reset("beginner", 0x5eed_1234, false);
      const populateStartedAt = performance.now();
      const minX = -Math.floor(width / 2);
      const minY = -Math.floor(height / 2);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) api.model.store.set(minX + x, minY + y, 2);
      }
      const populateMs = performance.now() - populateStartedAt;
      renderer.home();
      renderer.zoom = 0.08;
      renderer.requestRender();
      await settle();
      const initial = api.diagnostics();
      const bounds = canvas.getBoundingClientRect();

      const pan = await measureFrames(
        90,
        () => renderer.panBy(0.5, 0),
        () => renderer.finishPan(),
      );
      const zoomFactor = 1.004;
      const zoom = await measureFrames(90, (frame) => {
        renderer.zoomAt(
          bounds.width / 2,
          bounds.height / 2,
          frame % 2 === 0 ? zoomFactor : 1 / zoomFactor,
        );
      });
      const hover = await measureFrames(90, (frame) => {
        canvas.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            clientX: bounds.left + 200 + frame * 2,
            clientY: bounds.top + bounds.height / 2,
            pointerId: 80,
            pointerType: "mouse",
          }),
        );
      });
      const interaction = await measureFrames(90, (frame) => {
        const pointerId = 100 + frame;
        const init = {
          bubbles: true,
          button: 0,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
          pointerId,
          pointerType: "mouse",
        };
        canvas.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
        canvas.dispatchEvent(new PointerEvent("pointerup", init));
      });
      return { populateMs, initial, pan, zoom, hover, interaction };
    };

    const small = await runField(32, 32);
    const large = await runField(384, 256);
    return { small, large };
  });

  console.log(`\nSCALE_BENCHMARK ${JSON.stringify(report, null, 2)}`);
  await testInfo.attach("revealed-field-scale-benchmark.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });

  expect(report.small.initial.storedCells).toBe(1_024);
  expect(report.large.initial.storedCells).toBe(98_304);
  expect(report.large.initial.drawnCells).toBe(98_304);
  expect(report.large.initial.lod).toBe("pixel");
  for (const name of ["pan", "zoom", "hover", "interaction"] as const) {
    const small = report.small[name];
    const large = report.large[name];
    expect(large.inputP95).toBeLessThan(8);
    expect(large.frameP95).toBeLessThan(35);
    expect(large.renderP95).toBeLessThan(12);
    expect(large.longTasks).toBe(0);
    expect(large.inputP95).toBeLessThanOrEqual(small.inputP95 + 2);
    expect(large.frameP95).toBeLessThanOrEqual(small.frameP95 + 8);
    expect(large.renderP95).toBeLessThanOrEqual(small.renderP95 + 4);
  }
  expect(report.large.pan.instanceUploads).toBe(0);
  expect(report.large.zoom.instanceUploads).toBe(0);
  expect(report.large.hover.webglFrames).toBe(0);
  expect(report.large.hover.instanceUploads).toBe(0);
  expect(report.large.interaction.instanceUploads).toBe(0);
});

test("R33 — the FPS counter observes active rendering without keeping the renderer awake", async ({ page }) => {
  await openDeterministicGame(page);
  const counter = page.locator("#fps-counter");
  const value = page.locator("#fps-value");
  await expect(counter).toBeVisible();
  await expect(value).toHaveText("IDLE");
  const idleFrames = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBe(idleFrames);

  const active = await page.evaluate(
    () =>
      new Promise<{ fps: number | null; text: string }>((resolve) => {
        const renderer = window.__infiniteMines.renderer;
        let frame = 0;
        const step = () => {
          renderer.panBy(frame % 2 === 0 ? 1 : -1, 0);
          frame += 1;
          if (frame < 30) requestAnimationFrame(step);
          else {
            renderer.finishPan();
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                resolve({
                  fps: window.__infiniteMines.diagnostics().fps,
                  text: document.querySelector("#fps-value")?.textContent ?? "",
                }),
              ),
            );
          }
        };
        requestAnimationFrame(step);
      }),
  );
  expect(active.fps).not.toBeNull();
  expect(active.fps!).toBeGreaterThan(0);
  expect(active.text).toMatch(/^\d{1,3}$/);

  await expect(value).toHaveText("IDLE");
  const settledFrames = await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount);
  await page.mouse.move(300, 300);
  await page.mouse.move(301, 300, { steps: 20 });
  await page.waitForTimeout(250);
  expect(await value.textContent()).toBe("IDLE");
  expect(await page.evaluate(() => window.__infiniteMines.diagnostics().frameCount)).toBe(settledFrames);
});
