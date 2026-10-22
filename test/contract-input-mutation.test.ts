import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  snapshotContractInputs,
  assertContractInputsNotMutated,
} from "../src/build";

describe("Contract Input Mutation Assertion (#167)", () => {
  let tempDir: string;
  let pkgDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-mutation-test-"));
    pkgDir = path.join(tempDir, "contract");
    fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });

    // Initial files
    fs.writeFileSync(
      path.join(pkgDir, "Cargo.toml"),
      '[package]\nname = "test"\n',
    );
    fs.writeFileSync(path.join(pkgDir, "Cargo.lock"), "# Lockfile version 3\n");
    fs.writeFileSync(
      path.join(pkgDir, "src", "lib.rs"),
      "pub fn add(a: u32, b: u32) -> u32 { a + b }\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes when manifests, lockfile, and sources are unchanged", () => {
    const snapshot = snapshotContractInputs(pkgDir);

    // Simulated build action that only writes outputs in target/ or out/
    const targetDir = path.join(pkgDir, "target");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, "test.wasm"),
      Buffer.from([0, 97, 115, 109]),
    );

    expect(() => assertContractInputsNotMutated(snapshot)).not.toThrow();
  });

  it("fails when Cargo.lock is mutated by the build", () => {
    const snapshot = snapshotContractInputs(pkgDir);

    // Simulate mutation of Cargo.lock by unlocked cargo resolution
    fs.writeFileSync(path.join(pkgDir, "Cargo.lock"), "# Mutated lockfile\n");

    expect(() => assertContractInputsNotMutated(snapshot)).toThrow(
      /Default contract build mutated tracked inputs: Cargo\.lock was modified/,
    );
  });

  it("fails when Cargo.toml is mutated by the build", () => {
    const snapshot = snapshotContractInputs(pkgDir);

    fs.writeFileSync(
      path.join(pkgDir, "Cargo.toml"),
      '[package]\nname = "mutated"\n',
    );

    expect(() => assertContractInputsNotMutated(snapshot)).toThrow(
      /Default contract build mutated tracked inputs: Cargo\.toml was modified/,
    );
  });

  it("fails when a Rust source file is modified or removed", () => {
    const snapshot = snapshotContractInputs(pkgDir);

    fs.writeFileSync(path.join(pkgDir, "src", "lib.rs"), "// mutated source\n");

    expect(() => assertContractInputsNotMutated(snapshot)).toThrow(
      /Default contract build mutated tracked inputs: lib\.rs was modified/,
    );

    fs.rmSync(path.join(pkgDir, "src", "lib.rs"));
    expect(() => assertContractInputsNotMutated(snapshot)).toThrow(
      /Default contract build mutated tracked inputs: input file was deleted/,
    );
  });

  it("permits generated output changes and preserves preexisting unrelated edits", () => {
    // Make an unrelated preexisting edit outside the contract package before snapshotting
    const unrelatedDir = path.join(tempDir, "unrelated");
    fs.mkdirSync(unrelatedDir, { recursive: true });
    const unrelatedFile = path.join(unrelatedDir, "notes.txt");
    fs.writeFileSync(unrelatedFile, "initial notes");

    const snapshot = snapshotContractInputs(pkgDir);

    // Modify unrelated file and create outputs
    fs.writeFileSync(unrelatedFile, "updated notes after snapshot");
    const outputWasm = path.join(tempDir, "contract.wasm");
    fs.writeFileSync(outputWasm, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));

    expect(() => assertContractInputsNotMutated(snapshot)).not.toThrow();
  });
});
