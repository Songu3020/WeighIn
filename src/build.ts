import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
import * as exec from "@actions/exec";
import { z } from "zod";
import { parseFixtures } from "./identity";

export interface BuiltContract {
  wasm_path: string;
  manifest_path: string;
  package: string;
  wasm_sha256: string;
  stellar_version: string;
  rust_version: string;
}

export const CargoTargetSchema = z
  .object({
    name: z.string().optional(),
    crate_types: z.array(z.string()),
  })
  .passthrough();

export const CargoPackageSchema = z
  .object({
    id: z.string().min(1, "package id must not be empty"),
    name: z.string().min(1, "package name must not be empty"),
    manifest_path: z.string().min(1, "manifest_path must not be empty"),
    targets: z.array(CargoTargetSchema),
  })
  .passthrough();

export const CargoMetadataSchema = z
  .object({
    packages: z.array(CargoPackageSchema),
    workspace_members: z.array(z.string()),
  })
  .passthrough();

export type CargoPackage = z.infer<typeof CargoPackageSchema>;
export type CargoMetadata = z.infer<typeof CargoMetadataSchema>;

export function validateCargoMetadata(
  raw: unknown,
  manifest: string,
): CargoMetadata {
  const result = CargoMetadataSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "metadata"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid Cargo metadata for ${manifest}: ${issues}`);
  }
  const metadata = result.data;
  const packageMap = new Map<string, CargoPackage>();
  for (const pkg of metadata.packages) {
    if (!fs.existsSync(pkg.manifest_path)) {
      throw new Error(
        `Cargo package ${pkg.name} has unusable manifest_path ${pkg.manifest_path}: file does not exist`,
      );
    }
    packageMap.set(pkg.id, pkg);
  }
  for (const memberId of metadata.workspace_members) {
    if (!packageMap.has(memberId)) {
      throw new Error(
        `Cargo metadata for ${manifest} contains foreign workspace member ${memberId} not found in packages list`,
      );
    }
  }
  return metadata;
}

export interface BuildContractsOptions {
  fixturesPath: string;
  workspaceRoot: string;
  rustToolchain?: string;
}

function getCanonicalPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  let current = normalized;
  const segments: string[] = [];
  while (current && !fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    segments.unshift(path.basename(current));
    current = parent;
  }
  try {
    const realCurrent = fs.existsSync(current)
      ? fs.realpathSync(current)
      : current;
    return segments.length > 0
      ? path.join(realCurrent, ...segments)
      : realCurrent;
  } catch {
    return normalized;
  }
}

export interface ContractInputSnapshot {
  packageDir: string;
  hashes: Map<string, string>;
}

/**
 * Snapshot selected manifests, lockfiles, and tracked contract source inputs
 * before the build begins.
 */
export function snapshotContractInputs(
  packageDir: string,
): ContractInputSnapshot {
  const hashes = new Map<string, string>();

  function scanDir(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === "target" ||
        entry.name === "node_modules" ||
        entry.name === ".git"
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile()) {
        if (
          entry.name === "Cargo.toml" ||
          entry.name === "Cargo.lock" ||
          entry.name.endsWith(".rs")
        ) {
          try {
            const hash = createHash("sha256")
              .update(fs.readFileSync(fullPath))
              .digest("hex");
            hashes.set(fullPath, hash);
          } catch {
            // Ignore unreadable
          }
        }
      }
    }
  }

  scanDir(packageDir);

  // Traverse upward to capture workspace root Cargo.toml and Cargo.lock if present
  let current = path.dirname(packageDir);
  while (current && current !== packageDir) {
    const parentToml = path.join(current, "Cargo.toml");
    const parentLock = path.join(current, "Cargo.lock");
    if (fs.existsSync(parentToml)) {
      hashes.set(
        parentToml,
        createHash("sha256").update(fs.readFileSync(parentToml)).digest("hex"),
      );
    }
    if (fs.existsSync(parentLock)) {
      hashes.set(
        parentLock,
        createHash("sha256").update(fs.readFileSync(parentLock)).digest("hex"),
      );
    }
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { packageDir, hashes };
}

/**
 * Assert that manifests, lockfiles, and tracked contract inputs were not mutated
 * during the default contract build.
 */
export function assertContractInputsNotMutated(
  snapshot: ContractInputSnapshot,
): void {
  for (const [filePath, expectedHash] of snapshot.hashes.entries()) {
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Default contract build mutated tracked inputs: input file was deleted during build: ${filePath}`,
      );
    }
    const currentHash = createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex");
    if (currentHash !== expectedHash) {
      throw new Error(
        `Default contract build mutated tracked inputs: ${path.basename(filePath)} was modified during build at ${filePath}`,
      );
    }
  }
}

