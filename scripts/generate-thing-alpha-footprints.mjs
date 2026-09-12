import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEXTURE_PIXELS = 512;
const TEXTURE_PADDING = 16;
const TRIANGULAR_FIT = 0.9;
const RHOMBILLE_FIT = 0.8;
const SPRITES = [
  "emoji_u1f3f0.svg",
  "emoji_u1f3ef.svg",
  "emoji_u1f5ff.svg",
  "emoji_u1f6f8.svg",
  "emoji_u1f680.svg",
  "emoji_u26f5.svg",
  "emoji_u1f30b.svg",
  "emoji_u1f3aa.svg",
  "emoji_u1f995.svg",
  "emoji_u1f409.svg",
  "emoji_u1f334.svg",
  "emoji_u26c4.svg",
];

const positiveModulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

const topologyVariant = (topology, x, y) =>
  topology === "triangular" ? positiveModulo(x + y, 2) : topology === "rhombille" ? positiveModulo(x, 3) : 0;

const variantAnchor = (topology, variant) =>
  topology === "square" ? { x: 0, y: 0 } : { x: variant, y: 0 };

const spatialTemplate = (topology, anchorX, anchorY, count) => {
  const anchorCenter = topology.geometry(anchorX, anchorY).center;
  const frontier = [];
  const queued = new Set();
  const enqueue = (x, y) => {
    const key = `${x},${y}`;
    if (queued.has(key)) return;
    queued.add(key);
    const center = topology.geometry(x, y).center;
    frontier.push({
      x,
      y,
      distance: (center.x - anchorCenter.x) ** 2 + (center.y - anchorCenter.y) ** 2,
    });
  };
  enqueue(anchorX, anchorY);
  const cells = [];
  while (cells.length < count) {
    frontier.sort((left, right) => {
      const distance = left.distance - right.distance;
      return Math.abs(distance) > 1e-12 ? distance : left.y - right.y || left.x - right.x;
    });
    const candidate = frontier.shift();
    if (!candidate) throw new Error("Thing spatial template cannot reach its requested cell count");
    cells.push({ x: candidate.x, y: candidate.y });
    for (const neighbor of topology.edgeNeighbors(candidate.x, candidate.y)) enqueue(neighbor.x, neighbor.y);
  }
  return cells;
};

const pointInConvexPolygon = (x, y, vertices) => {
  let sign = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const cross = (end.x - start.x) * (y - start.y) - (end.y - start.y) * (x - start.x);
    if (Math.abs(cross) <= 1e-9) continue;
    const nextSign = cross < 0 ? -1 : 1;
    if (sign !== 0 && nextSign !== sign) return false;
    sign = nextSign;
  }
  return true;
};

const artBounds = (topologyId, topology, visual) => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const cell of visual) {
    for (const vertex of topology.geometry(cell.x, cell.y).vertices) {
      minX = Math.min(minX, vertex.x);
      minY = Math.min(minY, vertex.y);
      maxX = Math.max(maxX, vertex.x);
      maxY = Math.max(maxY, vertex.y);
    }
  }
  if (topologyId !== "square") {
    const fit = topologyId === "triangular" ? TRIANGULAR_FIT : RHOMBILLE_FIT;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const halfWidth = ((maxX - minX) * fit) / 2;
    const halfHeight = ((maxY - minY) * fit) / 2;
    minX = centerX - halfWidth;
    maxX = centerX + halfWidth;
    minY = centerY - halfHeight;
    maxY = centerY + halfHeight;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
};

const dilateAlpha = (source) => {
  const result = new Uint8Array(source.length);
  for (let y = 0; y < TEXTURE_PIXELS; y += 1) {
    for (let x = 0; x < TEXTURE_PIXELS; x += 1) {
      if (source[y * TEXTURE_PIXELS + x] === 0) continue;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const targetY = y + offsetY;
        if (targetY < 0 || targetY >= TEXTURE_PIXELS) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const targetX = x + offsetX;
          if (targetX < 0 || targetX >= TEXTURE_PIXELS) continue;
          result[targetY * TEXTURE_PIXELS + targetX] = 1;
        }
      }
    }
  }
  return result;
};

