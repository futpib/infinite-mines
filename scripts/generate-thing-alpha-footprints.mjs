import { chromium } from "@playwright/test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createServer } from "vite";
import { isExcludedThingFilename } from "./thing-catalog-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEXTURE_PIXELS = 512;
const TEXTURE_PADDING = 16;
const TRIANGULAR_FIT = 0.9;
const RHOMBILLE_FIT = 0.8;
const FIELD_ROTATIONS = [0, 90, 180, 270];
const CURATED_SPRITES = [
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

const rotateNormalized = (rotation, x, y) => {
  if (rotation === 90) return { x: -y, y: x };
  if (rotation === 180) return { x: -x, y: -y };
  if (rotation === 270) return { x: y, y: -x };
  return { x, y };
};

const cellPixelIndices = (topology, cell, bounds, rotation) => {
  const vertices = topology.geometry(cell.x, cell.y).vertices.map((vertex) => {
    const normalized = rotateNormalized(
      rotation,
      (vertex.x - bounds.minX) / bounds.width - 0.5,
      (vertex.y - bounds.minY) / bounds.height - 0.5,
    );
    return { x: normalized.x + 0.5, y: normalized.y + 0.5 };
  });
  const cellMinX = Math.min(...vertices.map((vertex) => vertex.x));
  const cellMinY = Math.min(...vertices.map((vertex) => vertex.y));
  const cellMaxX = Math.max(...vertices.map((vertex) => vertex.x));
  const cellMaxY = Math.max(...vertices.map((vertex) => vertex.y));
  const minPixelX = Math.max(0, Math.floor(cellMinX * TEXTURE_PIXELS) - 1);
  const minPixelY = Math.max(0, Math.floor(cellMinY * TEXTURE_PIXELS) - 1);
  const maxPixelX = Math.min(
    TEXTURE_PIXELS - 1,
    Math.ceil(cellMaxX * TEXTURE_PIXELS) + 1,
  );
  const maxPixelY = Math.min(
    TEXTURE_PIXELS - 1,
    Math.ceil(cellMaxY * TEXTURE_PIXELS) + 1,
  );
  const indices = [];
  for (let pixelY = minPixelY; pixelY <= maxPixelY; pixelY += 1) {
    for (let pixelX = minPixelX; pixelX <= maxPixelX; pixelX += 1) {
      const textureX = (pixelX + 0.5) / TEXTURE_PIXELS;
      const textureY = (pixelY + 0.5) / TEXTURE_PIXELS;
      if (pointInConvexPolygon(textureX, textureY, vertices)) indices.push(pixelY * TEXTURE_PIXELS + pixelX);
    }
  }
  return indices;
};

const rasterizeMasks = async (page, svg) =>
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
      const alpha = new Uint8Array(pixels * pixels);
      for (let y = 0; y < pixels; y += 1) {
        for (let x = 0; x < pixels; x += 1) {
          if (data[(y * pixels + x) * 4 + 3] === 0) continue;
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            const targetY = y + offsetY;
            if (targetY < 0 || targetY >= pixels) continue;
            for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
              const targetX = x + offsetX;
              if (targetX >= 0 && targetX < pixels) alpha[targetY * pixels + targetX] = 1;
            }
          }
        }
      }
      const samples = globalThis.__thingFootprintSamples;
      if (!samples) throw new Error("Thing footprint samples were not initialized");
      const words = [];
      const counts = [];
      for (const layout of samples) {
        let low = 0;
        let high = 0;
        let count = 0;
        for (let cell = 0; cell < layout.length; cell += 1) {
          let present = false;
          for (const index of layout[cell]) {
            if (alpha[index] === 0) continue;
            present = true;
            break;
          }
          if (!present) continue;
          count += 1;
          if (cell < 32) low = (low | (1 << cell)) >>> 0;
          else high = (high | (1 << (cell - 32))) >>> 0;
        }
        words.push(low, high);
        counts.push(count);
      }
      return { words, counts };
    },
    { svg, pixels: TEXTURE_PIXELS, padding: TEXTURE_PADDING },
  );

