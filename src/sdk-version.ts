import * as fs from "fs";
import * as path from "path";

/** Name of the Soroban SDK package as declared in a Cargo.lock. */
const SOROBAN_SDK = "soroban-sdk";

/**
 * Result of resolving one build artifact to the Cargo workspace/lock that owns
 * it. The association is best-effort: it is read from on-disk lockfiles only,
 * never from RPC, and it does not prove how a prebuilt WASM was compiled.
 */
export interface SdkAssociation {
  /** Resolved WASM artifact path the association was computed for. */
  wasmPath: string;
  /** Nearest Cargo.toml manifest owning the artifact, or null when none exists. */
  manifestPath: string | null;
  /** Cargo.lock of the owning workspace, or null when no lock is discoverable. */
  lockPath: string | null;
  /**
   * Every `soroban-sdk` version declared as a package in the owning lock, in
   * lock order with duplicates removed. Empty when the lock is missing or
   * declares no `soroban-sdk` package.
   */
  versions: string[];
}

/**
 * Locate the Cargo manifest and workspace lock that own a build artifact,
 * without assuming one directory layout.
 *
 * Walking upward from the artifact's directory:
 *  - the first Cargo.toml is the owning crate's manifest (a nested crate, the
 *    `contract/Cargo.toml` convention crate, or a root workspace member);
 *  - the first Cargo.lock at or above that manifest is the owning workspace
 *    lock, so a `contract/Cargo.lock` next to a nested crate takes precedence
 *    over a repository root `Cargo.lock`, while a root workspace without a
 *    per-contract lock resolves to the root `Cargo.lock`.
 */
export function findOwningLock(wasmPath: string): {
  manifestPath: string | null;
  lockPath: string | null;
} {
  let dir = path.dirname(path.resolve(wasmPath));
  let manifestPath: string | null = null;
  for (;;) {
    const manifest = path.join(dir, "Cargo.toml");
    const lock = path.join(dir, "Cargo.lock");
    if (manifestPath === null && fs.existsSync(manifest)) {
      manifestPath = manifest;
    }
    if (fs.existsSync(lock)) {
      return { manifestPath, lockPath: lock };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return { manifestPath, lockPath: null };
    }
    dir = parent;
  }
}

/**
 * Extract every `soroban-sdk` version declared as a package in a Cargo.lock.
 * Dependency mentions (`"soroban-sdk",` in `dependencies = [...]`) do not
 * count: only `[[package]]` entries named `soroban-sdk` declare a version.
 */
export function parseSdkVersionsFromLock(lockContent: string): string[] {
  const versions: string[] = [];
  const blocks = lockContent.split(/(?=^\[\[package\]\])/m);
  for (const block of blocks) {
    if (!/^\[\[package\]\]\nname = "soroban-sdk"\n/.test(block)) continue;
    const m = block.match(/^version = "([^"]+)"/m);
    if (m) versions.push(m[1]);
  }
  return [...new Set(versions)];
}

/** Read a Cargo.lock and return its declared `soroban-sdk` versions (best-effort). */
export function readSdkVersionsFromLock(lockPath: string): string[] {
  try {
    return parseSdkVersionsFromLock(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Resolve each artifact to its owning Cargo workspace/lock and collect the
 * `soroban-sdk` versions declared there.
 */
export function discoverSdkAssociations(wasmPaths: string[]): SdkAssociation[] {
  return wasmPaths.map((wasmPath) => {
    const resolved = path.resolve(wasmPath);
    const { manifestPath, lockPath } = findOwningLock(resolved);
    const versions = lockPath ? readSdkVersionsFromLock(lockPath) : [];
    return { wasmPath: resolved, manifestPath, lockPath, versions };
  });
}

/**
 * Discover the `soroban-sdk` version for one artifact. Rendered honestly:
 * exactly one declared version is reported as-is; several coexisting versions
 * are reported as a comma-separated list; an unresolved association reports
 * `"unknown"`.
 */
export function discoverSdkVersion(wasmPath: string): string {
  return formatSdkVersions(discoverSdkAssociations([wasmPath])[0].versions);
}

/**
 * Render discovered versions as one string without pretending a single version
 * compiled a prebuilt artifact: `unknown` when unresolved, the lone version
 * when exactly one is declared, otherwise the declared versions joined with
 * `, `.
 */
export function formatSdkVersions(versions: string[]): string {
  if (versions.length === 0) return "unknown";
  if (versions.length === 1) return versions[0];
  return versions.join(", ");
}
