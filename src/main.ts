import "./styles.css";
import { requiresRevealGuard } from "./controls";
import { ActionResult, CellState, GameModel, Mode, MODES, openedClue } from "./model";
import { loadActiveGame, saveActiveGame, type PersistedGameV1 } from "./persistence";
import { WebGLRenderer } from "./renderer";

const element = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
};

const canvas = element<HTMLCanvasElement>("#board");
const game = element<HTMLElement>("#game");
const modeStat = element<HTMLElement>("#mode-stat");
const highStat = element<HTMLElement>("#high-stat");
const scoreStat = element<HTMLElement>("#score-stat");
const thingsStat = element<HTMLElement>("#things-stat");
const healthStat = element<HTMLElement>("#health-stat");
const stats = element<HTMLElement>(".stats");
const cheatsStatCard = element<HTMLElement>("#cheats-stat-card");
const cheatsStat = element<HTMLElement>("#cheats-stat");
const toast = element<HTMLElement>("#toast");
const mobileTool = element<HTMLButtonElement>("#mobile-tool");
const settingsDialog = element<HTMLDialogElement>("#settings-dialog");
const overviewDialog = element<HTMLDialogElement>("#overview-dialog");
const helpDialog = element<HTMLDialogElement>("#help-dialog");
const overviewCanvas = element<HTMLCanvasElement>("#overview-canvas");
const overviewCaption = element<HTMLElement>("#overview-caption");
const revealKey = element<HTMLElement>("#reveal-key");
const controlOptions = element<HTMLElement>("#control-options");
const hoverOptions = element<HTMLElement>("#hover-options");
const autoHideOptions = element<HTMLElement>("#auto-hide-options");
const guardedDescription = element<HTMLElement>("#guarded-description");
const helpGuardedDescription = element<HTMLElement>("#help-guarded-description");
const fullscreenButton = element<HTMLButtonElement>("#fullscreen-button");
const uiToggleButton = element<HTMLButtonElement>("#ui-toggle-button");
const gameOverScreen = element<HTMLElement>("#game-over-screen");
const cheatDeathButton = element<HTMLButtonElement>("#cheat-death-button");
const cellLocator = element<HTMLButtonElement>("#cell-locator");
const cellCoordinate = element<HTMLElement>("#cell-coordinate");
const cellState = element<HTMLElement>("#cell-state");
const hoverOverlay = element<HTMLElement>("#hover-overlay");
const hoverMarkers = Array.from({ length: 9 }, () => {
  const marker = document.createElement("span");
  marker.className = "hover-cell";
  hoverOverlay.append(marker);
  return marker;
});

const storageGet = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const storageSet = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The game remains fully playable when storage is blocked.
  }
};

