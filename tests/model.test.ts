import { describe, expect, it, vi } from "vitest";
import { CellState, CellStore, DIFFICULTIES, GameModel, MODES, floorDiv, hash32, isOpened, openedClue } from "../src/model";
import { TOPOLOGIES, TOPOLOGY_IDS } from "../src/topology";

describe("deterministic infinite field", () => {
  it("returns identical hashes and mine layouts for the same seed", () => {
    const first = new GameModel({ seed: 42, autoStart: false });
    const second = new GameModel({ seed: 42, autoStart: false });
    for (let y = -80; y <= 80; y += 7) {
      for (let x = -80; x <= 80; x += 7) {
        expect(first.mineAt(x, y)).toBe(second.mineAt(x, y));
        expect(hash32(x, y, 42)).toBe(hash32(x, y, 42));
      }
    }
  });

  it("keeps a 5 by 5 area mine-free around the first reveal", () => {
    const game = new GameModel({ mode: "deathmatch", seed: 29, autoStart: false });
    game.reveal(100, -200);
    for (let y = -202; y <= -198; y += 1) {
      for (let x = 98; x <= 102; x += 1) expect(game.mineAt(x, y)).toBe(false);
    }
  });

  it("tracks the requested density over a large sample", () => {
    for (const mode of MODES) {
      const game = new GameModel({ mode, seed: 91, autoStart: false });
      let mines = 0;
      const side = 400;
      for (let y = 1000; y < 1000 + side; y += 1) {
        for (let x = 1000; x < 1000 + side; x += 1) mines += Number(game.mineAt(x, y));
      }
      const observed = mines / (side * side);
      expect(Math.abs(observed - DIFFICULTIES[mode].density)).toBeLessThan(0.008);
    }
  });
});

describe("topology-driven fields", () => {
  it("keeps deterministic density, clues, and graph-distance-two starts on every topology", () => {
    for (const topologyId of TOPOLOGY_IDS) {
      const first = new GameModel({ mode: "master", seed: 0x71a9, autoStart: false, topology: topologyId });
      const second = new GameModel({ mode: "master", seed: 0x71a9, autoStart: false, topology: topologyId });
      for (let y = -20; y <= 20; y += 4) {
        for (let x = -30; x <= 30; x += 5) {
          expect(first.mineAt(x, y)).toBe(second.mineAt(x, y));
          let expectedClue = 0;
          TOPOLOGIES[topologyId].forEachNeighbor(x, y, (neighborX, neighborY) => {
            expectedClue += Number(first.mineAt(neighborX, neighborY));
          });
          expect(first.clueAt(x, y)).toBe(expectedClue);
        }
      }

      first.reveal(7, -11);
      let frontier: Array<[number, number]> = [[7, -11]];
      const safe = new Set(["7,-11"]);
      for (let distance = 0; distance < 2; distance += 1) {
        const next: Array<[number, number]> = [];
        for (const [x, y] of frontier) {
          TOPOLOGIES[topologyId].forEachNeighbor(x, y, (neighborX, neighborY) => {
            const key = `${neighborX},${neighborY}`;
            if (safe.has(key)) return;
            safe.add(key);
            next.push([neighborX, neighborY]);
          });
        }
        frontier = next;
      }
      for (const key of safe) {
        const [x, y] = key.split(",").map(Number);
        expect(first.mineAt(x, y), `${topologyId} safe ${key}`).toBe(false);
      }
    }
  });

  it("stores and exposes clues above eight without widening sparse cell records", () => {
    for (const topologyId of ["triangular", "rhombille"] as const) {
      const game = new GameModel({ seed: 8, autoStart: false, topology: topologyId });
      const mines = new Set<string>();
      game.topology.forEachNeighbor(0, 0, (x, y) => mines.add(`${x},${y}`));
      vi.spyOn(game, "mineAt").mockImplementation((x, y) => mines.has(`${x},${y}`));
      game.reveal(0, 0);
      expect(openedClue(game.getState(0, 0))).toBe(game.topology.maxNeighbors);
      expect(game.createSnapshot().cells.byteLength).toBe(game.store.nonZeroCells * 9);
    }
  });

  it("persists topology in v2 and migrates v1 fields as Square", () => {
    const source = new GameModel({ seed: 99, topology: "rhombille" });
    const snapshot = source.createSnapshot();
    expect(snapshot.version).toBe(2);
    expect(snapshot.topology).toBe("rhombille");
    const restored = new GameModel({ seed: 1, autoStart: false });
    expect(restored.restoreSnapshot(snapshot)).toBe(true);
    expect(restored.topologyId).toBe("rhombille");

    const squareSnapshot = new GameModel({ seed: 99, topology: "square" }).createSnapshot();
    const legacy = { ...squareSnapshot, version: 1 } as Record<string, unknown>;
    delete legacy.topology;
    const migrated = new GameModel({ seed: 1, autoStart: false, topology: "triangular" });
    expect(migrated.restoreSnapshot(legacy)).toBe(true);
    expect(migrated.topologyId).toBe("square");
  });
});

