import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
import * as exec from "@actions/exec";
import { parseFixtures } from "./identity";

export interface BuiltContract {
  wasm_path: string;
  manifest_path: string;
  package: string;
  wasm_sha256: string;
  stellar_version: string;
  rust_version: string;
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

interface CargoPackage {
  id: string;
  name: string;
  manifest_path: string;
  targets: Array<{ name?: string; crate_types: string[] }>;
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
  fixturesPath: string,
  rustToolchain?: string,
): Promise<BuiltContract[]> {
  const fixtures = parseFixtures(
    fs.readFileSync(fixturesPath, "utf8"),
    path.basename(fixturesPath),
  );
  const fixturesDir = path.dirname(path.resolve(fixturesPath));
  const env = {
    ...process.env,
    ...(rustToolchain ? { RUSTUP_TOOLCHAIN: rustToolchain } : {}),
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
  const rustVersion = await command("rustc", ["--version"], fixturesDir);
  const rust = rustVersion.match(/^rustc (\d+)\.(\d+)\./);
  if (
    !rust ||
    Number(rust[1]) < 1 ||
    (Number(rust[1]) === 1 && Number(rust[2]) < 84)
  ) {
    throw new Error(
      `Rust 1.84+ is required for wasm32v1-none; got ${rustVersion}`,
    );
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

  const plans: Array<{
    destination: string;
    pkg: CargoPackage;
    targetName: string;
  }> = [];
  const metadataCache = new Map<string, CargoPackage[]>();
  for (const contract of fixtures.contracts) {
    const destination = path.resolve(fixturesDir, contract.wasm_path);
    let dir = path.dirname(destination);
    while (!fs.existsSync(path.join(dir, "Cargo.toml"))) {
      const parent = path.dirname(dir);
      if (parent === dir)
        throw new Error(
          `No Cargo.toml found for wasm_path ${contract.wasm_path}`,
        );
      dir = parent;
    }
    const manifest = path.join(dir, "Cargo.toml");
    let packages = metadataCache.get(manifest);
    if (!packages) {
      const metadata = JSON.parse(
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
      packages = (metadata.packages as CargoPackage[]).filter(
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
    plans.push({ destination, pkg, targetName });
  }

  const artifacts = new Map<string, Buffer>();
  const results: BuiltContract[] = [];
  for (const { destination, pkg, targetName } of plans) {
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
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, wasm);
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
