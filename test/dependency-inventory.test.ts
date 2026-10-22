import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { generateDependencyInventory } from "../src/dependency-inventory";

const repoRoot = path.resolve(__dirname, "..");

function properties(
  component: { properties?: Array<{ name: string; value: string }> },
  name: string,
): string[] {
  return (component.properties ?? [])
    .filter((property) => property.name === name)
    .map((property) => property.value);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixtureRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-inventory-fixture-"),
  );
  writeJson(path.join(root, "package.json"), {
    name: "fixture-app",
    version: "1.0.0",
    files: [
      "dist",
      "bundled",
      "native/simulation/Cargo.lock",
      "docs/dependency-inventory.json",
    ],
    dependencies: {
      "prod-a": "1.0.0",
      "prod-b": "1.0.0",
      "prod-missing": "1.0.0",
      shared: "1.0.0",
    },
    devDependencies: { esbuild: "1.0.0", "test-only": "1.0.0" },
  });
  const integrity = (byte: number) =>
    `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
  writeJson(path.join(root, "package-lock.json"), {
    name: "fixture-app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture-app",
        version: "1.0.0",
        dependencies: {
          "prod-a": "1.0.0",
          "prod-b": "1.0.0",
          "prod-missing": "1.0.0",
          shared: "1.0.0",
        },
        devDependencies: { esbuild: "1.0.0", "test-only": "1.0.0" },
      },
      "node_modules/prod-a": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/prod-a/-/prod-a-1.0.0.tgz",
        integrity: integrity(1),
        dependencies: { shared: "1.0.0" },
      },
      "node_modules/prod-a/node_modules/shared": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/shared/-/shared-1.0.0.tgz",
        integrity: integrity(2),
      },
      "node_modules/prod-b": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/prod-b/-/prod-b-1.0.0.tgz",
        integrity: integrity(3),
        dependencies: { shared: "2.0.0" },
      },
      "node_modules/prod-b/node_modules/shared": {
        version: "2.0.0",
        resolved: "https://registry.npmjs.org/shared/-/shared-2.0.0.tgz",
        integrity: integrity(4),
      },
      "node_modules/prod-missing": { version: "1.0.0" },
      "node_modules/shared": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/shared/-/shared-1.0.0.tgz",
        integrity: integrity(2),
      },
      "node_modules/esbuild": {
        version: "1.0.0",
        dev: true,
        dependencies: { "builder-dep": "1.0.0" },
      },
      "node_modules/builder-dep": { version: "1.0.0", dev: true },
      "node_modules/test-only": { version: "1.0.0", dev: true },
    },
  });
  fs.mkdirSync(path.join(root, "bundled"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "bundled/index.js"),
    "// node_modules/prod-a/index.js\n",
  );
  fs.writeFileSync(
    path.join(root, "bundled/comment-action.js"),
    "// fixture bundle\n",
  );
  fs.mkdirSync(path.join(root, "native/simulation"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "native/simulation/Cargo.toml"),
    '[package]\nname="weighin-simulation"\nversion="0.1.0"\n[dependencies]\nalpha={version="1",features=["fast"]}\n',
  );
  fs.writeFileSync(
    path.join(root, "native/simulation/Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "weighin-simulation"\nversion = "0.1.0"\ndependencies = ["alpha 1.0.0"]\n\n[[package]]\nname = "alpha"\nversion = "1.0.0"\nsource = "registry+https://example.invalid/index"\nchecksum = "${"a".repeat(64)}"\ndependencies = ["beta 2.0.0"]\n\n[[package]]\nname = "beta"\nversion = "2.0.0"\nsource = "registry+https://example.invalid/index"\nchecksum = "${"b".repeat(64)}"\n`,
  );
  return root;
}

const fixtureCargoResolution = {
  packages: [
    { name: "alpha", version: "1.0.0" },
    { name: "beta", version: "2.0.0" },
  ],
  resolve: {
    root: "root",
    nodes: [
      { id: "registry#alpha@1.0.0", features: ["fast"] },
      { id: "registry#beta@2.0.0", features: [] },
    ],
  },
};

