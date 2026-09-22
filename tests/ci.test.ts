import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THING_CATALOG_FILES, fullThingAlphaOffsets } from "../src/thing-catalog-full";
import {
  isExcludedThingFilename,
  isMultiPersonThingFilename,
  isPregnancyThingFilename,
} from "../scripts/thing-catalog-policy.mjs";
import {
  THING_CATALOG_COUNT,
  THING_CATALOG_SOURCE_COMMIT,
  THING_CURATED_COUNT,
} from "../src/thing-catalog-meta";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(`${root}/${path}`, "utf8");

describe("reproducible CI contract", () => {
  it("pins and ships every permitted Noto SVG Thing", () => {
    const shipped = readdirSync(`${root}/public/things`)
      .filter((name) => name.endsWith(".svg"))
      .sort();
    expect(THING_CATALOG_SOURCE_COMMIT).toBe("8998f5dd683424a73e2314a8c1f1e359c19e8742");
    expect(THING_CURATED_COUNT).toBe(12);
    expect(THING_CATALOG_COUNT).toBe(3213);
    expect(THING_CATALOG_FILES).toHaveLength(THING_CATALOG_COUNT);
    expect(new Set(THING_CATALOG_FILES).size).toBe(THING_CATALOG_COUNT);
    expect([...THING_CATALOG_FILES].sort()).toEqual(shipped);
    expect(shipped.filter(isExcludedThingFilename)).toEqual([]);
    expect(THING_CATALOG_FILES.filter(isExcludedThingFilename)).toEqual([]);
    for (const removed of [
      "emoji_u1f465.svg",
      "emoji_u1f46a.svg",
      "emoji_u1f46f.svg",
      "emoji_u1f48f.svg",
      "emoji_u1f491.svg",
      "emoji_u1f93c.svg",
      "emoji_u1fac2.svg",
      "emoji_u1f468_200d_2764_200d_1f48b_200d_1f468.svg",
      "emoji_u1f469_1f3fb_200d_1f91d_200d_1f469_1f3ff.svg",
    ]) {
      expect(isMultiPersonThingFilename(removed), `${removed} must match the exclusion policy`).toBe(true);
      expect(shipped, `${removed} must not ship`).not.toContain(removed);
    }
    const pregnancySprites = ["1f930", "1fac3", "1fac4"].flatMap((root) =>
      ["", "_1f3fb", "_1f3fc", "_1f3fd", "_1f3fe", "_1f3ff"].map(
        (tone) => `emoji_u${root}${tone}.svg`,
      ),
    );
    expect(pregnancySprites).toHaveLength(18);
    for (const removed of pregnancySprites) {
      expect(isPregnancyThingFilename(removed), `${removed} must match the pregnancy exclusion`).toBe(true);
      expect(isMultiPersonThingFilename(removed), `${removed} must not depend on the multi-person rule`).toBe(false);
      expect(isExcludedThingFilename(removed), `${removed} must match the combined exclusion policy`).toBe(true);
      expect(shipped, `${removed} must not ship`).not.toContain(removed);
    }
    expect(read("public/things/LICENSE")).toContain("Apache License, Version 2.0");

    let patterns = 0;
    const variants = {
      square: [{ x: 0, y: 0 }],
      triangular: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      rhombille: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
    } as const;
    const rotations = [0, 90, 180, 270] as const;
    for (const [topology, anchors] of Object.entries(variants)) {
      for (const anchor of anchors) {
        for (const side of [3, 4]) {
          for (const rotation of rotations) {
            for (let sprite = 0; sprite < THING_CATALOG_COUNT; sprite += 1) {
              const offsets = fullThingAlphaOffsets(
                topology as keyof typeof variants,
                anchor.x,
                anchor.y,
                side,
                sprite,
                rotation,
              );
              expect(offsets.length).toBeGreaterThan(0);
              expect(offsets.length % 2).toBe(0);
              expect(new Set(Array.from({ length: offsets.length / 2 }, (_, index) => `${offsets[index * 2]},${offsets[index * 2 + 1]}`)).size).toBe(
                offsets.length / 2,
              );
              patterns += 1;
            }
          }
        }
      }
    }
    expect(patterns).toBe(THING_CATALOG_COUNT * 12 * rotations.length);
  }, 20_000);

  it("pins package tools to the versions installed by the lockfile", () => {
    const packageJson = JSON.parse(read("package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    const styles = read("src/styles.css");
    const expected = {
      "@axe-core/playwright": "4.13.0",
      "@fontsource-variable/inter": "5.3.0",
      "@playwright/test": "1.62.1",
      "@types/node": "22.20.1",
      typescript: "5.9.3",
      vite: "7.3.6",
      vitest: "3.2.7",
    };

    expect(packageJson.packageManager).toBe("npm@10.9.8");
    expect(packageJson.devDependencies).toEqual(expected);
    expect(lock.packages[""].devDependencies).toEqual(expected);
    expect(packageJson.dependencies).toEqual({ "hyperbolic-map": "0.1.1" });
    expect(lock.packages[""].dependencies).toEqual({ "hyperbolic-map": "0.1.1" });
    expect(lock.packages["node_modules/hyperbolic-map"]).toMatchObject({
      version: "0.1.1",
      license: "BSD-3-Clause",
    });
    expect(read("public/licenses/hyperbolic-map-LICENSE.txt")).toContain("BSD 3-Clause License");
    expect(packageJson.scripts["test:docker"]).toBe("bash scripts/test-ci-docker.sh");
    expect(styles).toContain("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
    for (const [name, version] of Object.entries(expected)) {
      expect(lock.packages[`node_modules/${name}`].version).toBe(version);
    }
  });

  it("pins the GitHub-like container and preserves the full test entrypoint", () => {
    const dockerfile = read("Dockerfile.ci");
    const wrapper = read("scripts/test-ci-docker.sh");

    expect(dockerfile).toContain(
      "mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e",
    );
    expect(dockerfile).toContain("ARG NODE_VERSION=22.23.2");
    expect(dockerfile).toContain("ARG NPM_VERSION=10.9.8");
    expect(dockerfile).toContain("sha256sum --check --strict");
    expect(dockerfile).toContain("sha512sum --check --strict");
    expect(dockerfile).toContain('CMD ["npm", "test"]');
    expect(wrapper).toContain("--platform linux/amd64");
    expect(wrapper).toContain("--network host");
    expect(wrapper).toContain("--init");
    expect(wrapper).toContain("--ipc=host");
    expect(wrapper).toContain("--network none");
  });

  it("runs that same container in GitHub and always retains browser diagnostics", () => {
    const workflow = read(".github/workflows/ci.yml");
    const playwright = read("playwright.config.ts");

    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("run: npm run test:docker");
    expect(workflow).toContain("actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09");
    expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain("playwright-report/");
    expect(workflow).toContain("test-results/");
    expect(workflow).not.toContain("continue-on-error");
    expect(playwright).toContain("forbidOnly: runningInCi");
    expect(playwright).toContain("retries: 0");
    expect(playwright).toContain('outputFolder: "playwright-report"');
  });
});