const cellTouchesAlpha = (topology, cell, bounds, alpha) => {
  const vertices = topology.geometry(cell.x, cell.y).vertices;
  const cellMinX = Math.min(...vertices.map((vertex) => vertex.x));
  const cellMinY = Math.min(...vertices.map((vertex) => vertex.y));
  const cellMaxX = Math.max(...vertices.map((vertex) => vertex.x));
  const cellMaxY = Math.max(...vertices.map((vertex) => vertex.y));
  const minPixelX = Math.max(0, Math.floor(((cellMinX - bounds.minX) / bounds.width) * TEXTURE_PIXELS) - 1);
  const minPixelY = Math.max(0, Math.floor(((cellMinY - bounds.minY) / bounds.height) * TEXTURE_PIXELS) - 1);
  const maxPixelX = Math.min(
    TEXTURE_PIXELS - 1,
    Math.ceil(((cellMaxX - bounds.minX) / bounds.width) * TEXTURE_PIXELS) + 1,
  );
  const maxPixelY = Math.min(
    TEXTURE_PIXELS - 1,
    Math.ceil(((cellMaxY - bounds.minY) / bounds.height) * TEXTURE_PIXELS) + 1,
  );
  for (let pixelY = minPixelY; pixelY <= maxPixelY; pixelY += 1) {
    for (let pixelX = minPixelX; pixelX <= maxPixelX; pixelX += 1) {
      if (alpha[pixelY * TEXTURE_PIXELS + pixelX] === 0) continue;
      const worldX = bounds.minX + ((pixelX + 0.5) / TEXTURE_PIXELS) * bounds.width;
      const worldY = bounds.minY + ((pixelY + 0.5) / TEXTURE_PIXELS) * bounds.height;
      if (pointInConvexPolygon(worldX, worldY, vertices)) return true;
    }
  }
  return false;
};

const rasterize = async (page, svg) =>
  page.evaluate(
    async ({ svg, pixels, padding }) => {
      const source = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
      const image = new Image();
      image.decoding = "sync";
      const loaded = new Promise((resolve, reject) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => reject(new Error("Unable to decode Thing SVG")), { once: true });
      });
      image.src = source;
      await loaded;

      const measurement = document.createElement("canvas");
      measurement.width = pixels;
      measurement.height = pixels;
      const measurementContext = measurement.getContext("2d", { willReadFrequently: true });
      measurementContext.drawImage(image, 0, 0, pixels, pixels);
      const measured = measurementContext.getImageData(0, 0, pixels, pixels).data;
      let minX = pixels;
      let minY = pixels;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < pixels; y += 1) {
        for (let x = 0; x < pixels; x += 1) {
          if (measured[(y * pixels + x) * 4 + 3] === 0) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (maxX < minX || maxY < minY) throw new Error("Thing SVG has no visible alpha");

      const target = document.createElement("canvas");
      target.width = pixels;
      target.height = pixels;
      const context = target.getContext("2d", { willReadFrequently: true });
      const scale = Math.min((pixels - padding * 2) / (maxX - minX + 1), (pixels - padding * 2) / (maxY - minY + 1));
      const centerX = (minX + maxX + 1) / 2;
      const centerY = (minY + maxY + 1) / 2;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        image,
        pixels / 2 - centerX * scale,
        pixels / 2 - centerY * scale,
        pixels * scale,
        pixels * scale,
      );
      const data = context.getImageData(0, 0, pixels, pixels).data;
      const alpha = new Array(pixels * pixels);
      for (let index = 0; index < alpha.length; index += 1) alpha[index] = Number(data[index * 4 + 3] !== 0);
      return alpha;
    },
    { svg, pixels: TEXTURE_PIXELS, padding: TEXTURE_PADDING },
  );