describe("CycloneDX dependency inventory", () => {
  it("is deterministic, standards-shaped, and references every component in its graph", () => {
    const first = generateDependencyInventory(repoRoot);
    const second = generateDependencyInventory(repoRoot);
    expect(first).toEqual(second);
    expect(first.bomFormat).toBe("CycloneDX");
    expect(first.specVersion).toBe("1.6");
    expect(first.$schema).toContain("bom-1.6.schema.json");
    expect(
      new Set(first.components.map((component) => component["bom-ref"])).size,
    ).toBe(first.components.length);

    const knownRefs = new Set([
      first.metadata.component["bom-ref"],
      ...first.components.map((component) => component["bom-ref"]),
    ]);
    for (const dependency of first.dependencies) {
      expect(knownRefs.has(dependency.ref)).toBe(true);
      expect(new Set(dependency.dependsOn).size).toBe(
        dependency.dependsOn.length,
      );
      dependency.dependsOn.forEach((ref) =>
        expect(knownRefs.has(ref)).toBe(true),
      );
    }

    const appProperties = properties(
      first.metadata.component,
      "weighin:disclaimer",
    );
    expect(appProperties[0]).toContain("not vulnerability clearance");
    expect(
      properties(first.metadata.component, "weighin:package-files-entry"),
    ).toContain("docs/dependency-inventory.json");
    const sorobanHost = first.components.find(
      (component) => component.name === "soroban-env-host",
    );
    expect(sorobanHost?.purl).toBe("pkg:cargo/soroban-env-host@28.0.1");
    expect(properties(sorobanHost!, "weighin:native-target")).toEqual([
      "x86_64-unknown-linux-gnu",
    ]);
    expect(properties(sorobanHost!, "weighin:enabled-feature")).toEqual([
      "recording_mode",
      "testutils",
    ]);
    expect(properties(sorobanHost!, "weighin:target-inclusion")).toEqual([
      "selected",
    ]);
    const actionsCore = first.components.find(
      (component) => component.name === "@actions/core",
    );
    expect(properties(actionsCore!, "weighin:bundle-evidence")).toContain(
      "bundled/index.js",
    );
    expect(actionsCore?.hashes?.some((hash) => hash.alg === "SHA-512")).toBe(
      true,
    );
  }, 15_000);

  it("deduplicates npm identity across install locations and preserves versions, classes, and absent metadata", () => {
    const root = createFixtureRoot();
    try {
      const inventory = generateDependencyInventory(
        root,
        fixtureCargoResolution,
      );
      const sharedV1 = inventory.components.find(
        (component) => component.purl === "pkg:npm/shared@1.0.0",
      )!;
      const sharedV2 = inventory.components.find(
        (component) => component.purl === "pkg:npm/shared@2.0.0",
      )!;
      expect(properties(sharedV1, "weighin:install-location")).toEqual([
        "node_modules/prod-a/node_modules/shared",
        "node_modules/shared",
      ]);
      expect(sharedV2["bom-ref"]).not.toBe(sharedV1["bom-ref"]);

      const prod = inventory.components.find(
        (component) => component.name === "prod-a",
      )!;
      expect(properties(prod, "weighin:classification")).toEqual([
        "shipped-runtime",
      ]);
      expect(properties(prod, "weighin:bundle-evidence")).toEqual([
        "bundled/index.js",
      ]);
      const buildTool = inventory.components.find(
        (component) => component.name === "builder-dep",
      )!;
      expect(properties(buildTool, "weighin:classification")).toEqual([
        "build-tooling",
      ]);
      const devOnly = inventory.components.find(
        (component) => component.name === "test-only",
      )!;
      expect(properties(devOnly, "weighin:classification")).toEqual([
        "dev-only",
      ]);
      const absent = inventory.components.find(
        (component) => component.name === "prod-missing",
      )!;
      expect(properties(absent, "weighin:metadata-gap")).toContain(
        "lockfile-source-not-present-for-all-installations",
      );
      expect(properties(absent, "weighin:metadata-gap")).toContain(
        "lockfile-integrity-not-present-for-all-installations",
      );
      const alpha = inventory.components.find(
        (component) => component.name === "alpha",
      )!;
      expect(properties(alpha, "weighin:enabled-feature")).toEqual(["fast"]);
      expect(alpha.hashes).toEqual([
        { alg: "SHA-256", content: "a".repeat(64) },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates the affected package record when a locked integrity value changes", () => {
    const root = createFixtureRoot();
    try {
      const before = generateDependencyInventory(root, fixtureCargoResolution);
      const lockPath = path.join(root, "package-lock.json");
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      lock.packages["node_modules/prod-a"].integrity =
        `sha512-${Buffer.alloc(64, 9).toString("base64")}`;
      writeJson(lockPath, lock);
      const after = generateDependencyInventory(root, fixtureCargoResolution);
      const beforeProd = before.components.find(
        (component) => component.name === "prod-a",
      )!;
      const afterProd = after.components.find(
        (component) => component.name === "prod-a",
      )!;
      expect(afterProd.hashes).not.toEqual(beforeProd.hashes);
      expect(
        after.components.find((component) => component.name === "prod-b"),
      ).toEqual(
        before.components.find((component) => component.name === "prod-b"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
