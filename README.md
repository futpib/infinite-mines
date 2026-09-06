# Infinite Mines

A from-scratch, Infinite-only Minesweeper inspired by the gameplay loop of 1000 Mines.

## Run it

```bash
npm ci
npm run dev
```

Run the repeatable production-browser interaction benchmark with `npm run benchmark`. It reports frame pacing, input-handler cost, WebGL frames/uploads, long tasks, and browser task/style/layout time for hover, drag, zoom, reveal, persistence, and idle paths. It also compares those interactions on 1,024-cell and 98,304-cell revealed fields.

Production build and tests:

```bash
npm test
npm run build
npm run preview
```

`npm test` runs the engine tests, production build, and the Playwright acceptance contract. See [REQUIREMENTS.md](./REQUIREMENTS.md) for the thread-to-test matrix. Install the bundled browser once with `npx playwright install chromium`.

The guarded touch gesture and finger-offset, board-scale neighborhood preview convention is recorded in [TOUCH_UX.md](./TOUCH_UX.md) and enforced by the executable acceptance contract. Its preview keeps the complete immediate topology-neighbor ring visible inside an outward-framed callout, aligns an inward-clipped target outline to each topology, and places the release instruction outside the unobscured field image.

For the exact environment used by GitHub Actions, run:

```bash
npm run test:docker
```

That command builds the pinned Linux x64 CI image and runs the complete unit and production-browser suite inside it. The image combines Ubuntu Noble and Playwright 1.62.1 with the GitHub `ubuntu-24.04` runner's Node 22.23.2 and npm 10.9.8; image, Node, and npm downloads are checksum-pinned. The build uses host networking only to fetch those verified inputs, while the test container itself has no network. GitHub invokes this same command rather than maintaining a second test recipe. Failed browser runs leave their HTML report and traces in `playwright-report/` and `test-results/` locally and upload both as the `playwright-diagnostics` Actions artifact.

## Publish it

The GitHub Pages workflow builds and publishes the game after every push to `master`. For a new repository, select **GitHub Actions** once under **Settings → Pages → Build and deployment → Source**, then push:

```bash
git push
```

The production build uses relative asset paths, so it works as a GitHub project site, an account site, or on a custom domain without changing the repository name in the source.

## Why it stays fast

- One WebGL 2 `<canvas>` and no cell DOM nodes.
- No continuous render loop: frames are scheduled only after input, resize, or state changes.
- Covered terrain and mines are deterministic O(1) functions, so an infinite field is never materialized.
- Interactions and opened clues are packed into sparse 64×64 `Uint8Array` chunks, including negative coordinates.
- At detailed zoom, sparse 8×8 CPU tiles are cached by version and only revealed or marked cells are compacted into the GPU instance buffer.
- Number, flag, question, and explosion art is uploaded once as a compact sprite atlas.
- Detailed cells render in one instanced WebGL draw. At pixel LOD, intersecting sparse chunks are packed into one tightly cropped integer state texture and drawn as one camera-transformed quad.
- Small cell actions retain the previous framebuffer and scissor rendering to a one-cell dependency halo. At 1×, sufficiently dense detail views scroll preserved color pixels for integral-pixel pans and shade only newly exposed strips; ordinary sparse, fractional, high-DPI, and pixel-LOD movement keeps the faster full-frame path.
- During dragging, detailed instances and the overscanned pixel texture stay unchanged until the camera leaves their buffered range. Zoom, resize, theme changes, and large damage deliberately redraw the full frame.
- Zoom reaches one CSS pixel per cell. Glyphs crossfade into state squares from 8px through 4px; the sparse texture takes over only after detail reaches zero, and borders disappear below 3px.
- Low-zoom state colors are alpha-weighted averages of the active theme's base cells and actual sprite atlas, so each pixel resembles its zoomed-in tile rather than a raw accent color.
- Cell edges are snapped to the device-pixel grid and shared borders are generated in the shader at exactly one CSS pixel; glyphs come from a 64px antialiased atlas.
- Retina backing resolution and the device-pixel edge lattice stay unchanged throughout navigation, so beginning or ending a drag never resnaps the grid.
- The topbar FPS badge samples actual WebGL frame intervals, updates at most four times per second while rendering, and returns to `IDLE` without starting a measurement loop of its own.
- Light and dark palettes follow `prefers-color-scheme`; a browser-theme change updates CSS, re-uploads the tiny sprite atlas, and re-derives its low-zoom averages.
- HUD styling avoids backdrop filters and per-frame DOM writes, keeping the canvas off the layout/paint critical path.
- A compact cell locator exposes the hovered coordinates and visible state; clicking it copies the seed, density, generation rules, safe origin, scale, and theme needed to reproduce that cell without exposing concealed mines.
- A fixed pool of nine faint, compositor-transformed markers highlights the direct click footprint, including every neighbor a revealed clue would chord-open or auto-flag; a persisted setting can reduce this to the hovered cell alone without redrawing the WebGL board.
- Flood reveals use a growable typed-array queue instead of recursive calls or object-heavy node queues.
- The active session is saved to IndexedDB as versioned 9-byte sparse cell records; writes are debounced after actions and never run on drag frames.

The app includes the five original 18%, 22%, 27%, 33%, and 33% per-cell mine chances, plus a persisted 12–50% Custom field. Like 1000mines, every 24×24 zone reserves 25 cells with 5/6 probability or 36 cells with 1/6 probability for a Thing, yielding the original lower effective whole-field rates while keeping our Thing itself visually simple. Square uses the exact padded 5×5/6×6 footprint; alternate topologies keep the same reservation count while protecting every neighbor of the Thing. The selected chance stays visible in the HUD. It also preserves the 5×5 safe start, score milestones, multiple lives, chording, silent auto-flagging, high scores, and an on-demand overview map. Outside Deathmatch, Cheat death can continue an ended run with successive Fibonacci health grants while a persistent, run-local CHEATS counter records the choice and stays hidden on clean runs; Deathmatch's single life is final. The game canvas is full-viewport from initial load, with the topbar and HUD layered above it; native browser fullscreen and recoverable distraction-free mode therefore leave only the canvas, its live hover highlight, and one restore button without resizing or redrawing the board. Controls auto-hide into that view after 50 uninterrupted, successful cell actions by default; navigation, hover, guarded no-ops, and scroll never count, any control resets the count, and Settings offers a persisted Never option. Touchscreens default to quiet short-tap marking and hold-then-release revealing; only a valid reveal hold shows an offset, board-scale neighborhood after it becomes dangerous. An explicit Reveal override remains available for accessibility or repeated actions. The same input path preserves dead-zone one-finger panning and focal two-finger pan/zoom at phone or desktop size. The field, progress, marks, density, generation rules, and viewport survive refreshes. Desktop controls default to guarded reveal: concealed tiles need the platform-appropriate Ctrl/Command-click or a double-click, while revealed clues chord normally; a persisted Classic option restores ordinary click-to-reveal.
