# Touch interaction convention

Status: implemented and enforced by R47 in the executable acceptance contract.

This convention governs direct touch interaction with board tiles.

## Risk follows effort

The easiest gesture must perform the safer, reversible action. An action that can expose a mine must require more intent.

For a concealed tile in the default touch mode:

| Gesture | Action |
| --- | --- |
| Short tap | Cycle the mark: covered → flag → question → covered. |
| Long press, then release | Reveal the tile. |

This is touch's equivalent of guarded desktop controls: ordinary input does not reveal a concealed tile, while Ctrl/Command-click or double-click deliberately crosses that guard.

A flag remains a hard interlock. Holding a flagged tile must not reveal it; the player must first change or clear the mark. A question-marked tile may be revealed with a deliberate long press. Tapping an already opened clue keeps its existing chord or auto-flag behavior because this convention changes covered-tile input only.

The visible Reveal/Flag tool remains an accessibility and repeated-action alternative. Choosing Reveal explicitly is itself the extra act of intent, so it may make short taps reveal while that mode is visibly selected. The default mode must retain the guarded mapping above.

## Preview after dangerous intent

Ordinary taps stay visually quiet. Only a valid default-mode hold that crosses the reveal threshold shows an offset preview outside the area hidden by the finger. Prefer above the contact point, clamp it inside the viewport, and move it to another unobscured side when there is not enough room. A flagged hold, opened-tile tap, or explicitly selected Reveal-tool tap does not show it.

The preview must:

- show the commit target and its complete, symmetric immediate topology neighborhood at exactly the field's current zoom level rather than cutting that ring at an arbitrary fixed rectangle; when the ring is physically tiny, center it in bounded board-scale context without magnifying it;
- use that neighborhood itself as the callout, with no coordinate label or padding around it;
- reproduce only the board's public appearance; it must never expose a covered mine or any other hidden state;
- identify the exact tile and action that would commit on release;
- place the action cue outside the neighborhood image so it never covers board context;
- leave the neighborhood's own outer pixels unclipped, including renderer-owned shared-edge pixels beyond a tile's geometric bounds; an optional frame and shadow must paint outside that image, never inset over its boundary cells;
- align target emphasis to the exact topology polygon in the captured image's coordinate space and clip its stroke inward so Square, Rhombille, and Triangular targets do not scale, grow beyond, or drift away from the rendered cell;
- remain in sync with the commit target if the interaction allows the candidate to move;
- make the armed reveal explicit without relying on color alone;
- work for every topology and zoom level, including distraction-free mode;
- use bounded, reusable UI with no per-cell DOM, continuous render loop, or field materialization.

Reaching the long-press threshold arms reveal and may give brief haptic feedback, but it must not mutate the board while the finger still obscures the tile. Reveal commits only when that same valid press is released.

## Cancellation and navigation

The gesture is cancelled without a cell action when it becomes a pan, a second finger begins a pinch, the pointer is cancelled, or the interaction otherwise loses its valid target. The preview disappears on commit or cancellation and as soon as panning or pinching begins.

Small movement inside the existing dead zone must not make the preview disagree with the tile that will receive the action. Sliding to a new candidate is allowed only if preview and commit targeting change together.

Fatal touch input must still stop at the game-over decision surface. Neither the release nor a synthesized compatibility click may choose Cheat death or Start a new field.

## Executable acceptance

`REQUIREMENTS.md` R47 and trusted production-browser coverage prove:

1. A default short tap marks a covered safe tile and a covered mine without revealing either.
2. A long press changes nothing at the threshold, visibly arms reveal, and reveals only on a valid release.
3. Flags cannot be revealed directly; questions follow the deliberate-reveal rule.
4. Pan, pinch, pointer cancellation, and release before the threshold cannot accidentally reveal.
5. Short taps, flagged holds, opened-tile taps, and explicit-tool taps show no preview. A valid reveal hold shows the neighborhood only after the threshold.
6. The preview has no coordinates, padding, image clipping mask, or inset frame; it contains the complete topology-neighbor ring, keeps its action cue outside the field image, stays offset and inside the viewport, matches the committed tile with an inward-clipped topology outline, uses the field's current zoom level, leaks no hidden state, and clears on every completion path. Any callout border and shadow remain outside the image.
7. The mapping and preview hold across Square, Rhombille, and Triangular fields, a measured detail/pixel zoom × device-pixel-ratio matrix, visible/hidden controls, and phone/desktop touch viewports. The matrix checks the final screen-space target after SVG transforms and the actual rendered footprint, including asymmetric shared-edge ownership, rather than only SVG-local or cell-geometric bounding boxes.
8. The existing fatal-input/game-over guard and bounded interaction-performance contracts remain green.