const savedMode = storageGet("infinite-mines-mode");
const initialMode: Mode = MODES.includes(savedMode as Mode) ? (savedMode as Mode) : "beginner";
type ControlsMode = "guarded" | "classic";
const savedControls = storageGet("infinite-mines-controls");
let controlsMode: ControlsMode = savedControls === "classic" ? "classic" : "guarded";
type HoverMode = "affected" | "cell";
const savedHoverMode = storageGet("infinite-mines-hover-preview");
let hoverMode: HoverMode = savedHoverMode === "cell" ? "cell" : "affected";
type AutoHideMode = "after-fifty" | "never";
const savedAutoHideMode = storageGet("infinite-mines-auto-hide-controls");
let autoHideMode: AutoHideMode = savedAutoHideMode === "never" ? "never" : "after-fifty";
const browserPlatform =
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent;
const applePlatform = /mac|iphone|ipad|ipod/i.test(browserPlatform);
const revealModifierLabel = applePlatform ? "⌘ + CLICK" : "CTRL + CLICK";
const revealModifierName = applePlatform ? "Command (⌘)" : "Ctrl";
const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0];
const fallbackSeed = randomSeed();
const persistedGame = await loadActiveGame();
const model = new GameModel({ mode: initialMode, seed: fallbackSeed, autoStart: false });
const restoredGame = persistedGame !== null && model.restoreSnapshot(persistedGame.model);
if (!restoredGame) model.reset(initialMode, fallbackSeed);
else storageSet("infinite-mines-mode", model.mode);
const renderer = new WebGLRenderer(canvas, model);
if (restoredGame) renderer.restoreView(persistedGame.view);
const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
colorScheme.addEventListener("change", () => {
  requestAnimationFrame(() => {
    renderer.refreshTheme();
    if (overviewDialog.open) overviewCaption.textContent = renderer.drawOverview(overviewCanvas);
  });
});
let markTool = false;
let toastTimer = 0;
let saveTimer = 0;
let saveRevision = 0;
let pendingSave: { revision: number; snapshot: PersistedGameV1 } | null = null;
let saveDrain: Promise<void> | null = null;
let persistenceStatus = restoredGame ? "restored" : "idle";
let lastSavedAt = restoredGame && Number.isFinite(persistedGame.savedAt) ? persistedGame.savedAt : 0;
let locatedCell = { x: 0, y: 0 };
let locatorScreen = { x: 0, y: 0 };
let pendingLocatorScreen: { x: number; y: number } | null = null;
let locatorFrame = 0;
let locatorSignature = "";
let locatorTextTimer = 0;
let locatorTextUpdatedAt = 0;
let pointerOnBoard = false;
let boardWidth = canvas.clientWidth;
let boardHeight = canvas.clientHeight;
let hoverVisualKey = "";
let zoomHoverTimer = 0;
let uiHidden = false;
let gameplayInteractionCount = 0;
const AUTO_HIDE_GAMEPLAY_INTERACTIONS = 50;
const locatorTextInterval = (): number => (renderer.cellSize < 4 ? 100 : 50);

const highScoreKey = (mode: Mode): string => `infinite-mines-high-${mode}`;
const readHighScore = (): number => Number(storageGet(highScoreKey(model.mode)) ?? 0);

function updateControlsMode(): void {
  revealKey.textContent = controlsMode === "guarded" ? revealModifierLabel : "CLICK";
  guardedDescription.textContent = `${revealModifierName} + click reveals`;
  helpGuardedDescription.textContent = `Guarded controls need ${revealModifierName} only for concealed tiles; revealed clues click normally. Classic removes the guard.`;
  game.dataset.controls = controlsMode;
  for (const button of controlOptions.querySelectorAll<HTMLButtonElement>("button[data-controls]")) {
    button.ariaPressed = String(button.dataset.controls === controlsMode);
  }
}

function updateHoverMode(): void {
  game.dataset.hoverPreview = hoverMode;
  for (const button of hoverOptions.querySelectorAll<HTMLButtonElement>("button[data-hover]")) {
    button.ariaPressed = String(button.dataset.hover === hoverMode);
  }
  refreshCellLocator();
}

function updateAutoHideMode(): void {
  for (const button of autoHideOptions.querySelectorAll<HTMLButtonElement>("button[data-auto-hide]")) {
    button.ariaPressed = String(button.dataset.autoHide === autoHideMode);
  }
}

function updateStats(): void {
  const previousHigh = readHighScore();
  if (model.score > previousHigh) storageSet(highScoreKey(model.mode), String(model.score));
  modeStat.textContent = model.mode.toUpperCase();
  highStat.textContent = Math.max(previousHigh, model.score).toLocaleString();
  scoreStat.textContent = model.score.toLocaleString();
  thingsStat.textContent = model.things.toLocaleString();
  healthStat.textContent = model.health < 1 ? `♡ × ${model.health}` : model.health > 5 ? `♥ × ${model.health}` : "♥".repeat(model.health);
  cheatsStat.textContent = model.cheats.toLocaleString();
  cheatsStatCard.hidden = model.cheats === 0;
  stats.classList.toggle("has-cheats", model.cheats > 0);
  gameOverScreen.hidden = model.alive;
  game.classList.toggle("game-over", !model.alive);
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 1800);
}

