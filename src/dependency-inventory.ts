import * as fs from "fs";
import * as path from "path";
import * as TOML from "toml";
import { execFileSync } from "child_process";

type Classification =
  "shipped-runtime" | "native-helper" | "build-tooling" | "dev-only";
type HashAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

interface Property {
  name: string;
  value: string;
}

interface Component {
  type: "application" | "library";
  "bom-ref": string;
  name: string;
  version: string;
  purl: string;
  scope?: "required" | "optional" | "excluded";
  hashes?: Array<{ alg: HashAlgorithm; content: string }>;
  externalReferences?: Array<{ type: "distribution"; url: string }>;
  properties: Property[];
}

interface Dependency {
  ref: string;
  dependsOn: string[];
}

interface NpmPackage {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
  link?: boolean;
  os?: string[];
  cpu?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface NpmLock {
  lockfileVersion: number;
  packages: Record<string, NpmPackage>;
}

interface CargoPackage {
  name: string;
  version: string;
  source?: string;
  checksum?: string;
  dependencies?: string[];
}

interface CargoLock {
  package: CargoPackage[];
}

interface PackageManifest {
  name: string;
  version: string;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageGroup {
  name: string;
  version: string;
  locations: string[];
  resolved: Set<string>;
  integrity: Set<string>;
  missingResolved: boolean;
  missingIntegrity: boolean;
  classifications: Set<Classification>;
  optional: boolean;
  os: Set<string>;
  cpu: Set<string>;
  bundleEvidence: Set<string>;
  hashes: Map<string, string>;
  dependencies: Set<string>;
}

interface CargoGroup {
  name: string;
  version: string;
  source: Set<string>;
  checksum: Set<string>;
  missingSource: boolean;
  missingChecksum: boolean;
  features: Set<string>;
  dependencies: Set<string>;
  selectedForTarget: boolean;
}

interface CargoResolution {
  packages: Array<{ name: string; version: string }>;
  resolve: { nodes: Array<{ id: string; features: string[] }>; root: string };
}

interface CycloneDxBom {
  $schema: string;
  bomFormat: "CycloneDX";
  specVersion: "1.6";
  version: 1;
  metadata: { component: Component };
  components: Component[];
  dependencies: Dependency[];
}

const BUILD_TOOL_ROOTS = new Set([
  "esbuild",
  "prettier",
  "typescript",
  "vite",
  "vitest",
]);
const NATIVE_TARGET = "x86_64-unknown-linux-gnu";

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function encodePurlPart(value: string): string {
  return encodeURIComponent(value).replace(/%[0-9a-f]{2}/gi, (escape) =>
    escape.toUpperCase(),
  );
}

function packageUrl(
  ecosystem: "npm" | "cargo",
  name: string,
  version: string,
): string {
  const encodedName =
    ecosystem === "npm"
      ? name.split("/").map(encodePurlPart).join("/")
      : encodePurlPart(name);
  return `pkg:${ecosystem}/${encodedName}@${encodePurlPart(version)}`;
}

function addProperty(
  properties: Property[],
  name: string,
  value: string,
): void {
  properties.push({ name, value });
}

function sortedProperties(properties: Property[]): Property[] {
  return properties.sort(
    (a, b) => compareText(a.name, b.name) || compareText(a.value, b.value),
  );
}

function dependencyNames(pkg: NpmPackage): string[] {
  return uniqueSorted([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
}

function resolveNpmLocation(
  packages: Record<string, NpmPackage>,
  fromLocation: string,
  dependencyName: string,
): string | undefined {
  let cursor = fromLocation;
  while (cursor && cursor !== ".") {
    const candidate = path.posix.join(cursor, "node_modules", dependencyName);
    if (packages[candidate]) return candidate;
    cursor = path.posix.dirname(cursor);
  }
  const rootCandidate = path.posix.join("node_modules", dependencyName);
  return packages[rootCandidate] ? rootCandidate : undefined;
}

function npmNameFromLocation(location: string): string | undefined {
  const parts = location.split("/");
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex < 0) return undefined;
  const first = parts[nodeModulesIndex + 1];
  if (!first) return undefined;
  return first.startsWith("@")
    ? [first, parts[nodeModulesIndex + 2]].filter(Boolean).join("/")
    : first;
}

function walkNpmGraph(
  packages: Record<string, NpmPackage>,
  rootDependencies: Record<string, string> | undefined,
  rootLocation = "",
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const name of Object.keys(rootDependencies ?? {}).sort(compareText)) {
    const location = resolveNpmLocation(packages, rootLocation, name);
    if (!location) {
      throw new Error(
        `Missing locked npm dependency ${name} from ${rootLocation || "project root"}`,
      );
    }
    queue.push(location);
  }
  while (queue.length > 0) {
    const location = queue.shift()!;
    if (visited.has(location)) continue;
    visited.add(location);
    const pkg = packages[location];
    if (!pkg) throw new Error(`Missing npm lock entry at ${location}`);
    for (const dependencyName of dependencyNames(pkg)) {
      const dependencyLocation = resolveNpmLocation(
        packages,
        location,
        dependencyName,
      );
      if (dependencyLocation) queue.push(dependencyLocation);
    }
  }
  return visited;
}

function npmClassification(
  location: string,
  pkg: NpmPackage,
  runtime: Set<string>,
  buildTooling: Set<string>,
  dev: Set<string>,
): Classification {
  if (runtime.has(location) || pkg.dev !== true) return "shipped-runtime";
  if (buildTooling.has(location)) return "build-tooling";
  if (dev.has(location)) return "dev-only";
  return "dev-only";
}

function parseIntegrity(
  value: string,
): Array<{ alg: HashAlgorithm; content: string }> {
  const output: Array<{ alg: HashAlgorithm; content: string }> = [];
  for (const token of value.trim().split(/\s+/)) {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+=*)$/i.exec(
      token,
    );
    if (!match) continue;
    const alg = `SHA-${match[1].slice(3)}` as HashAlgorithm;
    output.push({
      alg,
      content: Buffer.from(match[2], "base64").toString("hex"),
    });
  }
  if (output.length === 0)
    throw new Error(`Unrecognized npm lock integrity value: ${value}`);
  return output;
}

function cargoDependencyParts(value: string): {
  name: string;
  version?: string;
  source?: string;
} {
  const match = /^([^\s]+)(?:\s+([^\s]+))?(?:\s+\((.+)\))?$/.exec(value);
  if (!match)
    throw new Error(`Unrecognized Cargo.lock dependency entry: ${value}`);
  return { name: match[1], version: match[2], source: match[3] };
}

function resolveCargoPackage(
  packages: CargoPackage[],
  dependency: string,
): CargoPackage {
  const wanted = cargoDependencyParts(dependency);
  const candidates = packages.filter(
    (pkg) =>
      pkg.name === wanted.name &&
      (!wanted.version || pkg.version === wanted.version) &&
      (!wanted.source || pkg.source === wanted.source),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Cargo.lock dependency ${dependency} resolved to ${candidates.length} package records`,
    );
  }
  return candidates[0];
}

function cargoFeatureMap(
  manifest: Record<string, unknown>,
): Map<string, Set<string>> {
  const features = new Map<string, Set<string>>();
  const addSection = (section: unknown) => {
    if (
      typeof section !== "object" ||
      section === null ||
      Array.isArray(section)
    )
      return;
    for (const [alias, rawValue] of Object.entries(section)) {
      if (
        typeof rawValue !== "object" ||
        rawValue === null ||
        Array.isArray(rawValue)
      )
        continue;
      const value = rawValue as { package?: unknown; features?: unknown };
      const packageName =
        typeof value.package === "string" ? value.package : alias;
      const requested = Array.isArray(value.features)
        ? value.features.filter(
            (feature): feature is string => typeof feature === "string",
          )
        : [];
      const known = features.get(packageName) ?? new Set<string>();
      requested.forEach((feature) => known.add(feature));
      features.set(packageName, known);
    }
  };
  addSection(manifest.dependencies);
  addSection(manifest["build-dependencies"]);
  addSection(manifest["dev-dependencies"]);
  const targets = manifest.target;
  if (
    typeof targets === "object" &&
    targets !== null &&
    !Array.isArray(targets)
  ) {
    for (const target of Object.values(targets)) {
      if (
        typeof target !== "object" ||
        target === null ||
        Array.isArray(target)
      )
        continue;
      const sections = target as Record<string, unknown>;
      addSection(sections.dependencies);
      addSection(sections["build-dependencies"]);
      addSection(sections["dev-dependencies"]);
    }
  }
  return features;
}

function componentFromNpmGroup(ref: string, group: PackageGroup): Component {
  const classifications = uniqueSorted(group.classifications);
  const classification = group.classifications.has("shipped-runtime")
    ? "shipped-runtime"
    : group.classifications.has("build-tooling")
      ? "build-tooling"
      : "dev-only";
  const properties: Property[] = [];
  addProperty(properties, "weighin:classification", classification);
  addProperty(properties, "weighin:lockfile", "package-lock.json");
  group.locations.forEach((location) =>
    addProperty(properties, "weighin:install-location", location),
  );
  uniqueSorted(group.resolved).forEach((resolved) =>
    addProperty(properties, "weighin:resolved-source", resolved),
  );
  uniqueSorted(group.integrity).forEach((integrity) =>
    addProperty(properties, "weighin:lock-integrity", integrity),
  );
  if (group.missingResolved)
    addProperty(
      properties,
      "weighin:metadata-gap",
      "lockfile-source-not-present-for-all-installations",
    );
  if (group.missingIntegrity)
    addProperty(
      properties,
      "weighin:metadata-gap",
      "lockfile-integrity-not-present-for-all-installations",
    );
  if (classifications.length > 1) {
    classifications.forEach((value) =>
      addProperty(properties, "weighin:classification-evidence", value),
    );
  }
  if (group.optional) addProperty(properties, "weighin:optional", "true");
  uniqueSorted(group.os).forEach((value) =>
    addProperty(properties, "weighin:package-os", value),
  );
  uniqueSorted(group.cpu).forEach((value) =>
    addProperty(properties, "weighin:package-cpu", value),
  );
  uniqueSorted(group.bundleEvidence).forEach((value) =>
    addProperty(properties, "weighin:bundle-evidence", value),
  );
  if (classification === "shipped-runtime" && group.bundleEvidence.size === 0) {
    addProperty(
      properties,
      "weighin:bundle-inclusion",
      "not-statically-emitted; conservatively included from the production lock graph",
    );
  }

  const hashes = [...group.hashes.entries()]
    .map(([key, content]) => {
      const [alg] = key.split(" ");
      return { alg: alg as HashAlgorithm, content };
    })
    .sort(
      (a, b) => compareText(a.alg, b.alg) || compareText(a.content, b.content),
    );
  const uniqueHashes = new Map<
    string,
    { alg: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"; content: string }
  >();
  hashes.forEach(({ alg, content }) =>
    uniqueHashes.set(`${alg} ${content}`, { alg, content }),
  );

  return {
    type: "library",
    "bom-ref": ref,
    name: group.name,
    version: group.version,
    purl: ref,
    scope:
      classification === "shipped-runtime"
        ? group.optional
          ? "optional"
          : "required"
        : "excluded",
    ...(uniqueHashes.size ? { hashes: [...uniqueHashes.values()] } : {}),
    ...(group.resolved.size
      ? {
          externalReferences: uniqueSorted(group.resolved).map((url) => ({
            type: "distribution" as const,
            url,
          })),
        }
      : {}),
    properties: sortedProperties(properties),
  };
}

function componentFromCargoGroup(ref: string, group: CargoGroup): Component {
  const properties: Property[] = [];
  addProperty(properties, "weighin:classification", "native-helper");
  addProperty(properties, "weighin:lockfile", "native/simulation/Cargo.lock");
  addProperty(properties, "weighin:native-target", NATIVE_TARGET);
  addProperty(
    properties,
    "weighin:target-inclusion",
    group.selectedForTarget ? "selected" : "not-selected",
  );
  uniqueSorted(group.source).forEach((source) =>
    addProperty(properties, "weighin:source", source),
  );
  if (group.missingSource)
    addProperty(
      properties,
      "weighin:metadata-gap",
      "lockfile-source-not-present",
    );
  if (group.missingChecksum)
    addProperty(
      properties,
      "weighin:metadata-gap",
      "lockfile-checksum-not-present",
    );
  uniqueSorted(group.features).forEach((feature) =>
    addProperty(properties, "weighin:enabled-feature", feature),
  );
  const checksum = uniqueSorted(group.checksum);
  if (checksum.length > 1) {
    throw new Error(`Conflicting Cargo.lock checksums for ${ref}`);
  }
  return {
    type: "library",
    "bom-ref": ref,
    name: group.name,
    version: group.version,
    purl: ref,
    scope: "required",
    ...(checksum.length
      ? { hashes: [{ alg: "SHA-256" as const, content: checksum[0] }] }
      : {}),
    properties: sortedProperties(properties),
  };
}

/** Generate a deterministic CycloneDX 1.6 inventory from the committed lockfiles. */
export function generateDependencyInventory(
  rootDirectory = path.resolve(__dirname, ".."),
  cargoResolution?: CargoResolution,
): CycloneDxBom {
  const root = path.resolve(rootDirectory);
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ) as PackageManifest;
  const npmLock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  ) as NpmLock;
  if (npmLock.lockfileVersion !== 3) {
    throw new Error(
      `Unsupported npm lockfile version ${npmLock.lockfileVersion}`,
    );
  }
  const npmRoot = npmLock.packages[""];
  if (!npmRoot)
    throw new Error("package-lock.json is missing its root package record");
  const npmPackages = Object.fromEntries(
    Object.entries(npmLock.packages).filter(([location]) => location !== ""),
  );
  const npmRuntimeReach = walkNpmGraph(npmPackages, {
    ...npmRoot.dependencies,
    ...npmRoot.optionalDependencies,
  });
  const npmDevReach = walkNpmGraph(npmPackages, npmRoot.devDependencies);
  const npmBuildRoots: Record<string, string> = {};
  for (const [name, version] of Object.entries(npmRoot.devDependencies ?? {})) {
    if (BUILD_TOOL_ROOTS.has(name)) npmBuildRoots[name] = version;
  }
  const npmBuildReach = walkNpmGraph(npmPackages, npmBuildRoots);
  const bundleContents = new Map(
    ["bundled/index.js", "bundled/comment-action.js"].map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(root, relativePath), "utf8"),
    ]),
  );

  const npmGroups = new Map<string, PackageGroup>();
  const npmRefByLocation = new Map<string, string>();
  for (const [location, pkg] of Object.entries(npmPackages).sort(([a], [b]) =>
    compareText(a, b),
  )) {
    if (pkg.link) continue;
    const name = pkg.name ?? npmNameFromLocation(location);
    if (!name || !pkg.version) {
      throw new Error(
        `npm lock entry ${location} is missing its exact package name or version`,
      );
    }
    const ref = packageUrl("npm", name, pkg.version);
    npmRefByLocation.set(location, ref);
    let group = npmGroups.get(ref);
    if (!group) {
      group = {
        name,
        version: pkg.version,
        locations: [],
        resolved: new Set(),
        integrity: new Set(),
        missingResolved: false,
        missingIntegrity: false,
        classifications: new Set(),
        optional: true,
        os: new Set(),
        cpu: new Set(),
        bundleEvidence: new Set(),
        hashes: new Map(),
        dependencies: new Set(),
      };
      npmGroups.set(ref, group);
    }
    group.locations.push(location);
    if (pkg.resolved) group.resolved.add(pkg.resolved);
    else group.missingResolved = true;
    if (pkg.integrity) {
      group.integrity.add(pkg.integrity);
      for (const hash of parseIntegrity(pkg.integrity)) {
        const hashKey = `${hash.alg} ${ref}`;
        const previousHash = group.hashes.get(hashKey);
        if (previousHash && previousHash !== hash.content) {
          throw new Error(`Conflicting npm integrity hashes for ${ref}`);
        }
        group.hashes.set(hashKey, hash.content);
      }
    } else {
      group.missingIntegrity = true;
    }
    if (pkg.optional) group.optional = group.optional && true;
    else group.optional = false;
    (pkg.os ?? []).forEach((value) => group!.os.add(value));
    (pkg.cpu ?? []).forEach((value) => group!.cpu.add(value));
    group.classifications.add(
      npmClassification(
        location,
        pkg,
        npmRuntimeReach,
        npmBuildReach,
        npmDevReach,
      ),
    );
    for (const [bundlePath, bundleText] of bundleContents) {
      if (bundleText.includes(`// ${location}/`)) {
        group.bundleEvidence.add(bundlePath);
      }
    }
  }

  for (const [location, pkg] of Object.entries(npmPackages)) {
    if (pkg.link) continue;
    const fromRef = npmRefByLocation.get(location);
    const group = fromRef ? npmGroups.get(fromRef) : undefined;
    if (!group) continue;
    for (const dependencyName of dependencyNames(pkg)) {
      const dependencyLocation = resolveNpmLocation(
        npmPackages,
        location,
        dependencyName,
      );
      if (!dependencyLocation) continue;
      const targetRef = npmRefByLocation.get(dependencyLocation);
      if (targetRef) group.dependencies.add(targetRef);
    }
  }

  const cargoManifest = TOML.parse(
    fs.readFileSync(path.join(root, "native/simulation/Cargo.toml"), "utf8"),
  ) as Record<string, unknown>;
  const cargoLock = TOML.parse(
    fs.readFileSync(path.join(root, "native/simulation/Cargo.lock"), "utf8"),
  ) as CargoLock;
  const cargoRoot = cargoLock.package.find(
    (pkg) => pkg.name === "weighin-simulation",
  );
  if (!cargoRoot) throw new Error("Cargo.lock is missing weighin-simulation");
  const resolution =
    cargoResolution ??
    (JSON.parse(
      execFileSync(
        "cargo",
        [
          "+1.95.0",
          "metadata",
          "--locked",
          "--offline",
          "--format-version",
          "1",
          "--manifest-path",
          path.join(root, "native/simulation/Cargo.toml"),
          "--filter-platform",
          NATIVE_TARGET,
        ],
        { encoding: "utf8" },
      ),
    ) as CargoResolution);
  const selectedIdentities = new Set(
    resolution.packages.map((pkg) => `${pkg.name}@${pkg.version}`),
  );
  const activeFeatures = new Map<string, Set<string>>();
  for (const node of resolution.resolve.nodes) {
    const pkg = resolution.packages.find((candidate) =>
      node.id.includes(`#${candidate.name}@${candidate.version}`),
    );
    if (pkg)
      activeFeatures.set(`${pkg.name}@${pkg.version}`, new Set(node.features));
  }
  const cargoPackages = cargoLock.package.filter(
    (pkg) => pkg.name !== cargoRoot.name || pkg.version !== cargoRoot.version,
  );
  const requestedFeatures = cargoFeatureMap(cargoManifest);
  const cargoGroups = new Map<string, CargoGroup>();
  const cargoRefByIdentity = new Map<string, string>();
  for (const pkg of cargoPackages) {
    const ref = packageUrl("cargo", pkg.name, pkg.version);
    const previous = cargoGroups.get(ref);
    const group = previous ?? {
      name: pkg.name,
      version: pkg.version,
      source: new Set<string>(),
      checksum: new Set<string>(),
      missingSource: false,
      missingChecksum: false,
      features: new Set<string>(),
      dependencies: new Set<string>(),
      selectedForTarget: selectedIdentities.has(`${pkg.name}@${pkg.version}`),
    };
    if (pkg.source) group.source.add(pkg.source);
    else group.missingSource = true;
    if (group.source.size > 1) {
      throw new Error(`Cargo package ${ref} is locked from multiple sources`);
    }
    if (pkg.checksum) group.checksum.add(pkg.checksum);
    else group.missingChecksum = true;
    for (const feature of activeFeatures.get(`${pkg.name}@${pkg.version}`) ??
      requestedFeatures.get(pkg.name) ??
      []) {
      group.features.add(feature);
    }
    cargoGroups.set(ref, group);
    cargoRefByIdentity.set(`${pkg.name}@${pkg.version}`, ref);
  }

  const cargoRef = packageUrl("cargo", cargoRoot.name, cargoRoot.version);
  for (const pkg of cargoPackages) {
    const ref = cargoRefByIdentity.get(`${pkg.name}@${pkg.version}`)!;
    const group = cargoGroups.get(ref)!;
    for (const dependency of pkg.dependencies ?? []) {
      const resolved = resolveCargoPackage(cargoPackages, dependency);
      const targetRef = cargoRefByIdentity.get(
        `${resolved.name}@${resolved.version}`,
      );
      if (targetRef) group.dependencies.add(targetRef);
    }
  }

  const cargoRootDependencies = uniqueSorted(
    (cargoRoot.dependencies ?? []).map((dependency) => {
      const resolved = resolveCargoPackage(cargoPackages, dependency);
      return cargoRefByIdentity.get(`${resolved.name}@${resolved.version}`)!;
    }),
  );
  const npmRootDependencies = new Set<string>();
  for (const dependencies of [
    npmRoot.dependencies,
    npmRoot.devDependencies,
    npmRoot.optionalDependencies,
  ]) {
    for (const name of Object.keys(dependencies ?? {})) {
      const location = resolveNpmLocation(npmPackages, "", name);
      const ref = location ? npmRefByLocation.get(location) : undefined;
      if (!ref) throw new Error(`Missing locked npm root dependency ${name}`);
      npmRootDependencies.add(ref);
    }
  }

  const applicationRef = packageUrl(
    "npm",
    packageManifest.name,
    packageManifest.version,
  );
  const nativeHelper: Component = {
    type: "library",
    "bom-ref": cargoRef,
    name: cargoRoot.name,
    version: cargoRoot.version,
    purl: cargoRef,
    scope: "required",
    properties: sortedProperties([
      { name: "weighin:classification", value: "native-helper" },
      {
        name: "weighin:source-manifest",
        value: "native/simulation/Cargo.toml",
      },
      { name: "weighin:lockfile", value: "native/simulation/Cargo.lock" },
      { name: "weighin:native-target", value: NATIVE_TARGET },
      { name: "weighin:target-scope", value: "Linux x64 helper build" },
    ]),
  };
  const appProperties: Property[] = [
    { name: "weighin:classification", value: "shipped-runtime" },
    {
      name: "weighin:deduplication-policy",
      value:
        "ecosystem + package name + locked version; npm install locations are merged and all locations retained",
    },
    {
      name: "weighin:disclaimer",
      value:
        "This inventory records locked components and provenance; it is not vulnerability clearance or a license/legal certification.",
    },
  ];
  (packageManifest.files ?? []).forEach((file) =>
    addProperty(appProperties, "weighin:package-files-entry", file),
  );
  addProperty(appProperties, "weighin:bundled-entrypoint", "bundled/index.js");
  addProperty(
    appProperties,
    "weighin:bundled-entrypoint",
    "bundled/comment-action.js",
  );
  addProperty(
    appProperties,
    "weighin:native-source",
    "native/simulation/Cargo.toml",
  );
  addProperty(
    appProperties,
    "weighin:native-lockfile",
    "native/simulation/Cargo.lock",
  );
  const application: Component = {
    type: "application",
    "bom-ref": applicationRef,
    name: packageManifest.name,
    version: packageManifest.version,
    purl: applicationRef,
    properties: sortedProperties(appProperties),
  };

  const components = [
    nativeHelper,
    ...[...npmGroups.entries()].map(([ref, group]) =>
      componentFromNpmGroup(ref, group),
    ),
    ...[...cargoGroups.entries()].map(([ref, group]) =>
      componentFromCargoGroup(ref, group),
    ),
  ].sort((a, b) => compareText(a["bom-ref"], b["bom-ref"]));

  const dependenciesByRef = new Map<string, Set<string>>();
  dependenciesByRef.set(
    applicationRef,
    new Set([...npmRootDependencies, cargoRef]),
  );
  dependenciesByRef.set(cargoRef, new Set(cargoRootDependencies));
  for (const [ref, group] of npmGroups)
    dependenciesByRef.set(ref, group.dependencies);
  for (const [ref, group] of cargoGroups)
    dependenciesByRef.set(ref, group.dependencies);
  const dependencies = [...dependenciesByRef.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([ref, children]) => ({ ref, dependsOn: uniqueSorted(children) }));

  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: application },
    components,
    dependencies,
  };
}

export function serializeDependencyInventory(
  rootDirectory = path.resolve(__dirname, ".."),
): string {
  return `${JSON.stringify(generateDependencyInventory(rootDirectory), null, 2)}\n`;
}

function runCli(): void {
  const root = path.resolve(__dirname, "..");
  const outputPath = path.join(root, "docs/dependency-inventory.json");
  const expected = serializeDependencyInventory(root);
  if (process.argv.includes("--check")) {
    const current = fs.readFileSync(outputPath, "utf8");
    if (current !== expected) {
      throw new Error(
        "docs/dependency-inventory.json is stale; run npm run inventory:generate",
      );
    }
    if (!process.argv.includes("--quiet"))
      process.stdout.write("Dependency inventory verified\n");
    return;
  }
  fs.writeFileSync(outputPath, expected);
  if (!process.argv.includes("--quiet"))
    process.stdout.write(`Wrote ${outputPath}\n`);
}

if (require.main === module) runCli();
