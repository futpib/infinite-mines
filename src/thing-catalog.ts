import { installThingAlphaResolver } from "./thing-alpha-footprints";

export interface ThingCatalog {
  readonly files: readonly string[];
}

let catalog: ThingCatalog | null = null;
let catalogPromise: Promise<ThingCatalog> | null = null;

export const loadThingCatalog = (): Promise<ThingCatalog> => {
  if (!catalogPromise) {
    catalogPromise = import("./thing-catalog-full").then((module) => {
      installThingAlphaResolver(module.fullThingAlphaOffsets);
      catalog = { files: module.THING_CATALOG_FILES };
      return catalog;
    });
  }
  return catalogPromise;
};

export const loadedThingCatalog = (): ThingCatalog | null => catalog;
