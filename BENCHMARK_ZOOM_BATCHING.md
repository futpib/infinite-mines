# Full-quality zoom batching benchmark — 2026-10-01

The renderer now fetches the same float32 cell attributes from a compact texture and submits one continuous triangle batch, avoiding the scheduling cost of thousands of tiny instances. Geometry, draw order, fragment shaders, blending, backing resolution, Things, glyphs, borders, fog, and hover behavior remain unchanged. This is the normal renderer at rest and during movement; there is no motion-only quality reduction.

Baseline: `f5758ec4564224a43fbbf52c24db43ff47986d53`. Implementation: `567faad647c32d387dbef886dbc342fc364495b6`. Raw per-frame measurements and bundle URLs are in [BENCHMARK_ZOOM_BATCHING.json](./BENCHMARK_ZOOM_BATCHING.json).

## Method

- Same seeded 143-Thing field, light theme, 1440×900 viewport, DPR 1, all four Euclidean topologies.
- Production wheel handler driven from animation frames through 8.2→3.8→8.2 CSS pixels per cell, 40 samples per sweep. Exact requested scale and one draw are asserted throughout.
- Baseline/candidate/candidate/baseline order, with fresh browser contexts between runs. No test suite ran concurrently. The host is shared, so unrelated load remains possible.
- Each case measures a first sweep and a warmed repeat. The first sweep begins after the initial 8.2px view loads; it includes artwork newly exposed during zoom, not an uncached application startup.
- Values below are p95 frame intervals in milliseconds, showing the range across the two runs. p95 uses sorted sample index `floor((n - 1) * 0.95)`.
- All warmed sweeps had zero new artwork requests and two range uploads at the Square LOD or polygon cache boundaries, not one upload per frame. Every case preserved model state and returned to idle.

## SwiftShader

Browser: 151.0.7922.34. Renderer: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`.

| Topology | Original warm p95 | Batched warm p95 | Original first sweep p95 | Batched first sweep p95 |
|---|---:|---:|---:|---:|
| Square | 150.1–216.6 | 16.7–16.8 | 150.0–150.1 | 33.4 |
| Hexagonal | 166.7–200.0 | 50.0–50.1 | 166.7–200.0 | 33.4–50.1 |
| Triangular | 250.1–1749.9 | 50.0 | 250.0–900.0 | 50.0 |
| Rhombille | 166.7–183.3 | 66.7 | 166.7–266.6 | 66.7–66.8 |

The best baseline versus the slower candidate gives conservative warmed p95 reductions of approximately 9× for Square, 3.3× for Hexagonal, 5× for Triangular, and 2.5× for Rhombille. The second baseline Triangular run had a large 1,750ms outlier; its cause was not isolated and it is not used to inflate these ratios. These software-GPU results are not a prediction of a user's device FPS.

## NVIDIA hardware

Browser: 153.0.8010.52. Renderer: `ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA Quadro T1000 with Max-Q Design (0x00001FB9)), NVIDIA)`. System Chromium used ANGLE/Vulkan with `--use-gl=angle --use-angle=vulkan --enable-gpu --ignore-gpu-blocklist`.

| Topology | Original warm p95 | Batched warm p95 | Original first sweep p95 | Batched first sweep p95 |
|---|---:|---:|---:|---:|
| Square | 16.7–16.8 | 16.7–16.8 | 33.4–83.3 | 50.0 |
| Hexagonal | 16.7 | 16.7 | 16.7 | 16.8 |
| Triangular | 16.7–16.8 | 16.7–16.8 | 16.7 | 16.7–16.8 |
| Rhombille | 16.7–16.8 | 16.7–16.8 | 16.8–33.4 | 16.8 |

Both implementations already reach the roughly 60Hz display cadence when warmed on this GPU; there is no measurable warmed FPS gain here. First-sweep artwork loading still causes occasional spikes. This change does not claim to eliminate all cold-load stalls.

## Validation and cost

The pinned CI run passed 43/43 unit tests and 78/79 browser tests, including the new 576-case byte-for-byte comparison against the original instanced path across themes, topologies, rotations, zoom levels, fractional DPR, loaded Things, and capacity fallback. The existing R31 Retina pan timing check remains above its unchanged 35ms ceiling at 50.1ms; its framebuffer correctness assertions pass. R54 motion/settled quality, R56 crowded-artwork idle behavior, and desktop/mobile zoom tests pass.

The same 576-case framebuffer matrix also passed byte-for-byte on the NVIDIA GPU. All nine deployed LAN checks passed on hardware Chromium, covering full-quality wheel zoom, crowded artwork on four topologies, delayed loads after mobile pinch, and wheel/pinch navigation through 64×64. A separate live check returned HTTP 200, exact framebuffer recovery after forced WebGL context loss, and zero console/page/request/WebGL errors or overflow across desktop/mobile widths and both themes.

The extra cached cell-data texture costs 32 bytes per Square cell or 64 per polygon cell, plus at most one row of padding. It is rebuilt only with the existing geometry cache; it does not duplicate every vertex or upload on each zoom frame. The original instance buffers remain available for the texture-capacity fallback and parity tests.

## Reproduce

Serve the baseline and candidate production builds on separate ports, then run:

```sh
node scripts/benchmark-zoom.mjs http://127.0.0.1:4174/ http://127.0.0.1:4176/ square hexagonal triangular rhombille
npm run test:docker
```

The benchmark defaults to bundled headless Chromium/SwiftShader. For the hardware comparison, the same script was run with `chromium.launch` using `/usr/bin/chromium` and the ANGLE/Vulkan flags above. Keep other browser tests and GPU benchmarks stopped during measurement.