function updateFullscreenState(): void {
  const fullscreen = document.fullscreenElement !== null;
  fullscreenButton.ariaPressed = String(fullscreen);
  fullscreenButton.ariaLabel = fullscreen ? "Exit fullscreen" : "Enter fullscreen";
  fullscreenButton.title = fullscreenButton.ariaLabel;
  fullscreenButton.disabled = !document.fullscreenEnabled && !fullscreen;
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.fullscreenEnabled) await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    else showToast("Fullscreen is unavailable in this browser");
  } catch {
    showToast("Fullscreen could not be opened");
  }
}

function setUiHidden(hidden: boolean): void {
  uiHidden = hidden;
  document.body.classList.toggle("ui-hidden", hidden);
  game.dataset.ui = hidden ? "hidden" : "visible";
  uiToggleButton.ariaPressed = String(hidden);
  uiToggleButton.ariaLabel = hidden ? "Show controls" : "Hide controls";
  uiToggleButton.title = uiToggleButton.ariaLabel;
  if (hidden) updateHoverPreview([]);
  else refreshCellLocator(true);
}

function resetAutoHideCounter(): void {
  gameplayInteractionCount = 0;
}

function completeGameplayInteraction(): void {
  if (autoHideMode === "never" || uiHidden) return;
  gameplayInteractionCount += 1;
  if (gameplayInteractionCount < AUTO_HIDE_GAMEPLAY_INTERACTIONS) return;
  if (!model.alive || settingsDialog.open || overviewDialog.open || helpDialog.open) return;
  gameplayInteractionCount = 0;
  setUiHidden(true);
}

function describeVisibleCell(x: number, y: number): string {
  const state = model.getState(x, y);
  if (state === CellState.Covered) return "covered";
  if (state === CellState.Flagged) return "flagged";
  if (state === CellState.Question) return "question";
  if (state === CellState.Exploded) return "exploded";
  if (state >= CellState.Opened && state <= CellState.Opened8) {
    if (model.artifactAt(x, y)) return "opened artifact";
    const clue = openedClue(state);
    return clue === 0 ? "opened clear" : `opened clue ${clue}`;
  }
  return "covered";
}

function updateHoverPreview(cells: ReadonlyArray<{ x: number; y: number }>): void {
  renderer.setHoverCells(cells);
  if (cells.length === 0) {
    if (hoverVisualKey === "empty") return;
    hoverVisualKey = "empty";
    for (const marker of hoverMarkers) marker.classList.remove("is-visible");
    return;
  }
  const lod = renderer.cellSize < 4 ? "pixel" : "detail";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const visualSize = Math.max(1 / dpr, Math.round(renderer.cellSize * dpr) / dpr);
  const key = `${lod}:${visualSize}:${renderer.panX}:${renderer.panY}:${boardWidth}:${boardHeight}:${cells
    .map(({ x, y }) => `${x},${y}`)
    .join(";")}`;
  if (key === hoverVisualKey) return;
  hoverVisualKey = key;
  if (hoverOverlay.dataset.lod !== lod) hoverOverlay.dataset.lod = lod;
  const sizeValue = `${visualSize}px`;
  if (hoverOverlay.style.getPropertyValue("--hover-cell-size") !== sizeValue) {
    hoverOverlay.style.setProperty("--hover-cell-size", sizeValue);
  }
  const half = renderer.cellSize / 2;
  for (let index = 0; index < hoverMarkers.length; index += 1) {
    const marker = hoverMarkers[index];
    const cell = cells[index];
    if (!cell) {
      marker.classList.remove("is-visible");
      continue;
    }
    const left = boardWidth / 2 + renderer.panX + cell.x * renderer.cellSize - half;
    const top = boardHeight / 2 + renderer.panY + cell.y * renderer.cellSize - half;
    const snappedLeft = Math.round(left * dpr) / dpr;
    const snappedTop = Math.round(top * dpr) / dpr;
    marker.style.transform = `translate3d(${snappedLeft}px, ${snappedTop}px, 0)`;
    marker.classList.add("is-visible");
  }
}

