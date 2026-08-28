# Infinite Mines

A from-scratch, Infinite-only Minesweeper inspired by the gameplay loop of 1000 Mines.

## Run it

```bash
npm install
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
- During ordinary dragging, JavaScript only updates camera uniforms and submits one draw. Detailed instances and the overscanned pixel texture stay unchanged until the camera leaves their buffered range.
- Zoom reaches one CSS pixel per cell. Glyphs crossfade into state squares from 8px through 4px; the sparse texture takes over only after detail reaches zero, and borders disappear below 3px.
- Low-zoom state colors are alpha-weighted averages of the active theme's base cells and actual sprite atlas, so each pixel resembles its zoomed-in tile rather than a raw accent color.
- Cell edges are snapped to the device-pixel grid and shared borders are generated in the shader at exactly one CSS pixel; glyphs come from a 64px antialiased atlas.
- Retina backing resolution is used at rest, then temporarily drops to 1× during an active drag and restores on release.
- Light and dark palettes follow `prefers-color-scheme`; a browser-theme change updates CSS, re-uploads the tiny sprite atlas, and re-derives its low-zoom averages.
- HUD styling avoids backdrop filters and per-frame DOM writes, keeping the canvas off the layout/paint critical path.
- A compact cell locator exposes the hovered coordinates and visible state; clicking it copies the seed, density, safe origin, scale, and theme needed to reproduce that cell without exposing concealed mines.
- A fixed pool of nine faint, compositor-transformed markers highlights the direct click footprint, including every neighbor a revealed clue would chord-open or auto-flag; a persisted setting can reduce this to the hovered cell alone without redrawing the WebGL board.
- Flood reveals use a growable typed-array queue instead of recursive calls or object-heavy node queues.
- The active session is saved to IndexedDB as versioned 9-byte sparse cell records; writes are debounced after actions and never run on drag frames.

The app includes the five original density tiers, a 5×5 safe start, score milestones, multiple lives, chording, silent auto-flagging, artifacts (“Things”), high scores, and an on-demand overview map. At game over, Cheat death can continue the exact run with one health while a persistent, run-local CHEATS counter records the choice and stays hidden on clean runs. Native browser fullscreen and recoverable distraction-free mode leave only the expanded game canvas and one restore button; a viewport offset keeps the world visually fixed and out of persisted camera coordinates. Controls auto-hide into that view after 50 uninterrupted, successful cell actions by default; navigation, hover, guarded no-ops, and scroll never count, any control resets the count, and Settings offers a persisted Never option. Touchscreens support tap, long-press, an explicit Reveal/Flag tool, dead-zone one-finger panning, and focal two-finger pan/zoom at phone or desktop size. The field, progress, marks, and viewport survive refreshes. Desktop controls default to guarded reveal: concealed tiles need the platform-appropriate Ctrl/Command-click, while revealed clues chord normally; a persisted Classic option restores ordinary click-to-reveal.