describe("compact chunk state", () => {
  it("handles negative coordinates and removes empty chunks", () => {
    const store = new CellStore();
    expect(floorDiv(-1, 64)).toBe(-1);
    store.set(-1, -1, CellState.Flagged);
    store.set(64, 64, CellState.Question);
    expect(store.get(-1, -1)).toBe(CellState.Flagged);
    expect(store.get(64, 64)).toBe(CellState.Question);
    expect(store.chunkCount).toBe(2);
    store.set(-1, -1, CellState.Covered);
    expect(store.chunkCount).toBe(1);
  });

  it("stores only interacted chunks, not generated covered cells", () => {
    const game = new GameModel({ seed: 8, autoStart: false });
    for (let index = 0; index < 10_000; index += 1) game.mineAt(index, -index);
    expect(game.store.chunkCount).toBe(0);
    game.cycleMark(1_000_000, -1_000_000);
    expect(game.store.chunkCount).toBe(1);
  });

  it("packs and restores sparse cells without materializing covered terrain", () => {
    const source = new CellStore();
    source.set(-1_000_000, 1_000_000, CellState.Flagged);
    source.set(19, -27, CellState.Opened4);
    source.set(64, 64, CellState.Exploded);

    const packed = source.pack();
    expect(packed.byteLength).toBe(3 * 9);
    const restored = new CellStore();
    expect(restored.restorePacked(packed)).toBe(true);
    expect(restored.get(-1_000_000, 1_000_000)).toBe(CellState.Flagged);
    expect(restored.get(19, -27)).toBe(CellState.Opened4);
    expect(restored.get(64, 64)).toBe(CellState.Exploded);
    expect(restored.nonZeroCells).toBe(3);
    expect(restored.openedCells).toBe(2);
  });

  it("iterates only nonzero cells inside bounded world coordinates", () => {
    const store = new CellStore();
    store.set(-65, -65, CellState.Opened1);
    store.set(-1, -1, CellState.Flagged);
    store.set(0, 0, CellState.Opened2);
    store.set(63, 63, CellState.Question);
    store.set(64, 64, CellState.Exploded);
    const visited: Array<[number, number, CellState]> = [];

    store.forEachNonZeroInBounds(-1, -1, 63, 63, (x, y, state) => visited.push([x, y, state]));

    expect(visited).toEqual([
      [-1, -1, CellState.Flagged],
      [0, 0, CellState.Opened2],
      [63, 63, CellState.Question],
    ]);
  });
});

describe("saved games", () => {
  it("round-trips the field, safe origin, progress, and marks", () => {
    const source = new GameModel({ mode: "master", seed: 991, autoStart: false });
    source.reveal(-12, 37);
    source.cycleMark(100, -90);
    let mineX = 200;
    while (!source.mineAt(mineX, 200)) mineX += 1;
    source.reveal(mineX, 200);
    source.health = 0;
    expect(source.cheatDeath()).toBe(true);

    const snapshot = source.createSnapshot();
    expect(snapshot.cells.byteLength).toBe(source.store.nonZeroCells * 9);
    const restored = new GameModel({ seed: 1, autoStart: false });
    expect(restored.restoreSnapshot(snapshot)).toBe(true);
    expect(restored.mode).toBe(source.mode);
    expect(restored.seed).toBe(source.seed);
    expect(restored.score).toBe(source.score);
    expect(restored.things).toBe(source.things);
    expect(restored.health).toBe(source.health);
    expect(restored.cheats).toBe(source.cheats);
    expect(restored.started).toBe(true);
    expect(restored.bounds).toEqual(source.bounds);
    expect(restored.store.nonZeroCells).toBe(source.store.nonZeroCells);
    expect(restored.store.openedCells).toBe(source.store.openedCells);
    source.store.forEachNonZero((x, y, state) => expect(restored.getState(x, y)).toBe(state));
    for (let y = 35; y <= 39; y += 1) {
      for (let x = -14; x <= -10; x += 1) expect(restored.mineAt(x, y)).toBe(false);
    }
  });

  it("restores pre-cheat snapshots as clean runs", () => {
    const snapshot = new GameModel({ seed: 41 }).createSnapshot();
    delete snapshot.cheats;
    const restored = new GameModel({ seed: 1, autoStart: false });
    expect(restored.restoreSnapshot(snapshot)).toBe(true);
    expect(restored.cheats).toBe(0);
  });

  it("rejects a corrupt snapshot without replacing the current field", () => {
    const source = new GameModel({ seed: 22 });
    const snapshot = source.createSnapshot();
    const corruptCells = snapshot.cells.slice(0);
    new DataView(corruptCells).setUint8(8, CellState.Queued);
    const target = new GameModel({ seed: 77 });
    const previousSeed = target.seed;
    const previousCells = target.store.nonZeroCells;

    expect(target.restoreSnapshot({ ...snapshot, cells: corruptCells })).toBe(false);
    expect(target.seed).toBe(previousSeed);
    expect(target.store.nonZeroCells).toBe(previousCells);
  });
});

