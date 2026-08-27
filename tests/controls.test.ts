import { describe, expect, it } from "vitest";
import { requiresRevealGuard } from "../src/controls";
import { CellState } from "../src/model";

describe("guarded controls", () => {
  it("guards only interactions that could directly open a concealed tile", () => {
    expect(requiresRevealGuard(CellState.Covered)).toBe(true);
    expect(requiresRevealGuard(CellState.Question)).toBe(true);
    expect(requiresRevealGuard(CellState.Opened3)).toBe(false);
    expect(requiresRevealGuard(CellState.Flagged)).toBe(false);
    expect(requiresRevealGuard(CellState.Exploded)).toBe(false);
  });
});