const main = async () => {
  const allSprites = (await readdir(path.join(ROOT, "public/things")))
    .filter((filename) => /^emoji_u[0-9a-f_]+\.svg$/.test(filename))
    .sort();
  const excludedSprites = allSprites.filter(isExcludedThingFilename);
  if (excludedSprites.length > 0) {
    throw new Error(`Excluded Thing SVGs must not ship: ${excludedSprites.join(", ")}`);
  }
  const missingCurated = CURATED_SPRITES.filter((filename) => !allSprites.includes(filename));
  if (missingCurated.length > 0) throw new Error(`Missing curated Thing SVGs: ${missingCurated.join(", ")}`);
  const curated = new Set(CURATED_SPRITES);
  const sprites = [...CURATED_SPRITES, ...allSprites.filter((filename) => !curated.has(filename))];
  const vite = await createServer({ root: ROOT, logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
  const { TOPOLOGIES } = await vite.ssrLoadModule("/src/topology.ts");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("about:blank");

  const layouts = [];
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
        for (const rotation of FIELD_ROTATIONS) {
          layouts.push({ topology: topologyId, variant, side, rotation, candidates, bounds, anchor });
        }
      }
    }
  }

  const words = new Uint32Array(layouts.length * sprites.length * 2);
  const counts = [];
  const samples = layouts.map(({ topology, rotation, candidates, bounds }) =>
    candidates.map((cell) => cellPixelIndices(TOPOLOGIES[topology], cell, bounds, rotation)),
  );
  await page.evaluate((value) => {
    globalThis.__thingFootprintSamples = value;
  }, samples);
  for (let sprite = 0; sprite < sprites.length; sprite += 1) {
    const svg = await readFile(path.join(ROOT, "public/things", sprites[sprite]), "utf8");
    const masks = await rasterizeMasks(page, svg);
    for (let layoutIndex = 0; layoutIndex < layouts.length; layoutIndex += 1) {
      const { topology, variant, side, rotation } = layouts[layoutIndex];
      if (masks.counts[layoutIndex] === 0) {
        throw new Error(`Empty alpha footprint for ${topology}/${variant}/${side}/${rotation}/${sprite}`);
      }
      const wordIndex = (layoutIndex * sprites.length + sprite) * 2;
      words[wordIndex] = masks.words[layoutIndex * 2];
      words[wordIndex + 1] = masks.words[layoutIndex * 2 + 1];
      counts.push(masks.counts[layoutIndex]);
    }
  }

  const bytes = Buffer.allocUnsafe(words.length * 4);
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
  const encodedWords = gzipSync(bytes, { level: 9 }).toString("base64");
  const serializedLayouts = layouts.map(({ topology, variant, side, rotation, candidates, anchor }) => ({
    topology,
    variant,
    side,
    rotation,
    candidates: candidates.map((cell) => [cell.x - anchor.x, cell.y - anchor.y]),
  }));
  const fullLines = [
    "// Generated by scripts/generate-thing-alpha-footprints.mjs.",
    "// The catalog begins with the curated deck, then contains every remaining Noto SVG.",
    "// Each two-word mask marks topology cells intersecting screen-upright SVG alpha after one-texel dilation.",
    'import type { TopologyId } from "./topology";',
    "",
    `export const THING_CATALOG_FILES = ${JSON.stringify(sprites)} as const;`,
    "",
    `const LAYOUTS = ${JSON.stringify(serializedLayouts)} as const;`,
    `const ENCODED_MASK_WORDS_GZIP = ${JSON.stringify(encodedWords)};`,
    "const compressedMaskWords = Uint8Array.from(atob(ENCODED_MASK_WORDS_GZIP), (character) => character.charCodeAt(0));",
    'const maskWordStream = new Blob([compressedMaskWords]).stream().pipeThrough(new DecompressionStream("gzip"));',
    "const maskWords = new DataView(await new Response(maskWordStream).arrayBuffer());",
    "const layoutByKey = new Map(LAYOUTS.map((layout, index) => [`${layout.topology}:${layout.variant}:${layout.side}:${layout.rotation}`, index]));",
    "",
    "const positiveModulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;",
    "",
    "const topologyVariant = (topology: TopologyId, x: number, y: number): number =>",
    '  topology === "triangular" ? positiveModulo(x + y, 2) : topology === "rhombille" ? positiveModulo(x, 3) : 0;',
    "",
    "export const fullThingAlphaOffsets = (",
    "  topology: TopologyId,",
    "  anchorX: number,",
    "  anchorY: number,",
    "  side: number,",
    "  sprite: number,",
    "  rotation: 0 | 90 | 180 | 270 = 0,",
    "): readonly number[] => {",
    "  const key = `${topology}:${topologyVariant(topology, anchorX, anchorY)}:${side}:${rotation}`;",
    "  const layoutIndex = layoutByKey.get(key);",
    '  if (layoutIndex === undefined || sprite < 0 || sprite >= THING_CATALOG_FILES.length) throw new Error(`Missing Thing alpha footprint: ${key}:${sprite}`);',
    "  const layout = LAYOUTS[layoutIndex];",
    "  const wordOffset = (layoutIndex * THING_CATALOG_FILES.length + sprite) * 8;",
    "  const low = maskWords.getUint32(wordOffset, true);",
    "  const high = maskWords.getUint32(wordOffset + 4, true);",
    "  const offsets: number[] = [];",
    "  for (let index = 0; index < layout.candidates.length; index += 1) {",
    "    const present = index < 32 ? (low & (1 << index)) !== 0 : (high & (1 << (index - 32))) !== 0;",
    "    if (present) offsets.push(layout.candidates[index][0], layout.candidates[index][1]);",
    "  }",
    "  return offsets;",
    "};",
  ];
  const metaLines = [
    "// Generated by scripts/generate-thing-alpha-footprints.mjs.",
    `export const THING_CURATED_COUNT = ${CURATED_SPRITES.length};`,
    `export const THING_CATALOG_COUNT = ${sprites.length};`,
    `export const THING_CATALOG_SOURCE_COMMIT = "8998f5dd683424a73e2314a8c1f1e359c19e8742";`,
  ];
  await writeFile(path.join(ROOT, "src/thing-catalog-full.ts"), `${fullLines.join("\n")}\n`);
  await writeFile(path.join(ROOT, "src/thing-catalog-meta.ts"), `${metaLines.join("\n")}\n`);
  await browser.close();
  await vite.close();
  const minCells = counts.reduce((minimum, count) => Math.min(minimum, count), Number.POSITIVE_INFINITY);
  const maxCells = counts.reduce((maximum, count) => Math.max(maximum, count), 0);
  console.log(
    JSON.stringify({ sprites: sprites.length, patterns: counts.length, maskBytes: bytes.length, minCells, maxCells, chromium: await chromium.executablePath() }),
  );
};

await main();