describe("gameplay", () => {
  it("opens a playable island immediately", () => {
    const game = new GameModel({ seed: 123 });
    expect(game.started).toBe(true);
    expect(game.store.openedCells).toBeGreaterThanOrEqual(25);
    expect(game.getState(0, 0)).toBe(CellState.Opened);
    expect(game.bounds).not.toBeNull();
  });

  it("cycles flag, question, and clear", () => {
    const game = new GameModel({ seed: 123 });
    const flagged = game.cycleMark(100, 100);
    expect(game.getState(100, 100)).toBe(CellState.Flagged);
    expect(flagged.damage).toEqual({ minX: 100, minY: 100, maxX: 100, maxY: 100 });
    const questioned = game.cycleMark(100, 100);
    expect(game.getState(100, 100)).toBe(CellState.Question);
    expect(questioned.damage).toEqual(flagged.damage);
    const cleared = game.cycleMark(100, 100);
    expect(game.getState(100, 100)).toBe(CellState.Covered);
    expect(cleared.damage).toEqual(flagged.damage);
  });

  it("reports exact aggregate damage bounds for cascades and no bounds for guarded no-ops", () => {
    const game = new GameModel({ seed: 123, autoStart: false });
    const opened = game.reveal(0, 0);
    expect(opened.changed).toBeGreaterThan(1);
    expect(opened.damage).toEqual(game.bounds);
    expect(game.reveal(0, 0).damage).toBeNull();
  });

  it("places deterministic artifacts only on zero-clue, mine-free cells", () => {
    const game = new GameModel({ mode: "impossible", seed: 712, autoStart: false });
    const matching = new GameModel({ mode: "impossible", seed: 712, autoStart: false });
    let artifacts = 0;
    for (let y = -100; y <= 100; y += 1) {
      for (let x = -100; x <= 100; x += 1) {
        expect(game.artifactAt(x, y)).toBe(matching.artifactAt(x, y));
        if (!game.artifactAt(x, y)) continue;
        artifacts += 1;
        expect(game.mineAt(x, y)).toBe(false);
        expect(game.clueAt(x, y)).toBe(0);
      }
    }
    expect(artifacts).toBeGreaterThan(40);
  });

  it("deathmatch starts with one life", () => {
    const game = new GameModel({ mode: "deathmatch", seed: 5 });
    expect(game.health).toBe(1);
  });

  it("cheats death only after game over and resets on a new field", () => {
    const game = new GameModel({ mode: "deathmatch", seed: 5, autoStart: false });
    expect(game.cheatDeath()).toBe(false);
    game.reveal(0, 0);
    let mineX = 100;
    while (!game.mineAt(mineX, 100)) mineX += 1;
    game.reveal(mineX, 100);
    expect(game.alive).toBe(false);

    expect(game.cheatDeath()).toBe(true);
    expect(game.health).toBe(1);
    expect(game.cheats).toBe(1);
    expect(game.cheatDeath()).toBe(false);

    game.reset("deathmatch", 6, false);
    expect(game.cheats).toBe(0);
    expect(game.health).toBe(1);
  });

  it("chords an opened number when its neighboring mines are flagged", () => {
    const game = new GameModel({ seed: 1, autoStart: false });
    vi.spyOn(game, "mineAt").mockImplementation((x, y) => Math.abs(x % 2) === 1 && Math.abs(y % 2) === 1);
    game.reveal(0, 0);
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      game.cycleMark(x, y);
    }

    expect(game.previewClickCells(0, 0)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: -1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]);
    const result = game.reveal(0, 0);
    expect(result.changed).toBe(4);
    expect(isOpened(game.getState(0, -1))).toBe(true);
    expect(isOpened(game.getState(1, 0))).toBe(true);
  });

  it("auto-flags when every remaining neighbor must be a mine", () => {
    const game = new GameModel({ seed: 1, autoStart: false });
    vi.spyOn(game, "mineAt").mockImplementation((x, y) => Math.abs(x % 2) === 1 && Math.abs(y % 2) === 1);
    game.reveal(0, 0);
    game.reveal(0, -1);
    game.reveal(1, 0);
    game.reveal(0, 1);
    game.reveal(-1, 0);

    expect(game.previewClickCells(0, 0)).toEqual([
      { x: 0, y: 0 },
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: -1, y: 1 },
      { x: 1, y: 1 },
    ]);
    const result = game.reveal(0, 0);
    expect(result.autoFlagged).toBe(4);
    expect(game.getState(1, 1)).toBe(CellState.Flagged);
    expect(game.getState(-1, -1)).toBe(CellState.Flagged);
  });

  it("bounds invalid chords and mine blasts across topologies and signed chunk seams", () => {
    const anchors: ReadonlyArray<readonly [number, number]> = [
      [-7, -1],
      [-64, -64],
      [-65, -65],
      [63, -65],
      [64, 64],
    ];

    for (const topologyId of TOPOLOGY_IDS) {
      for (const [centerX, centerY] of anchors) {
        const overFlagged = new GameModel({ mode: "impossible", seed: 84, autoStart: false, topology: topologyId });
        const neighbors: Array<[number, number]> = [];
        overFlagged.topology.forEachNeighbor(centerX, centerY, (x, y) => neighbors.push([x, y]));
        overFlagged.store.set(centerX, centerY, CellState.Opened2);
        for (const [x, y] of neighbors.slice(0, 3)) overFlagged.store.set(x, y, CellState.Flagged);
        const healthBeforeNoOp = overFlagged.health;
        const noOp = overFlagged.reveal(centerX, centerY);
        expect(noOp, `${topologyId} over-flagged at ${centerX},${centerY}`).toEqual({
          changed: 0,
          scoreDelta: 0,
          thingsDelta: 0,
          healthDelta: 0,
          exploded: false,
          autoFlagged: 0,
          damage: null,
        });
        expect(overFlagged.health).toBe(healthBeforeNoOp);

        const connectedMines = new GameModel({
          mode: "impossible",
          seed: 84,
          autoStart: false,
          topology: topologyId,
        });
        connectedMines.store.set(centerX, centerY, CellState.Opened4);
        const wrongFlags = new Set(neighbors.slice(0, 4).map(([x, y]) => `${x},${y}`));
        const initialKeys = new Set(neighbors.map(([x, y]) => `${x},${y}`));
        const actualMines = new Set(neighbors.slice(4, 8).map(([x, y]) => `${x},${y}`));
        for (const [x, y] of neighbors.slice(0, 4)) connectedMines.store.set(x, y, CellState.Flagged);
        let mineLookups = 0;
        vi.spyOn(connectedMines, "mineAt").mockImplementation((x, y) => {
          mineLookups += 1;
          if (mineLookups > 2_000) throw new Error("unbounded mine-chain traversal");
          const key = `${x},${y}`;
          return actualMines.has(key) || ((x !== centerX || y !== centerY) && !initialKeys.has(key) && !wrongFlags.has(key));
        });

        expect(connectedMines.clueAt(centerX, centerY)).toBe(4);
        mineLookups = 0;
        const blast = connectedMines.reveal(centerX, centerY);
        expect(blast.exploded, `${topologyId} blast at ${centerX},${centerY}`).toBe(true);
        expect(blast.changed).toBe(neighbors.length - 4);
        expect(blast.healthDelta).toBe(-1);
        expect(mineLookups).toBeLessThan(200);
        expect(blast.damage).not.toBeNull();
        expect(blast.damage!.minX).toBeGreaterThanOrEqual(Math.min(...neighbors.map(([x]) => x)));
        expect(blast.damage!.maxX).toBeLessThanOrEqual(Math.max(...neighbors.map(([x]) => x)));
        expect(blast.damage!.minY).toBeGreaterThanOrEqual(Math.min(...neighbors.map(([, y]) => y)));
        expect(blast.damage!.maxY).toBeLessThanOrEqual(Math.max(...neighbors.map(([, y]) => y)));

        const secondaryMine = neighbors
          .flatMap(([x, y]) => {
            const secondary: Array<[number, number]> = [];
            connectedMines.topology.forEachNeighbor(x, y, (nextX, nextY) => secondary.push([nextX, nextY]));
            return secondary;
          })
          .find(([x, y]) => (x !== centerX || y !== centerY) && !initialKeys.has(`${x},${y}`));
        expect(secondaryMine).toBeDefined();
        expect(connectedMines.getState(secondaryMine![0], secondaryMine![1])).toBe(CellState.Covered);
        expect(connectedMines.store.nonZeroCells).toBe(neighbors.length + 1);
      }
    }
  });
});