const main = async () => {
  const vite = await createServer({ root: ROOT, logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
  const { TOPOLOGIES } = await vite.ssrLoadModule("/src/topology.ts");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("about:blank");
  const alphaMasks = [];
  for (const filename of SPRITES) {
    const svg = await readFile(path.join(ROOT, "src/assets/things", filename), "utf8");
    alphaMasks.push(dilateAlpha(Uint8Array.from(await rasterize(page, svg))));
  }

  const entries = [];
  const counts = [];
  for (const topologyId of ["square", "triangular", "rhombille"]) {
    const topology = TOPOLOGIES[topologyId];
    const variants = topologyId === "square" ? 1 : topologyId === "triangular" ? 2 : 3;
    for (let variant = 0; variant < variants; variant += 1) {
      const anchor = variantAnchor(topologyId, variant);
      if (topologyVariant(topologyId, anchor.x, anchor.y) !== variant) throw new Error("Invalid variant anchor");
      for (const side of [3, 4]) {
        const reservedSide = side + 2;
        const candidates =
          topologyId === "square"
            ? Array.from({ length: reservedSide ** 2 }, (_, index) => ({
                x: anchor.x - 1 + (index % reservedSide),
                y: anchor.y - 1 + Math.floor(index / reservedSide),
              }))
            : spatialTemplate(topology, anchor.x, anchor.y, reservedSide ** 2);
        const visual =
          topologyId === "square"
            ? Array.from({ length: side ** 2 }, (_, index) => ({
                x: anchor.x + (index % side),
                y: anchor.y + Math.floor(index / side),
              }))
            : candidates.slice(0, side ** 2);
        const bounds = artBounds(topologyId, topology, visual);
        for (let sprite = 0; sprite < SPRITES.length; sprite += 1) {
          const cells = candidates
            .filter((cell) => cellTouchesAlpha(topology, cell, bounds, alphaMasks[sprite]))
            .map((cell) => [cell.x - anchor.x, cell.y - anchor.y])
            .sort((left, right) => left[1] - right[1] || left[0] - right[0]);
          if (cells.length === 0) throw new Error(`Empty alpha footprint for ${topologyId}/${variant}/${side}/${sprite}`);
          entries.push([`${topologyId}:${variant}:${side}:${sprite}`, cells.flat()]);
          counts.push(cells.length);
        }
      }
    }
  }

  const lines = [
    "// Generated by scripts/generate-thing-alpha-footprints.mjs.",
    "// Each pair is a topology-cell offset whose interior intersects non-zero SVG alpha.",
    "// The one-texel dilation matches the production atlas linear-filter footprint.",
    'import type { TopologyId } from "./topology";',
    "",
    "const THING_ALPHA_FOOTPRINTS: Readonly<Record<string, readonly number[]>> = {",
    ...entries.map(([key, offsets]) => `  ${JSON.stringify(key)}: [${offsets.join(", ")}],`),
    "};",
    "",
    "const positiveModulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;",
    "",
    "export const thingTopologyVariant = (topology: TopologyId, x: number, y: number): number =>",
    '  topology === "triangular" ? positiveModulo(x + y, 2) : topology === "rhombille" ? positiveModulo(x, 3) : 0;',
    "",
    "export const thingAlphaOffsets = (",
    "  topology: TopologyId,",
    "  anchorX: number,",
    "  anchorY: number,",
    "  side: number,",
    "  sprite: number,",
    "): readonly number[] => {",
    "  const key = `${topology}:${thingTopologyVariant(topology, anchorX, anchorY)}:${side}:${sprite}`;",
    "  const offsets = THING_ALPHA_FOOTPRINTS[key];",
    '  if (!offsets) throw new Error(`Missing Thing alpha footprint: ${key}`);',
    "  return offsets;",
    "};",
  ];
  await writeFile(path.join(ROOT, "src/thing-alpha-footprints.ts"), `${lines.join("\n")}\n`);
  await browser.close();
  await vite.close();
  console.log(
    JSON.stringify({ patterns: entries.length, minCells: Math.min(...counts), maxCells: Math.max(...counts), chromium: await chromium.executablePath() }),
  );
};

await main();
