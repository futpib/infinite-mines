import type { TopologyId } from "./topology";

type ThingAlphaResolver = (
  topology: TopologyId,
  anchorX: number,
  anchorY: number,
  side: number,
  sprite: number,
) => readonly number[];

let resolver: ThingAlphaResolver | null = null;

export const installThingAlphaResolver = (next: ThingAlphaResolver): void => {
  resolver = next;
};

export const thingAlphaOffsets = (
  topology: TopologyId,
  anchorX: number,
  anchorY: number,
  side: number,
  sprite: number,
): readonly number[] => {
  if (!resolver) throw new Error("Thing catalog was not loaded before field generation");
  return resolver(topology, anchorX, anchorY, side, sprite);
};
