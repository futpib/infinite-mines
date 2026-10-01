// Compare two served production builds in balanced ABBA order, without changing
// render quality. Run separately from the test suite or other GPU benchmarks.
import { chromium } from '@playwright/test';

const [baselineUrl, candidateUrl, ...requestedTopologies] = process.argv.slice(2);
if (!baselineUrl || !candidateUrl) throw new Error('Usage: node scripts/benchmark-zoom.mjs BASELINE_URL CANDIDATE_URL [square hexagonal triangular rhombille]');
const topologies = requestedTopologies.length ? requestedTopologies : ['square'];
const browser = await chromium.launch();
try {
  for (const [build, url] of [['baseline', baselineUrl], ['candidate', candidateUrl], ['candidate', candidateUrl], ['baseline', baselineUrl]]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url);
    await page.waitForFunction(() => window.__infiniteMines?.diagnostics().thingSpritesReady);
    const bundle = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.src));
    for (const topology of topologies) {
      const report = await page.evaluate(async topology => {
        performance.setResourceTimingBufferSize(10000);
        const { model, renderer } = window.__infiniteMines;
        const canvas = renderer.canvas;
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const settled = async () => {
          for (let attempt = 0; attempt < 100; attempt++) {
            await Promise.all([...renderer.thingSpriteLoads.values()]);
            await frame(); await frame();
            if (renderer.thingSpriteLoads.size === 0) return;
          }
          throw new Error('Artwork did not settle');
        };
        model.reset('beginner', 0x555123, false, topology, undefined, true);
        let things = 0;
        for (let y = -5; y <= 5; y++) for (let x = -6; x <= 6; x++) {
          const anchor = model.artifactForZone(x, y);
          const visual = model.thingVisualAt(anchor.x, anchor.y);
          if (!visual) throw new Error('Missing Thing fixture');
          things++;
          for (const cell of visual.reservedCells) model.store.set(cell.x, cell.y, 1);
        }
        renderer.restoreView({ version: 1, zoom: 8.2 / 25, panX: 0, panY: 0 });
        await settled();
        const version = model.store.version;
        const requestCount = () => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/things/')).length;
        const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
        const sweep = async () => {
          const before = renderer.diagnostics;
          const requestsBefore = requestCount();
          const samples = [];
          for (let index = 0; index < 40; index++) {
            const size = index < 20 ? 8.2 - 4.4 * index / 19 : 3.8 + 4.4 * (index - 20) / 19;
            const start = await frame();
            canvas.dispatchEvent(new WheelEvent('wheel', {
              bubbles: true, cancelable: true, clientX: 720, clientY: 450,
              deltaY: -Math.log(size / renderer.cellSize) / 0.0012,
            }));
            const end = await frame();
            const diagnostics = renderer.diagnostics;
            samples.push({ size: diagnostics.cellSize, frameMs: end - start, cpuMs: diagnostics.frameMs });
            if (Math.abs(diagnostics.cellSize - size) > 1e-8 || diagnostics.drawCalls !== 1) throw new Error('Zoom or draw invariant changed');
          }
          return {
            frameP50: percentile(samples.map(sample => sample.frameMs), .5),
            frameP95: percentile(samples.map(sample => sample.frameMs), .95),
            cpuP95: percentile(samples.map(sample => sample.cpuMs), .95),
            uploads: renderer.diagnostics.instanceUploads - before.instanceUploads,
            newArtworkRequests: requestCount() - requestsBefore,
            samples,
          };
        };
        const cold = await sweep();
        await settled();
        const warm = await sweep();
        await settled();
        const beforeIdle = renderer.diagnostics.frameCount;
        await new Promise(resolve => setTimeout(resolve, 250));
        if (model.store.version !== version) throw new Error('Zoom mutated the field');
        if (renderer.diagnostics.frameCount !== beforeIdle) throw new Error('Renderer did not return to idle');
        const gpu = renderer.gl.getExtension('WEBGL_debug_renderer_info');
        return { topology, things, storedCells: model.store.nonZeroCells, gpu: gpu ? renderer.gl.getParameter(gpu.UNMASKED_RENDERER_WEBGL) : null, cold, warm };
      }, topology);
      if (errors.length) throw new Error(errors.join('\n'));
      console.log(JSON.stringify({ build, url, bundle, browser: browser.version(), ...report }));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