function updateLocatorText(): void {
  const state = describeVisibleCell(locatedCell.x, locatedCell.y);
  const signature = `${locatedCell.x},${locatedCell.y}:${state}`;
  if (signature === locatorSignature) {
    locatorTextUpdatedAt = performance.now();
    return;
  }
  locatorSignature = signature;
  locatorTextUpdatedAt = performance.now();
  cellCoordinate.textContent = `${locatedCell.x}, ${locatedCell.y}`;
  cellState.textContent = `${state.toUpperCase()} · COPY`;
  cellLocator.ariaLabel = `Copy reference for cell ${locatedCell.x}, ${locatedCell.y}`;
  cellLocator.dataset.x = String(locatedCell.x);
  cellLocator.dataset.y = String(locatedCell.y);
  cellLocator.dataset.state = state;
}

function scheduleLocatorText(force = false): void {
  const interval = locatorTextInterval();
  if (force || performance.now() - locatorTextUpdatedAt >= interval) {
    window.clearTimeout(locatorTextTimer);
    locatorTextTimer = 0;
    updateLocatorText();
    return;
  }
  if (locatorTextTimer !== 0) return;
  const delay = Math.max(0, interval - (performance.now() - locatorTextUpdatedAt));
  locatorTextTimer = window.setTimeout(() => {
    locatorTextTimer = 0;
    updateLocatorText();
  }, delay);
}

function refreshCellLocator(forceText = false, showHover = true): void {
  locatedCell = renderer.screenToCell(locatorScreen.x, locatorScreen.y);
  const hoverCells =
    hoverMode === "affected" ? model.previewClickCells(locatedCell.x, locatedCell.y) : [{ ...locatedCell }];
  updateHoverPreview(showHover && pointerOnBoard ? hoverCells : []);
  scheduleLocatorText(forceText);
}

function locateCellAt(screenX: number, screenY: number, forceText = false, showHover = true): void {
  locatorScreen = { x: screenX, y: screenY };
  refreshCellLocator(forceText, showHover);
}

function scheduleCellLocator(screenX: number, screenY: number): void {
  pendingLocatorScreen = { x: screenX, y: screenY };
  if (locatorFrame !== 0) return;
  locatorFrame = requestAnimationFrame(() => {
    locatorFrame = 0;
    const point = pendingLocatorScreen;
    pendingLocatorScreen = null;
    if (point && !gesture && !pinch) locateCellAt(point.x, point.y);
  });
}

function createCellReference(): string {
  const origin = model.safeOrigin;
  const safe = origin ? `(${origin.x}, ${origin.y})` : "unset";
  return [
    `Infinite Mines cell (${locatedCell.x}, ${locatedCell.y})`,
    `mode=${model.mode}`,
    `seed=${model.seed}`,
    `safe=${safe}`,
    `state=${describeVisibleCell(locatedCell.x, locatedCell.y)}`,
    `scale=${renderer.cellSize.toFixed(2)}px/tile`,
    `theme=${colorScheme.matches ? "dark" : "light"}`,
  ].join(" | ");
}

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function copyCellReference(): Promise<void> {
  refreshCellLocator(true);
  const reference = createCellReference();
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(reference);
      copied = true;
    }
  } catch {
    // Plain HTTP LAN hosts may not expose the modern clipboard API.
  }
  if (!copied) copied = fallbackCopy(reference);
  showToast(copied ? `Cell (${locatedCell.x}, ${locatedCell.y}) reference copied` : `Cell (${locatedCell.x}, ${locatedCell.y})`);
}

