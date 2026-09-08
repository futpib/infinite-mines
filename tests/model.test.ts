import { describe, expect, it, vi } from "vitest";
import {
  CUSTOM_DENSITY_MIN,
  MAX_CHAIN_EXPLOSIONS_PER_ACTION,
  ORIGINAL_AVAILABLE_CELL_FRACTION,
  PRESET_DENSITIES,
  THING_LARGE_RESERVED_SIDE,
  THING_SMALL_PROBABILITY,
  THING_SMALL_RESERVED_SIDE,
  THING_ZONE_SIZE,
  CellState,
  CellStore,
  DIFFICULTIES,
  GameModel,
  MODES,
  floorDiv,
  hash32,
  isOpened,
  openedClue,
  thingReservedSideForRoll,
} from "../src/model";
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

  it("tracks the requested per-cell chance and original effective density over a large sample", () => {
    for (const mode of MODES) {
      const game = new GameModel({ mode, seed: 91, autoStart: false });
      let mines = 0;
      let eligible = 0;
      const side = 400;
      for (let y = 1000; y < 1000 + side; y += 1) {
        for (let x = 1000; x < 1000 + side; x += 1) {
          mines += Number(game.mineAt(x, y));
          eligible += Number(!game.thingFootprintAt(x, y));
        }
      }
      const observed = mines / (side * side);
      expect(Math.abs(observed - DIFFICULTIES[mode].density * ORIGINAL_AVAILABLE_CELL_FRACTION)).toBeLessThan(0.008);
      expect(Math.abs(mines / eligible - DIFFICULTIES[mode].density)).toBeLessThan(0.008);
    }

    const custom = new GameModel({ mode: "custom", density: 0.1234, seed: 91, autoStart: false });
    let customMines = 0;
    const side = 400;
    for (let y = 1000; y < 1000 + side; y += 1) {
      for (let x = 1000; x < 1000 + side; x += 1) customMines += Number(custom.mineAt(x, y));
    }
    expect(Math.abs(customMines / (side * side) - 0.1234 * ORIGINAL_AVAILABLE_CELL_FRACTION)).toBeLessThan(0.008);
  });

  it("uses the original nominal presets and exact Thing size distribution", () => {
    expect(ORIGINAL_AVAILABLE_CELL_FRACTION).toBe(3295 / 3456);
    for (const mode of ["beginner", "master", "ultimate", "impossible", "deathmatch"] as const) {
      expect(DIFFICULTIES[mode].density).toBe(PRESET_DENSITIES[mode]);
    }
    expect(THING_ZONE_SIZE).toBe(24);
    expect(THING_SMALL_PROBABILITY).toBe(5 / 6);
    expect(thingReservedSideForRoll(0)).toBe(THING_SMALL_RESERVED_SIDE);
    expect(thingReservedSideForRoll(THING_SMALL_PROBABILITY - Number.EPSILON)).toBe(THING_SMALL_RESERVED_SIDE);
    expect(thingReservedSideForRoll(THING_SMALL_PROBABILITY)).toBe(THING_LARGE_RESERVED_SIDE);
    expect(thingReservedSideForRoll(1 - Number.EPSILON)).toBe(THING_LARGE_RESERVED_SIDE);
  });

  it("realizes the original five-in-six small Thing probability across deterministic zones", () => {
    const game = new GameModel({ seed: 0x5eed_1234, autoStart: false });
    let small = 0;
    const zones = 600;
    for (let zoneX = -zones / 2; zoneX < zones / 2; zoneX += 1) {
      let reserved = 0;
      for (let localY = 0; localY < THING_ZONE_SIZE; localY += 1) {
        for (let localX = 0; localX < THING_ZONE_SIZE; localX += 1) {
          reserved += Number(game.thingFootprintAt(zoneX * THING_ZONE_SIZE + localX, localY));
        }
      }
      expect([THING_SMALL_RESERVED_SIDE ** 2, THING_LARGE_RESERVED_SIDE ** 2]).toContain(reserved);
      if (reserved === THING_SMALL_RESERVED_SIDE ** 2) small += 1;
    }
    expect(small / zones).toBeCloseTo(THING_SMALL_PROBABILITY, 1);
  });

  it("uses the original padded square footprint and anchor placement on Square", () => {
    const game = new GameModel({ seed: 0xa471_f4c7, autoStart: false, topology: "square" });
    for (let zoneX = -16; zoneX < 16; zoneX += 1) {
      const reserved: Array<{ x: number; y: number }> = [];
      const artifacts: Array<{ x: number; y: number }> = [];
      for (let y = 0; y < THING_ZONE_SIZE; y += 1) {
        for (let x = 0; x < THING_ZONE_SIZE; x += 1) {
          const worldX = zoneX * THING_ZONE_SIZE + x;
          if (game.thingFootprintAt(worldX, y)) reserved.push({ x, y });
          if (game.artifactAt(worldX, y)) artifacts.push({ x, y });
        }
      }
      const minX = Math.min(...reserved.map((cell) => cell.x));
      const maxX = Math.max(...reserved.map((cell) => cell.x));
      const minY = Math.min(...reserved.map((cell) => cell.y));
      const maxY = Math.max(...reserved.map((cell) => cell.y));
      const side = Math.sqrt(reserved.length);
      expect([THING_SMALL_RESERVED_SIDE, THING_LARGE_RESERVED_SIDE]).toContain(side);
      expect(maxX - minX + 1).toBe(side);
      expect(maxY - minY + 1).toBe(side);
      expect(maxX).toBeLessThan(THING_ZONE_SIZE - 1);
      expect(maxY).toBeLessThan(THING_ZONE_SIZE - 1);
      expect(artifacts).toEqual([{ x: minX + 1, y: minY + 1 }]);
    }
  });

  it("rejects custom densities outside the supported 12% to 50% range", () => {
    expect(() => new GameModel({ mode: "custom", density: 0.119, autoStart: false })).toThrow(RangeError);
    expect(() => new GameModel({ mode: "custom", density: 0.501, autoStart: false })).toThrow(RangeError);
  });

  it("keeps minimum-density opening floods bounded across representative fields", { timeout: 10_000 }, () => {
    for (const topology of TOPOLOGY_IDS) {
      for (let seed = 0; seed < 32; seed += 1) {
        const game = new GameModel({ mode: "custom", density: CUSTOM_DENSITY_MIN, seed, topology });
        expect(game.store.openedCells, `${topology} seed ${seed}`).toBeLessThan(100_000);
      }
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

  it("persists generation in v4 and restores older fields under their original rules", () => {
    const source = new GameModel({ seed: 99, topology: "rhombille", autoStart: false });
    const snapshot = source.createSnapshot();
    expect(snapshot.version).toBe(4);
    expect(snapshot.generation).toBe("original-things");
    expect(snapshot.topology).toBe("rhombille");
    expect(snapshot.density).toBe(DIFFICULTIES.beginner.density);
    const restored = new GameModel({ seed: 1, autoStart: false });
    expect(restored.restoreSnapshot(snapshot)).toBe(true);
    expect(restored.topologyId).toBe("rhombille");
    expect(restored.density).toBe(DIFFICULTIES.beginner.density);
    expect(restored.fieldGeneration).toBe("original-things");

    const oldV3 = {
      ...snapshot,
      version: 3,
      density: PRESET_DENSITIES.beginner * ORIGINAL_AVAILABLE_CELL_FRACTION,
    } as Record<string, unknown>;
    delete oldV3.generation;
    const preserved = new GameModel({ seed: 1, autoStart: false });
    expect(preserved.restoreSnapshot(oldV3)).toBe(true);
    expect(preserved.density).toBe(PRESET_DENSITIES.beginner * ORIGINAL_AVAILABLE_CELL_FRACTION);
    expect(preserved.fieldGeneration).toBe("legacy-flat");
    expect(preserved.thingFootprintAt(0, 0)).toBe(false);
    expect(preserved.createSnapshot()).toMatchObject({ version: 4, generation: "legacy-flat" });

    const oldV2 = { ...snapshot, version: 2 } as Record<string, unknown>;
    delete oldV2.density;
    delete oldV2.generation;
    const nominalLegacy = new GameModel({ seed: 1, autoStart: false });
    expect(nominalLegacy.restoreSnapshot(oldV2)).toBe(true);
    expect(nominalLegacy.density).toBe(PRESET_DENSITIES.beginner);
    expect(nominalLegacy.fieldGeneration).toBe("legacy-flat");

    const squareSnapshot = new GameModel({
      seed: 99,
      topology: "square",
      density: PRESET_DENSITIES.beginner,
      autoStart: false,
    }).createSnapshot();
    const legacy = { ...squareSnapshot, version: 1 } as Record<string, unknown>;
    delete legacy.topology;
    delete legacy.density;
    delete legacy.generation;
    const migrated = new GameModel({ seed: 1, autoStart: false, topology: "triangular" });
    expect(migrated.restoreSnapshot(legacy)).toBe(true);
    expect(migrated.topologyId).toBe("square");
    expect(migrated.density).toBe(PRESET_DENSITIES.beginner);
    expect(migrated.fieldGeneration).toBe("legacy-flat");
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
    expect(restored.density).toBe(source.density);
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

  it("migrates a stale numbered Thing from an old field to opened zero", () => {
    const source = new GameModel({ mode: "impossible", seed: 712, autoStart: false, topology: "triangular" });
    let artifact: { x: number; y: number } | null = null;
    for (let y = -100; y <= 100 && !artifact; y += 1) {
      for (let x = -100; x <= 100; x += 1) {
        if (source.artifactAt(x, y)) {
          artifact = { x, y };
          break;
        }
      }
    }
    if (!artifact) throw new Error("No artifact found for stale-save fixture");
    source.store.set(artifact.x, artifact.y, CellState.Opened4);
    source.store.set(500, -500, CellState.Flagged);
    source.things = 7;

    const restored = new GameModel({ seed: 1, autoStart: false });
    expect(restored.restoreSnapshot(source.createSnapshot())).toBe(true);
    expect(restored.artifactAt(artifact.x, artifact.y)).toBe(true);
    expect(restored.clueAt(artifact.x, artifact.y)).toBe(0);
    expect(restored.getState(artifact.x, artifact.y)).toBe(CellState.Opened);
    expect(restored.getState(500, -500)).toBe(CellState.Flagged);
    expect(restored.things).toBe(7);
  });

  it("rejects a corrupt snapshot without replacing the current field", () => {
    const source = new GameModel({ seed: 22 });
    const snapshot = source.createSnapshot();
    const corruptCells = snapshot.cells.slice(0);
    new DataView(corruptCells).setUint8(8, CellState.Queued);
    const target = new GameModel({ seed: 77 });
    const previousSeed = target.seed;
    const previousCells = target.store.nonZeroCells;

    expect(target.restoreSnapshot({ ...snapshot, density: 0.9 })).toBe(false);
    expect(target.seed).toBe(previousSeed);
    expect(target.store.nonZeroCells).toBe(previousCells);
    expect(target.restoreSnapshot({ ...snapshot, generation: "future" })).toBe(false);
    expect(target.seed).toBe(previousSeed);
    expect(target.store.nonZeroCells).toBe(previousCells);
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

  it("reserves exact deterministic Thing footprints and keeps their simple artifacts at clue zero", { timeout: 10_000 }, () => {
    for (const topology of TOPOLOGY_IDS) {
      for (const mode of MODES) {
        const game = new GameModel({ mode, seed: 712, autoStart: false, topology });
        const matching = new GameModel({ mode, seed: 712, autoStart: false, topology });
        let mismatches = 0;
        let reservedMines = 0;
        let nonzeroArtifacts = 0;
        for (let zoneY = -1; zoneY <= 1; zoneY += 1) {
          for (let zoneX = -1; zoneX <= 1; zoneX += 1) {
            let artifacts = 0;
            let reserved = 0;
            for (let localY = 0; localY < THING_ZONE_SIZE; localY += 1) {
              for (let localX = 0; localX < THING_ZONE_SIZE; localX += 1) {
                const x = zoneX * THING_ZONE_SIZE + localX;
                const y = zoneY * THING_ZONE_SIZE + localY;
                if (game.artifactAt(x, y) !== matching.artifactAt(x, y)) mismatches += 1;
                if (game.thingFootprintAt(x, y) !== matching.thingFootprintAt(x, y)) mismatches += 1;
                if (game.thingFootprintAt(x, y)) {
                  reserved += 1;
                  if (game.mineAt(x, y)) reservedMines += 1;
                }
                if (!game.artifactAt(x, y)) continue;
                artifacts += 1;
                if (game.clueAt(x, y) !== 0) nonzeroArtifacts += 1;
              }
            }
            expect(artifacts, `${topology}/${mode} Thing count in ${zoneX},${zoneY}`).toBe(1);
            expect(
              [THING_SMALL_RESERVED_SIDE ** 2, THING_LARGE_RESERVED_SIDE ** 2],
              `${topology}/${mode} reservation in ${zoneX},${zoneY}`,
            ).toContain(reserved);
          }
        }
        expect(mismatches, `${topology}/${mode} determinism`).toBe(0);
        expect(reservedMines, `${topology}/${mode} reserved mines`).toBe(0);
        expect(nonzeroArtifacts, `${topology}/${mode} numbered Things`).toBe(0);

        game.reveal(-64, -65);
        for (let y = -72; y <= -56; y += 1) {
          for (let x = -72; x <= -56; x += 1) {
            if (!game.artifactAt(x, y)) continue;
            expect(game.mineAt(x, y), `${topology}/${mode} safe-start mine at ${x},${y}`).toBe(false);
            expect(game.clueAt(x, y), `${topology}/${mode} safe-start clue at ${x},${y}`).toBe(0);
          }
        }
      }
    }
  });

  it("deathmatch starts with one final life and rejects cheat death without mutation", () => {
    const game = new GameModel({ mode: "deathmatch", seed: 5 });
    expect(game.health).toBe(1);
    game.health = 0;
    expect(game.canCheatDeath).toBe(false);
    expect(game.cheatDeath()).toBe(false);
    expect(game.health).toBe(0);
    expect(game.cheats).toBe(0);
  });

  it("grants Fibonacci health on successive cheat deaths and resets on a new field", () => {
    const game = new GameModel({ mode: "impossible", seed: 5, autoStart: false });
    expect(game.cheatDeath()).toBe(false);
    game.reveal(0, 0);
    game.health = 1;
    let mineX = 100;
    while (!game.mineAt(mineX, 100)) mineX += 1;
    game.reveal(mineX, 100);
    expect(game.alive).toBe(false);

    const grants = [1, 1, 2, 3, 5, 8, 13];
    for (let index = 0; index < grants.length; index += 1) {
      expect(game.nextCheatDeathHealth).toBe(grants[index]);
      expect(game.cheatDeath()).toBe(true);
      expect(game.health).toBe(grants[index]);
      expect(game.cheats).toBe(index + 1);
      if (index < grants.length - 1) game.health = 0;
    }
    expect(game.cheatDeath()).toBe(false);

    game.cheats = Number.MAX_SAFE_INTEGER;
    game.health = 0;
    expect(game.nextCheatDeathHealth).toBe(Number.MAX_SAFE_INTEGER);
    expect(game.cheatDeath()).toBe(true);
    expect(game.health).toBe(Number.MAX_SAFE_INTEGER);
    expect(game.cheats).toBe(Number.MAX_SAFE_INTEGER);

    game.reset("impossible", 6, false);
    expect(game.cheats).toBe(0);
    expect(game.health).toBe(3);
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

        const runInfiniteChain = () => {
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

          const secondaryMarks = neighbors
            .slice(4, 8)
            .flatMap(([x, y]) => {
              const secondary: Array<[number, number]> = [];
              connectedMines.topology.forEachNeighbor(x, y, (nextX, nextY) => secondary.push([nextX, nextY]));
              return secondary;
            })
            .filter(
              ([x, y], index, cells) =>
                (x !== centerX || y !== centerY) &&
                !initialKeys.has(`${x},${y}`) &&
                cells.findIndex(([otherX, otherY]) => otherX === x && otherY === y) === index,
            )
            .slice(0, 2);
          expect(secondaryMarks).toHaveLength(2);
          connectedMines.store.set(secondaryMarks[0][0], secondaryMarks[0][1], CellState.Flagged);
          connectedMines.store.set(secondaryMarks[1][0], secondaryMarks[1][1], CellState.Question);

          const isMockMine = (x: number, y: number): boolean => {
            const key = `${x},${y}`;
            return (
              actualMines.has(key) ||
              ((x !== centerX || y !== centerY) && !initialKeys.has(key) && !wrongFlags.has(key))
            );
          };
          const expectedQueue = neighbors.slice(4, 8).map(([x, y]) => ({ x, y }));
          const expectedScheduled = new Set(expectedQueue.map(({ x, y }) => `${x},${y}`));
          const expectedExploded: string[] = [];
          while (expectedQueue.length > 0) {
            const cell = expectedQueue.shift()!;
            expectedExploded.push(`${cell.x},${cell.y}`);
            connectedMines.topology.forEachNeighbor(cell.x, cell.y, (x, y) => {
              const key = `${x},${y}`;
              if (
                expectedScheduled.size >= MAX_CHAIN_EXPLOSIONS_PER_ACTION ||
                expectedScheduled.has(key) ||
                !isMockMine(x, y)
              ) {
                return;
              }
              expectedScheduled.add(key);
              expectedQueue.push({ x, y });
            });
          }
          expectedExploded.sort();

          let mineLookups = 0;
          vi.spyOn(connectedMines, "mineAt").mockImplementation((x, y) => {
            mineLookups += 1;
            if (mineLookups > 10_000) throw new Error("unbounded mine-chain traversal");
            return isMockMine(x, y);
          });

          expect(connectedMines.clueAt(centerX, centerY)).toBe(4);
          mineLookups = 0;
          const blast = connectedMines.reveal(centerX, centerY);
          const explodedCells: string[] = [];
          connectedMines.store.forEachNonZero((x, y, state) => {
            if (state === CellState.Exploded) explodedCells.push(`${x},${y}`);
          });
          explodedCells.sort();
          const overflowMine = explodedCells
            .flatMap((key) => {
              const [x, y] = key.split(",").map(Number);
              const adjacent: Array<[number, number]> = [];
              connectedMines.topology.forEachNeighbor(x, y, (nextX, nextY) => adjacent.push([nextX, nextY]));
              return adjacent;
            })
            .find(([x, y]) => connectedMines.getState(x, y) === CellState.Covered && connectedMines.mineAt(x, y));
          return {
            blast,
            expectedExploded,
            explodedCells,
            health: connectedMines.health,
            mineLookups,
            overflowMine,
            secondaryStates: secondaryMarks.map(([x, y]) => connectedMines.getState(x, y)),
            packedBytes: connectedMines.createSnapshot().cells.byteLength,
            storedCells: connectedMines.store.nonZeroCells,
          };
        };

        const first = runInfiniteChain();
        const second = runInfiniteChain();
        expect(first.blast.exploded, `${topologyId} blast at ${centerX},${centerY}`).toBe(true);
        expect(first.blast.changed).toBe(MAX_CHAIN_EXPLOSIONS_PER_ACTION + neighbors.length - 8);
        expect(first.blast.healthDelta).toBe(-1);
        expect(first.health).toBe(2);
        expect(first.explodedCells).toHaveLength(MAX_CHAIN_EXPLOSIONS_PER_ACTION);
        expect(first.explodedCells).toEqual(first.expectedExploded);
        expect(first.secondaryStates).toEqual([CellState.Exploded, CellState.Exploded]);
        expect(first.overflowMine).toBeDefined();
        expect(first.mineLookups).toBeLessThan(MAX_CHAIN_EXPLOSIONS_PER_ACTION * TOPOLOGIES[topologyId].maxNeighbors + 500);
        expect(first.blast.damage).not.toBeNull();
        expect(first.packedBytes).toBe(first.storedCells * 9);
        expect(second.blast).toEqual(first.blast);
        expect(second.explodedCells).toEqual(first.explodedCells);
      }
    }
  });
});
