import { CellState } from "./model";

export function requiresRevealGuard(state: CellState): boolean {
  return state === CellState.Covered || state === CellState.Question;
}