function flushGameSave(force = false): Promise<void> {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  if (!force && gesture?.moved) {
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      void flushGameSave();
    }, 280);
    return Promise.resolve();
  }
  try {
    pendingSave = {
      revision: saveRevision,
      snapshot: {
        version: 1,
        savedAt: Date.now(),
        model: model.createSnapshot(),
        view: renderer.createViewSnapshot(),
      },
    };
  } catch {
    persistenceStatus = "unavailable";
    return Promise.resolve();
  }

  if (!saveDrain) {
    saveDrain = (async () => {
      while (pendingSave) {
        const next = pendingSave;
        pendingSave = null;
        persistenceStatus = "saving";
        const saved = await saveActiveGame(next.snapshot);
        if (saved) {
          lastSavedAt = next.snapshot.savedAt;
          persistenceStatus = "saved";
        } else {
          persistenceStatus = "unavailable";
        }
      }
    })().finally(() => {
      saveDrain = null;
    });
  }
  return saveDrain;
}

function scheduleGameSave(delay = 280): void {
  saveRevision += 1;
  persistenceStatus = "pending";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    void flushGameSave();
  }, delay);
}

function applyAction(result: ActionResult): void {
  if (result.changed === 0) {
    if (!model.alive) showToast("No health left — cheat death or start fresh");
    return;
  }
  if (result.exploded) showToast(model.alive ? "Mine hit — keep moving" : "Field lost — choose what happens next");
  updateStats();
  renderer.requestRender();
  refreshCellLocator(true);
  scheduleGameSave();
  if (!model.alive) requestAnimationFrame(() => cheatDeathButton.focus());
}

function cheatDeath(): void {
  if (!model.cheatDeath()) return;
  updateStats();
  renderer.requestRender();
  refreshCellLocator(true);
  scheduleGameSave(0);
  showToast(`Cheat ${model.cheats.toLocaleString()} — back with one health`);
}

function newGame(mode: Mode = model.mode): void {
  model.reset(mode, randomSeed());
  storageSet("infinite-mines-mode", mode);
  renderer.home();
  updateStats();
  refreshCellLocator(true);
  scheduleGameSave(0);
  showToast(`${mode[0].toUpperCase()}${mode.slice(1)} field generated`);
}

function goHome(): void {
  renderer.home();
  refreshCellLocator(true);
  scheduleGameSave();
}

const resizeObserver = new ResizeObserver(([entry]) => {
  if (entry) {
    boardWidth = Math.max(1, Math.round(entry.contentRect.width));
    boardHeight = Math.max(1, Math.round(entry.contentRect.height));
    hoverVisualKey = "";
  }
  renderer.resize();
  refreshCellLocator(true);
});
resizeObserver.observe(canvas);
renderer.resize();
locateCellAt(canvas.clientWidth / 2, canvas.clientHeight / 2, true);
updateStats();
updateControlsMode();
updateHoverMode();
updateAutoHideMode();
updateFullscreenState();
setUiHidden(false);
if (!restoredGame) scheduleGameSave(0);

interface PointerGesture {
  id: number;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  startLocalX: number;
  startLocalY: number;
  moved: boolean;
  longPressed: boolean;
  mark: boolean;
  reveal: boolean;
  timer: number;
}

interface TouchPoint {
  clientX: number;
  clientY: number;
  localX: number;
  localY: number;
}

interface PinchGesture {
  firstId: number;
  secondId: number;
  distance: number;
  centerX: number;
  centerY: number;
}

const DRAG_THRESHOLD_PX = 7;
let gesture: PointerGesture | null = null;
let pinch: PinchGesture | null = null;
const activeTouches = new Map<number, TouchPoint>();

const localPoint = (event: PointerEvent | WheelEvent): { x: number; y: number } => {
  return { x: event.offsetX, y: event.offsetY };
};

