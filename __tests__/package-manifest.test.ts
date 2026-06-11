import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe("package.json files", () => {
  it("declares Pi-provided runtime packages as wildcard peers", () => {
    const piProvided = [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
    ];

    for (const dependency of piProvided) {
      expect(packageJson.peerDependencies?.[dependency]).toBe("*");
      expect(packageJson.dependencies?.[dependency]).toBeUndefined();
    }
  });

  it("keeps third-party zod as a normal runtime dependency, not a Pi peer", () => {
    expect(packageJson.dependencies?.zod).toBeDefined();
    expect(packageJson.peerDependencies?.zod).toBeUndefined();
  });

  it("publishes every root runtime TypeScript module", () => {
    const publishedFiles = new Set(packageJson.files ?? []);
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    expect(runtimeModules.length).toBeGreaterThan(0);
    expect(runtimeModules.filter((entry) => !publishedFiles.has(entry))).toEqual([]);
  });
});
