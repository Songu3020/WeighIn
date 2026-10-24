import { describe, it, expect } from "vitest";
import { toScVal } from "../src/measurement";
import { Keypair } from "@stellar/stellar-sdk";

describe("configured argument conversion", () => {
  it("encodes scalar values and preserves large integers", () => {
    expect(toScVal({ type: "Symbol", value: "hello" }).switch().name).toBe(
      "scvSymbol",
    );
    expect(toScVal({ type: "u32", value: 42 }).switch().name).toBe("scvU32");
    expect(
      toScVal({ type: "u64", value: "18446744073709551615" }).switch().name,
    ).toBe("scvU64");
    expect(
      toScVal({
        type: "i128",
        value: "-170141183460469231731687303715884105728",
      }).switch().name,
    ).toBe("scvI128");
  });

  it("encodes addresses, bytes and recursive vector/map values", () => {
    expect(
      toScVal({ type: "address", value: Keypair.random().publicKey() }).switch()
        .name,
    ).toBe("scvAddress");
    expect(toScVal({ type: "bytes", value: "00ff" }).switch().name).toBe(
      "scvBytes",
    );
    expect(
      toScVal({ type: "vec", value: [{ type: "string", value: "x" }] }).switch()
        .name,
    ).toBe("scvVec");
    expect(
      toScVal({
        type: "map",
        value: [
          {
            key: { type: "u32", value: 1 },
            value: { type: "bool", value: true },
          },
        ],
      }).switch().name,
    ).toBe("scvMap");
  });

  it("rejects invalid numeric, address and byte arguments", () => {
    expect(() => toScVal({ type: "u64", value: "invalid" })).toThrow(
      /valid integer string/,
    );
    expect(() => toScVal({ type: "address", value: "invalid" })).toThrow(
      /Invalid value for address/,
    );
    expect(() => toScVal({ type: "bytes", value: "0" })).toThrow(/even length/);
  });
});

describe("WASM preflight and resolution (#119, #120)", () => {
  it("resolves existing declared WASM directly", async () => {
    const { resolveWasmPath, validateWasmArtifact } =
      await import("../src/measurement");
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-test-"));
    try {
      const wasmPath = path.join(tmpDir, "contract.wasm");
      const validWasmHeader = Buffer.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04,
      ]);
      fs.writeFileSync(wasmPath, validWasmHeader);

      const resolved = resolveWasmPath(tmpDir, "contract.wasm");
      expect(resolved).toBe(wasmPath);

      const validated = validateWasmArtifact(tmpDir, "contract.wasm");
      expect(validated.resolvedPath).toBe(wasmPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails closed on missing declared WASM without opt-in (#120)", async () => {
    const { resolveWasmPath } = await import("../src/measurement");
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-test-"));
    try {
      const altDir = path.join(
        tmpDir,
        "target",
        "wasm32-unknown-unknown",
        "release",
      );
      fs.mkdirSync(altDir, { recursive: true });
      fs.writeFileSync(
        path.join(altDir, "contract.wasm"),
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      );

      // Declared path uses wasm32v1-none, but only wasm32-unknown-unknown exists
      const declared = "target/wasm32v1-none/release/contract.wasm";

      // By default, must fail closed
      expect(() => resolveWasmPath(tmpDir, declared)).toThrow(/WASM not found/);

      // With opt-in, it should resolve to alternate
      const resolved = resolveWasmPath(tmpDir, declared, {
        allowCrossTargetSubstitution: true,
      });
      expect(resolved).toBe(path.join(altDir, "contract.wasm"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects non-regular files and invalid WASM headers (#119)", async () => {
    const { validateWasmArtifact } = await import("../src/measurement");
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-test-"));
    try {
      const dirAsWasm = path.join(tmpDir, "directory.wasm");
      fs.mkdirSync(dirAsWasm);
      expect(() => validateWasmArtifact(tmpDir, "directory.wasm")).toThrow(
        /not a regular file/,
      );

      const invalidWasm = path.join(tmpDir, "invalid.wasm");
      fs.writeFileSync(invalidWasm, Buffer.from("not-a-wasm-binary"));
      expect(() => validateWasmArtifact(tmpDir, "invalid.wasm")).toThrow(
        /Invalid WASM header/,
      );

      const truncatedWasm = path.join(tmpDir, "truncated.wasm");
      fs.writeFileSync(truncatedWasm, Buffer.from([0x00, 0x61]));
      expect(() => validateWasmArtifact(tmpDir, "truncated.wasm")).toThrow(
        /Invalid WASM header/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("aggregates preflight errors across multiple contracts (#119)", async () => {
    const { preflightContractArtifacts } = await import("../src/measurement");
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-test-"));
    try {
      const contracts = [
        { wasm_path: "missing1.wasm", logical_id: "contract-a" },
        { wasm_path: "missing2.wasm", logical_id: "contract-b" },
      ];

      expect(() =>
        preflightContractArtifacts(tmpDir, contracts, "fixtures/test.json"),
      ).toThrowError(
        /fixtures\/test\.json \/ contract-a[\s\S]*fixtures\/test\.json \/ contract-b/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