/** Detect storage errors that the optimizer's temporary-file writer may hide. */
function verifyBuildStorage(directory: string, bytes = 1024 * 1024): void {
  const probePath = path.join(directory, ".weighin-storage-probe");
  const expected = Buffer.alloc(bytes, 0xa5);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(probePath, "wx", 0o600);
    fs.writeFileSync(descriptor, expected);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (!fs.readFileSync(probePath).equals(expected))
      throw new Error(
        "temporary-file contents did not survive a write/read round trip",
      );
  } catch (error: any) {
    throw new Error(
      `Build temporary storage is unusable at ${directory}: ${error.message}. Provide healthy temporary storage (TMPDIR on Unix); refusing to accept optimizer output.`,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(probePath, { force: true });
  }
}

/** Build exactly the configured contracts, and measure fresh CLI output rather
 * than a potentially stale artifact already present at the fixture path. */
export async function buildContracts(
  fixturesPathOrOptions: string | BuildContractsOptions,
  workspaceRoot?: string,
  rustToolchain?: string,
): Promise<BuiltContract[]> {
  let fixturesPath: string;
  let root: string;
  let toolchain: string | undefined;

  if (
    typeof fixturesPathOrOptions === "object" &&
    fixturesPathOrOptions !== null
  ) {
    fixturesPath = fixturesPathOrOptions.fixturesPath;
    root = fixturesPathOrOptions.workspaceRoot;
    toolchain = fixturesPathOrOptions.rustToolchain;
  } else {
    fixturesPath = fixturesPathOrOptions;
    root = workspaceRoot ?? "";
    toolchain = rustToolchain;
  }

  if (!root || !root.trim()) {
    throw new Error(
      "Workspace root is required to prevent build escapes; provide an explicit directory",
    );
  }

  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Workspace root does not exist: ${root}`);
  }
  const rootStat = fs.statSync(resolvedRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${root}`);
  }
  const canonicalRoot = fs.realpathSync(resolvedRoot);

  const resolvedFixturesPath = path.resolve(canonicalRoot, fixturesPath);
  if (!fs.existsSync(resolvedFixturesPath)) {
    throw new Error(`Fixtures file not found: ${fixturesPath}`);
  }
  const canonicalFixturesFile = fs.realpathSync(resolvedFixturesPath);
  const relFixtures = path.relative(canonicalRoot, canonicalFixturesFile);
  if (relFixtures.startsWith("..") || path.isAbsolute(relFixtures)) {
    throw new Error(`Fixtures path escapes workspace root: ${fixturesPath}`);
  }

  const fixtures = parseFixtures(
    fs.readFileSync(canonicalFixturesFile, "utf8"),
    path.basename(canonicalFixturesFile),
  );
  const fixturesDir = path.dirname(canonicalFixturesFile);
  const env = {
    ...process.env,
    ...(toolchain ? { RUSTUP_TOOLCHAIN: toolchain } : {}),
  } as Record<string, string>;
  async function command(
    tool: string,
    args: string[],
    cwd: string,
    commandEnv = env,
  ): Promise<string> {
    let stdout = "",
      stderr = "";
    try {
      await exec.exec(tool, args, {
        cwd,
        env: commandEnv,
        silent: true,
        listeners: {
          stdout: (data) => {
            stdout += data.toString();
          },
          stderr: (data) => {
            stderr += data.toString();
          },
        },
      });
    } catch (error: any) {
      throw new Error(
        `${tool} ${args.join(" ")} failed: ${stderr || error.message}`,
      );
    }
    if (stderr.includes("Optimization skipped"))
      throw new Error(
        "Stellar CLI lacks optimization support; install the official release binary",
      );
    if (tool === "stellar" && args[0] === "contract")
      process.stdout.write(stdout + stderr);
    return stdout.trim();
  }
  const stellarVersion = await command("stellar", ["--version"], fixturesDir);
  const stellar = stellarVersion.match(/stellar (\d+)\.(\d+)\.(\d+)/);
  if (
    !stellar ||
    Number(stellar[1]) < 28 ||
    (Number(stellar[1]) === 28 && Number(stellar[2]) < 1)
  ) {
    throw new Error(
      `Stellar CLI 28.1+ with optimization support is required; got ${stellarVersion}`,
    );
  }

  const packageRustVersions = new Map<string, string>();
  async function probePackageCompiler(packageDir: string): Promise<string> {
    let version = packageRustVersions.get(packageDir);
    if (!version) {
      version = await command("rustc", ["--version"], packageDir);
      const rust = version.match(/^rustc (\d+)\.(\d+)\./);
      if (
        !rust ||
        Number(rust[1]) < 1 ||
        (Number(rust[1]) === 1 && Number(rust[2]) < 84)
      ) {
        throw new Error(
          `Rust 1.84+ is required for wasm32v1-none; got ${version}`,
        );
      }
      packageRustVersions.set(packageDir, version);
    }
    return version;
  }

  function validateDestinationPath(
    destination: string,
    contractWasmPath: string,
  ): void {
    const relFromRoot = path.relative(canonicalRoot, destination);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
      throw new Error(
        `WASM destination escapes workspace root for wasm_path ${contractWasmPath}: ${destination}`,
      );
    }

    let check = destination;
    while (
      check !== canonicalRoot &&
      path.relative(canonicalRoot, check) !== ""
    ) {
      try {
        const lstat = fs.lstatSync(check);
        if (lstat.isSymbolicLink()) {
          const canonicalCheck = fs.realpathSync(check);
          const relCheck = path.relative(canonicalRoot, canonicalCheck);
          if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
            throw new Error(
              `WASM destination symlink escapes workspace root for wasm_path ${contractWasmPath}: ${check} -> ${canonicalCheck}`,
            );
          }
        }
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
      const parent = path.dirname(check);
      if (parent === check) break;
      check = parent;
    }
  }

  const plans: Array<{
    destination: string;
    canonicalDestination: string;
    pkg: CargoPackage;
    targetName: string;
    wasmPath: string;
  }> = [];
  const metadataCache = new Map<string, CargoPackage[]>();
  const destinationOwnership = new Map<
    string,
    { pkg: CargoPackage; wasm_path: string }
  >();
  for (const contract of fixtures.contracts) {
    const destination = path.normalize(
      path.resolve(fixturesDir, contract.wasm_path),
    );
    const canonicalDestination = getCanonicalPath(destination);
    validateDestinationPath(destination, contract.wasm_path);

    let dir = path.dirname(destination);
    let manifest: string | null = null;
    while (true) {
      const relDir = path.relative(canonicalRoot, dir);
      if (relDir.startsWith("..") || path.isAbsolute(relDir)) {
        throw new Error(
          `Manifest search escaped workspace root for wasm_path ${contract.wasm_path}`,
        );
      }
      if (fs.existsSync(dir)) {
        const canonicalDir = fs.realpathSync(dir);
        const relCanonical = path.relative(canonicalRoot, canonicalDir);
        if (relCanonical.startsWith("..") || path.isAbsolute(relCanonical)) {
          throw new Error(
            `Manifest search traversed symlink escaping workspace root for wasm_path ${contract.wasm_path}`,
          );
        }
      }

      const candidate = path.join(dir, "Cargo.toml");
      if (fs.existsSync(candidate)) {
        const canonicalManifest = fs.realpathSync(candidate);
        const relManifest = path.relative(canonicalRoot, canonicalManifest);
        if (relManifest.startsWith("..") || path.isAbsolute(relManifest)) {
          throw new Error(
            `Cargo.toml symlink escapes workspace root for wasm_path ${contract.wasm_path}`,
          );
        }
        manifest = candidate;
        break;
      }

      const currentCanonical = fs.existsSync(dir)
        ? fs.realpathSync(dir)
        : path.resolve(dir);
      if (
        currentCanonical === canonicalRoot ||
        path.relative(canonicalRoot, currentCanonical) === ""
      ) {
        break;
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }

    if (!manifest) {
      throw new Error(
        `No Cargo.toml found for wasm_path ${contract.wasm_path}`,
      );
    }

    let packages = metadataCache.get(manifest);
    if (!packages) {
      let rawMetadata: unknown;
      try {
        rawMetadata = JSON.parse(
          await command(
            "cargo",
            [
              "metadata",
              "--no-deps",
              "--locked",
              "--format-version",
              "1",
              "--manifest-path",
              manifest,
            ],
            dir,
          ),
        );
      } catch (error: any) {
        throw new Error(
          `Failed to parse Cargo metadata for ${manifest}: ${error.message}`,
        );
      }
      const metadata = validateCargoMetadata(rawMetadata, manifest);
      packages = metadata.packages.filter(
        (pkg) =>
          metadata.workspace_members.includes(pkg.id) &&
          pkg.targets.some((target) => target.crate_types.includes("cdylib")),
      );
      metadataCache.set(manifest, packages);
    }
    const destinationName = path.basename(destination);
    const matches: Array<{ pkg: CargoPackage; targetName: string }> = [];
    for (const pkg of packages) {
      const cdylibTargets = pkg.targets.filter((target) =>
        target.crate_types.includes("cdylib"),
      );
      const targetNames = cdylibTargets.map(
        (target) => target.name ?? pkg.name,
      );
      if (
        !targetNames.some(
          (name) => `${name.replace(/-/g, "_")}.wasm` === destinationName,
        )
      ) {
        continue;
      }
      if (cdylibTargets.length > 1) {
        throw new Error(
          `Cargo package ${pkg.name} has ambiguous multiple cdylib targets; found ${cdylibTargets.length}`,
        );
      }
      matches.push({ pkg, targetName: targetNames[0] });
    }
    if (matches.length !== 1)
      throw new Error(
        `wasm_path ${contract.wasm_path} must identify exactly one Cargo cdylib package; found ${matches.length}`,
      );

    const { pkg, targetName } = matches[0];
    const canonicalPkgManifest = fs.realpathSync(pkg.manifest_path);
    const relPkg = path.relative(canonicalRoot, canonicalPkgManifest);
    if (relPkg.startsWith("..") || path.isAbsolute(relPkg)) {
      throw new Error(
        `Cargo package ${pkg.name} manifest escapes workspace root: ${pkg.manifest_path}`,
      );
    }

    const existing = destinationOwnership.get(canonicalDestination);
    if (existing) {
      if (
        existing.pkg.id !== pkg.id ||
        existing.pkg.manifest_path !== pkg.manifest_path
      ) {
        throw new Error(
          `Conflicting build destinations: ${contract.wasm_path} resolves to ${canonicalDestination} which is already claimed by package ${existing.pkg.name} (${existing.pkg.manifest_path})`,
        );
      }
    } else {
      destinationOwnership.set(canonicalDestination, {
        pkg,
        wasm_path: contract.wasm_path,
      });
    }

    const packageDir = path.dirname(pkg.manifest_path);
    await probePackageCompiler(packageDir);

    plans.push({
      destination,
      canonicalDestination,
      pkg,
      targetName,
      wasmPath: contract.wasm_path,
    });
  }

  const artifacts = new Map<string, Buffer>();
  const writtenDestinations = new Map<string, Buffer>();
  const results: BuiltContract[] = [];
  for (const {
    destination,
    canonicalDestination,
    pkg,
    targetName,
    wasmPath,
  } of plans) {
    const packageDir = path.dirname(pkg.manifest_path);
    const rustVersion = await probePackageCompiler(packageDir);
    let wasm = artifacts.get(pkg.manifest_path);
    if (!wasm) {
      let outputDir: string;
      try {
        outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-build-"));
      } catch (error: any) {
        throw new Error(
          `Cannot create build temporary storage: ${error.message}`,
        );
      }
      try {
        verifyBuildStorage(outputDir);
        const inputSnapshot = snapshotContractInputs(
          path.dirname(pkg.manifest_path),
        );
        await command(
          "stellar",
          [
            "contract",
            "build",
            "--manifest-path",
            pkg.manifest_path,
            "--package",
            pkg.name,
            "--locked",
            "--optimize=true",
            "--out-dir",
            outputDir,
          ],
          path.dirname(pkg.manifest_path),
          { ...env, TMPDIR: outputDir, TMP: outputDir, TEMP: outputDir },
        );
        assertContractInputsNotMutated(inputSnapshot);
        wasm = fs.readFileSync(
          path.join(outputDir, `${targetName.replace(/-/g, "_")}.wasm`),
        );
        verifyBuildStorage(outputDir, Math.max(1024 * 1024, wasm.length));
        if (
          !wasm
            .subarray(0, 8)
            .equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
        )
          throw new Error("Stellar build did not produce a valid WASM module");
        artifacts.set(pkg.manifest_path, wasm);
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    }
    validateDestinationPath(destination, wasmPath);
    const prevWritten = writtenDestinations.get(canonicalDestination);
    if (prevWritten) {
      if (!prevWritten.equals(wasm)) {
        throw new Error(
          `Conflicting build output for destination ${destination}: bytes disagree across declarations`,
        );
      }
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, wasm);
      writtenDestinations.set(canonicalDestination, wasm);
    }
    const record = {
      wasm_path: destination,
      manifest_path: pkg.manifest_path,
      package: pkg.name,
      wasm_sha256: createHash("sha256").update(wasm).digest("hex"),
      stellar_version: stellarVersion,
      rust_version: rustVersion,
    };
    console.log(
      `Built ${record.package}: ${destination}; SHA256 ${record.wasm_sha256}; ${stellarVersion}; ${rustVersion}`,
    );
    results.push(record);
  }
  return results;
}