const beginPinch = (): void => {
  const touches = [...activeTouches.entries()].slice(0, 2);
  if (touches.length < 2) return;
  if (gesture) window.clearTimeout(gesture.timer);
  gesture = null;
  const [[firstId, first], [secondId, second]] = touches;
  pinch = {
    firstId,
    secondId,
    distance: Math.max(1, Math.hypot(second.localX - first.localX, second.localY - first.localY)),
    centerX: (first.localX + second.localX) / 2,
    centerY: (first.localY + second.localY) / 2,
  };
  canvas.classList.add("is-panning");
  updateHoverPreview([]);
};

const updatePinch = (): void => {
  if (!pinch) return;
  const first = activeTouches.get(pinch.firstId);
  const second = activeTouches.get(pinch.secondId);
  if (!first || !second) return;
  const distance = Math.max(1, Math.hypot(second.localX - first.localX, second.localY - first.localY));
  const centerX = (first.localX + second.localX) / 2;
  const centerY = (first.localY + second.localY) / 2;
  renderer.panBy(centerX - pinch.centerX, centerY - pinch.centerY);
  renderer.zoomAt(centerX, centerY, distance / pinch.distance);
  pinch = { ...pinch, distance, centerX, centerY };
  scheduleGameSave();
};

const finishPinchTouch = (event: PointerEvent): boolean => {
  if (event.pointerType !== "touch" || !activeTouches.has(event.pointerId)) return false;
  const wasPinching = pinch !== null;
  activeTouches.delete(event.pointerId);
  if (!wasPinching) return false;
  if (activeTouches.size >= 2) {
    beginPinch();
    return true;
  }
  pinch = null;
  gesture = null;
  canvas.classList.remove("is-panning");
  renderer.finishPan();
  const point = localPoint(event);
  locateCellAt(point.x, point.y, true, false);
  updateHoverPreview([]);
  scheduleGameSave();
  return true;
};

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.button !== 2) return;
  window.clearTimeout(zoomHoverTimer);
  canvas.classList.remove("is-panning");
  pointerOnBoard = true;
  const point = localPoint(event);
  locateCellAt(point.x, point.y, true, event.pointerType === "mouse");
  canvas.setPointerCapture(event.pointerId);
  if (event.pointerType === "touch") {
    activeTouches.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
      localX: point.x,
      localY: point.y,
    });
    if (activeTouches.size >= 2) {
      beginPinch();
      return;
    }
  }
  const revealModifier = event.ctrlKey || event.metaKey;
  const directPointer = event.pointerType !== "mouse";
  const mark = !revealModifier && (event.button === 2 || event.shiftKey || markTool);
  const reveal = directPointer || revealModifier || controlsMode === "classic";
  gesture = {
    id: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    startLocalX: point.x,
    startLocalY: point.y,
    moved: false,
    longPressed: false,
    mark,
    reveal,
    timer: 0,
  };
  if (event.pointerType === "touch" && !mark) {
    gesture.timer = window.setTimeout(() => {
      if (!gesture || gesture.moved) return;
      gesture.longPressed = true;
      const cell = renderer.screenToCell(gesture.startLocalX, gesture.startLocalY);
      const result = model.cycleMark(cell.x, cell.y);
      applyAction(result);
      if (result.changed > 0) completeGameplayInteraction();
      navigator.vibrate?.(18);
    }, 430);
  }
});

canvas.addEventListener("pointermove", (event) => {
  const point = localPoint(event);
  if (event.pointerType === "touch" && activeTouches.has(event.pointerId)) {
    activeTouches.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
      localX: point.x,
      localY: point.y,
    });
    if (pinch) {
      updatePinch();
      return;
    }
  }
  if (!gesture) {
    pointerOnBoard = true;
    scheduleCellLocator(point.x, point.y);
    return;
  }
  if (gesture.id !== event.pointerId) return;
  const deltaFromStartX = event.clientX - gesture.startClientX;
  const deltaFromStartY = event.clientY - gesture.startClientY;
  if (!gesture.moved && deltaFromStartX ** 2 + deltaFromStartY ** 2 > DRAG_THRESHOLD_PX ** 2) {
    gesture.moved = true;
    window.clearTimeout(gesture.timer);
    canvas.classList.add("is-panning");
    updateHoverPreview([]);
    renderer.panBy(deltaFromStartX, deltaFromStartY);
  } else if (gesture.moved) {
    renderer.panBy(event.clientX - gesture.lastClientX, event.clientY - gesture.lastClientY);
  }
  gesture.lastClientX = event.clientX;
  gesture.lastClientY = event.clientY;
});

