import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeHelperCacheKey,
  resolveSimulationHelper,
  validateFootprintKeys,
  validateLedgerHeaderHash,
  _resetSimulationHelperState,
} from "../src/simulation";

describe("Simulation Helper Provisioning & Cache (Issues #75 & #76)", () => {
  beforeEach(() => {
    _resetSimulationHelperState();
    delete process.env.WEIGHIN_HELPER_PATH;
  });

  afterEach(() => {
    _resetSimulationHelperState();
    delete process.env.WEIGHIN_HELPER_PATH;
    vi.restoreAllMocks();
  });

  describe("computeHelperCacheKey (Issue #76)", () => {
    it("generates a deterministic cache key with complete compatibility inputs", () => {
      const key1 = computeHelperCacheKey({
        os: "linux",
        arch: "x64",
        toolchain: "1.95.0",
        target: "x86_64-unknown-linux-gnu",
        features: ["testutils"],
        flags: ["--release", "--locked"],
      });
      const key2 = computeHelperCacheKey({
        os: "linux",
        arch: "x64",
        toolchain: "1.95.0",
        target: "x86_64-unknown-linux-gnu",
        features: ["testutils"],
        flags: ["--release", "--locked"],
      });

      expect(key1).toBe(key2);
      expect(key1).toContain(
        "linux-x64-cargo-simulation-helper-1.95.0-x86_64-unknown-linux-gnu-",
      );
    });

    it("invalidates cache key when toolchain, target, features or flags differ", () => {
      const baseKey = computeHelperCacheKey({ toolchain: "1.95.0" });
      const diffToolchain = computeHelperCacheKey({ toolchain: "1.96.0" });
      const diffTarget = computeHelperCacheKey({
        target: "aarch64-unknown-linux-gnu",
      });
      const diffFeatures = computeHelperCacheKey({
        features: ["extra-feature"],
      });
      const diffFlags = computeHelperCacheKey({ flags: ["--debug"] });

      expect(diffToolchain).not.toBe(baseKey);
      expect(diffTarget).not.toBe(baseKey);
      expect(diffFeatures).not.toBe(baseKey);
      expect(diffFlags).not.toBe(baseKey);
    });
  });

  describe("resolveSimulationHelper recovery and deduplication (Issue #75)", () => {
    let originalPlatform: PropertyDescriptor | undefined;
    let originalArch: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      originalArch = Object.getOwnPropertyDescriptor(process, "arch");
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: "x64" });
    });

    afterEach(() => {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
      if (originalArch) {
        Object.defineProperty(process, "arch", originalArch);
      }
    });

    it("respects explicit executable overrides", async () => {
      const nodeExe = process.execPath;
      const helper = await resolveSimulationHelper(nodeExe);
      expect(helper).toBe(nodeExe);
    });

    it("rejects invalid or missing explicit helper override", async () => {
      await expect(
        resolveSimulationHelper("/nonexistent/helper/path"),
      ).rejects.toThrow(/Simulation helper missing or not executable/);
    });

    it("recovers on subsequent attempt after a failed build attempt", async () => {
      let attempts = 0;
      const failingBuild = async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("Cargo build failed: network error");
        }
        return "/target/release/weighin-simulation";
      };

      // First attempt fails
      await expect(
        resolveSimulationHelper(undefined, failingBuild),
      ).rejects.toThrow(/Cargo build failed: network error/);
      expect(attempts).toBe(1);

      // Second attempt succeeds and returns binary
      const recovered = await resolveSimulationHelper(undefined, failingBuild);
      expect(recovered).toBe("/target/release/weighin-simulation");
      expect(attempts).toBe(2);

      // Third attempt reuses the successful cached helper
      const cached = await resolveSimulationHelper(undefined, failingBuild);
      expect(cached).toBe("/target/release/weighin-simulation");
      expect(attempts).toBe(2);
    });

    it("deduplicates concurrent callers onto the same in-flight build", async () => {
      let buildCount = 0;
      const slowBuild = async () => {
        buildCount++;
        await new Promise((r) => setTimeout(r, 20));
        return "/target/release/weighin-simulation";
      };

      const [res1, res2, res3] = await Promise.all([
        resolveSimulationHelper(undefined, slowBuild),
        resolveSimulationHelper(undefined, slowBuild),
        resolveSimulationHelper(undefined, slowBuild),
      ]);

      expect(buildCount).toBe(1);
      expect(res1).toBe("/target/release/weighin-simulation");
      expect(res2).toBe("/target/release/weighin-simulation");
      expect(res3).toBe("/target/release/weighin-simulation");
    });
  });

  describe("Footprint key validation (#121)", () => {
    it("accepts valid disjoint and unique read-only and read-write footprint keys", () => {
      const ro = ["AAAA...", "BBBB..."];
      const rw = ["CCCC...", "DDDD..."];
      expect(() => validateFootprintKeys(ro, rw)).not.toThrow();
    });

    it("rejects duplicates within read-only footprint keys", () => {
      const ro = ["AAAA...", "BBBB...", "AAAA..."];
      const rw = ["CCCC..."];
      expect(() => validateFootprintKeys(ro, rw)).toThrow(
        /duplicate key\(s\) in read-only footprint: \[AAAA\.\.\.\]/,
      );
    });

    it("rejects duplicates within read-write footprint keys", () => {
      const ro = ["AAAA..."];
      const rw = ["CCCC...", "DDDD...", "CCCC..."];
      expect(() => validateFootprintKeys(ro, rw)).toThrow(
        /duplicate key\(s\) in read-write footprint: \[CCCC\.\.\.\]/,
      );
    });

    it("rejects overlapping keys between read-only and read-write footprints", () => {
      const ro = ["AAAA...", "SHARED..."];
      const rw = ["SHARED...", "CCCC..."];
      expect(() => validateFootprintKeys(ro, rw)).toThrow(
        /key\(s\) present in both read-only and read-write footprints: \[SHARED\.\.\.\]/,
      );
    });
  });

  describe("Ledger Header Hash validation (#122)", () => {
    it("accepts valid ledger header history entry whose hash matches decoded header bytes", async () => {
      const { xdr } = await import("@stellar/stellar-sdk");
      const crypto = await import("crypto");
      const replay = (
        await import("../docs/experiments/repeatability/completed/run-1-native.json")
      ).default[0];

      const header = xdr.LedgerHeader.fromXDR(
        replay.input.header_xdr,
        "base64",
      );
      const expectedHashBuf = crypto
        .createHash("sha256")
        .update(header.toXDR())
        .digest();
      const expectedHashHex = expectedHashBuf.toString("hex");

      const history = new xdr.LedgerHeaderHistoryEntry({
        hash: expectedHashBuf,
        header,
        ext: new xdr.LedgerHeaderHistoryEntryExt(0),
      });

      const res = validateLedgerHeaderHash(history, expectedHashHex);
      expect(res.recomputedHash).toBe(expectedHashHex);
      expect(res.historyHash).toBe(expectedHashHex);
    });

    it("rejects history entry with mismatched hash", async () => {
      const { xdr } = await import("@stellar/stellar-sdk");
      const replay = (
        await import("../docs/experiments/repeatability/completed/run-1-native.json")
      ).default[0];

      const header = xdr.LedgerHeader.fromXDR(
        replay.input.header_xdr,
        "base64",
      );
      const wrongHashBuf = Buffer.alloc(32, 0xaa);

      const history = new xdr.LedgerHeaderHistoryEntry({
        hash: wrongHashBuf,
        header,
        ext: new xdr.LedgerHeaderHistoryEntryExt(0),
      });

      expect(() => validateLedgerHeaderHash(history)).toThrow(
        /Ledger header hash mismatch: history-entry hash/i,
      );
    });

    it("rejects when RPC row hash disagrees with decoded header hash", async () => {
      const { xdr } = await import("@stellar/stellar-sdk");
      const crypto = await import("crypto");
      const replay = (
        await import("../docs/experiments/repeatability/completed/run-1-native.json")
      ).default[0];

      const header = xdr.LedgerHeader.fromXDR(
        replay.input.header_xdr,
        "base64",
      );
      const expectedHashBuf = crypto
        .createHash("sha256")
        .update(header.toXDR())
        .digest();

      const history = new xdr.LedgerHeaderHistoryEntry({
        hash: expectedHashBuf,
        header,
        ext: new xdr.LedgerHeaderHistoryEntryExt(0),
      });

      const wrongRowHash =
        "0000000000000000000000000000000000000000000000000000000000000000";
      expect(() => validateLedgerHeaderHash(history, wrongRowHash)).toThrow(
        /Ledger header hash mismatch: RPC response hash/i,
      );
    });
  });
});
