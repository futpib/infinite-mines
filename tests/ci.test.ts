import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(`${root}/${path}`, "utf8");

describe("reproducible CI contract", () => {
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