const finishPointer = (event: PointerEvent): void => {
  if (!gesture || gesture.id !== event.pointerId) return;
  window.clearTimeout(gesture.timer);
  const completed = gesture;
  gesture = null;
  canvas.classList.remove("is-panning");
  if (completed.moved) {
    renderer.finishPan();
    const point = localPoint(event);
    locateCellAt(point.x, point.y, true);
    scheduleGameSave();
    return;
  }
  if (completed.longPressed) {
    refreshCellLocator(true);
    return;
  }
  const cell = renderer.screenToCell(completed.startLocalX, completed.startLocalY);
  const state = model.getState(cell.x, cell.y);
  if (completed.mark) {
    const result = model.cycleMark(cell.x, cell.y);
    applyAction(result);
    if (result.changed > 0) completeGameplayInteraction();
  } else if (completed.reveal || !requiresRevealGuard(state)) {
    const result = model.reveal(cell.x, cell.y);
    applyAction(result);
    if (result.changed > 0) completeGameplayInteraction();
  } else showToast(`Hold ${revealModifierName} and click to reveal`);
  refreshCellLocator(true);
};

canvas.addEventListener("pointerup", (event) => {
  if (finishPinchTouch(event)) return;
  if (event.pointerType === "touch") activeTouches.delete(event.pointerId);
  finishPointer(event);
});
canvas.addEventListener("pointerenter", (event) => {
  if (event.pointerType === "touch") return;
  pointerOnBoard = true;
  const point = localPoint(event);
  scheduleCellLocator(point.x, point.y);
});
canvas.addEventListener("pointerleave", (event) => {
  if (gesture || event.pointerType !== "mouse") return;
  pointerOnBoard = false;
  updateHoverPreview([]);
});
canvas.addEventListener("pointercancel", (event) => {
  if (finishPinchTouch(event)) return;
  if (event.pointerType === "touch") activeTouches.delete(event.pointerId);
  if (gesture?.id === event.pointerId) window.clearTimeout(gesture.timer);
  if (gesture?.moved) {
    renderer.finishPan();
    const point = localPoint(event);
    locateCellAt(point.x, point.y, true);
    scheduleGameSave();
  }
  gesture = null;
  canvas.classList.remove("is-panning");
  refreshCellLocator(true);
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const point = localPoint(event);
    renderer.zoomAt(point.x, point.y, Math.exp(-event.deltaY * 0.0012));
    locateCellAt(point.x, point.y, false, false);
    window.clearTimeout(zoomHoverTimer);
    zoomHoverTimer = window.setTimeout(() => {
      zoomHoverTimer = 0;
      if (!gesture && pointerOnBoard) refreshCellLocator();
    }, 80);
    scheduleGameSave();
  },
  { passive: false },
);

element<HTMLButtonElement>("#restart-button").addEventListener("click", () => newGame());
element<HTMLButtonElement>("#game-over-restart-button").addEventListener("click", () => newGame());
cheatDeathButton.addEventListener("click", cheatDeath);
element<HTMLButtonElement>("#settings-button").addEventListener("click", () => settingsDialog.showModal());
element<HTMLButtonElement>("#home-button").addEventListener("click", goHome);
fullscreenButton.addEventListener("click", () => void toggleFullscreen());
uiToggleButton.addEventListener("click", () => setUiHidden(!uiHidden));
element<HTMLButtonElement>("#overview-button").addEventListener("click", () => {
  overviewDialog.showModal();
  requestAnimationFrame(() => {
    overviewCaption.textContent = renderer.drawOverview(overviewCanvas);
  });
});
element<HTMLButtonElement>("#overview-close").addEventListener("click", () => overviewDialog.close());
element<HTMLButtonElement>("#help-button").addEventListener("click", () => helpDialog.showModal());
element<HTMLButtonElement>("#help-close").addEventListener("click", () => helpDialog.close());
cellLocator.addEventListener("click", () => void copyCellReference());

element("#difficulty-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
  if (!button) return;
  const mode = button.dataset.mode as Mode;
  settingsDialog.close();
  newGame(mode);
});

controlOptions.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-controls]");
  if (!button) return;
  controlsMode = button.dataset.controls === "classic" ? "classic" : "guarded";
  storageSet("infinite-mines-controls", controlsMode);
  updateControlsMode();
});

hoverOptions.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-hover]");
  if (!button) return;
  hoverMode = button.dataset.hover === "cell" ? "cell" : "affected";
  storageSet("infinite-mines-hover-preview", hoverMode);
  updateHoverMode();
});

autoHideOptions.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-auto-hide]");
  if (!button) return;
  autoHideMode = button.dataset.autoHide === "never" ? "never" : "after-fifty";
  storageSet("infinite-mines-auto-hide-controls", autoHideMode);
  resetAutoHideCounter();
  updateAutoHideMode();
});

mobileTool.addEventListener("click", () => {
  markTool = !markTool;
  mobileTool.ariaPressed = String(markTool);
  mobileTool.innerHTML = markTool ? '<span aria-hidden="true">⚑</span> FLAG' : '<span aria-hidden="true">◇</span> REVEAL';
});

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
  const key = event.key.toLowerCase();
  if (key === "r") {
    resetAutoHideCounter();
    newGame();
  } else if (key === "h") {
    resetAutoHideCounter();
    goHome();
  } else if (key === "f") {
    resetAutoHideCounter();
    mobileTool.click();
  } else if (/^[1-5]$/.test(key)) {
    resetAutoHideCounter();
    newGame(MODES[Number(key) - 1]);
  }
});

document.addEventListener(
  "click",
  (event) => {
    if ((event.target as Element).closest("button, a")) resetAutoHideCounter();
  },
  { capture: true },
);

for (const dialog of [settingsDialog, overviewDialog, helpDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushGameSave(true);
});
document.addEventListener("fullscreenchange", () => {
  updateFullscreenState();
  requestAnimationFrame(() => {
    renderer.resize();
    refreshCellLocator(true);
  });
});
window.addEventListener("pagehide", () => void flushGameSave(true));

declare global {
  interface Window {
    __infiniteMines: {
      model: GameModel;
      renderer: WebGLRenderer;
      diagnostics: () => ReturnType<typeof getDiagnostics>;
      reveal: (x: number, y: number) => void;
      cheatDeath: () => void;
      newGame: (mode?: Mode) => void;
      flushSave: () => Promise<void>;
    };
  }
}

function getDiagnostics() {
  return {
    ...renderer.diagnostics,
    score: model.score,
    things: model.things,
    health: model.health,
    cheats: model.cheats,
    openedCells: model.store.openedCells,
    controlsMode,
    hoverMode,
    autoHideMode,
    gameplayInteractionCount,
    fullscreen: document.fullscreenElement !== null,
    uiHidden,
    persistenceStatus,
    lastSavedAt,
    canvasCount: document.querySelectorAll("canvas").length,
    domNodes: document.querySelectorAll("*").length,
  };
}

window.__infiniteMines = {
  model,
  renderer,
  diagnostics: getDiagnostics,
  reveal: (x, y) => applyAction(model.reveal(x, y)),
  cheatDeath,
  newGame,
  flushSave: () => flushGameSave(true),
};
