import { describe, it, expect } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SourceAccountVariantListSchema,
  assertHeldFixed,
  computeSourceAccountEffects,
  measureSourceAccountEffects,
  SourceAccountRun,
} from "../src/source-account";
import { normalizeSourceAccount } from "../src/measurement";
import {
  METRIC_KEYS,
  validateBenchmarkComparisonCompatibility,
  validateMeasurementRecord,
} from "../src/record-schema";
import { ComputeProvenance } from "../src/simulation";

const ACCOUNT_A = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const ACCOUNT_B = "GCYNMW6XLAXBDC7PM3QGB47RMG2CQV3LQG6J5ZCMOHWXRCX26PUEHRJ6";

function createProvenance(
  overrides: Partial<ComputeProvenance> = {},
): ComputeProvenance {
  return {
    source: "soroban-simulation",
    source_version: "28.0.1",
    protocol: 28,
    helper_sha256: "a".repeat(64),
    network_id: "b".repeat(64),
    ledger: 100,
    header_sha256: "c".repeat(64),
    snapshot_sha256: "d".repeat(64),
    config_sha256: "e".repeat(64),
    compute_config_sha256: "f".repeat(64),
    input_sha256: "1".repeat(64),
    seed: new Array(32).fill(0),
    auth_mode: "recording(true,true)",
    host_features: ["recording_mode", "testutils"],
    resource_limits_sha256: "2".repeat(64),
    ...overrides,
  };
}

function createRun(
  label: string,
  sourceAccount: string,
  overrides: Partial<SourceAccountRun> = {},
): SourceAccountRun {
  const metrics = Object.fromEntries(
    METRIC_KEYS.map((key) => [key, { consumed: 10, limit: 100 }]),
  );
  return {
    label,
    source_account: sourceAccount,
    auth_mode: "recording(true,true)",
    host_features: ["recording_mode", "testutils"],
    seed: new Array(32).fill(0),
    protocol: 28,
    ledger: 100,
    metrics,
    resource_limits: {
      cpu_instructions: 100000,
      memory_bytes: 100000,
      ledger_read_entries: 10,
      ledger_read_bytes: 1000,
      ledger_write_entries: 2,
      ledger_write_bytes: 200,
      footprint_entries: 12,
      write_entries: 2,
    },
    provenance: createProvenance({ source_account: sourceAccount }),
    ...overrides,
  };
}

describe("source-account variants", () => {
  it("accepts two distinct accounts and rejects malformed input", () => {
    expect(
      SourceAccountVariantListSchema.safeParse([
        { label: "a", public_key: ACCOUNT_A },
        { label: "b", public_key: ACCOUNT_B },
      ]).success,
    ).toBe(true);
    expect(
      SourceAccountVariantListSchema.safeParse([
        { label: "a", public_key: ACCOUNT_A },
      ]).success,
    ).toBe(false);
    expect(
      SourceAccountVariantListSchema.safeParse([
        { label: "a", public_key: "not-a-key" },
        { label: "b", public_key: ACCOUNT_B },
      ]).success,
    ).toBe(false);
    expect(
      SourceAccountVariantListSchema.safeParse([
        { label: "a", public_key: ACCOUNT_A },
        { label: "a", public_key: ACCOUNT_B },
      ]).success,
    ).toBe(false);
    expect(
      SourceAccountVariantListSchema.safeParse([
        { label: "a", public_key: ACCOUNT_A },
        { label: "b", public_key: ACCOUNT_A },
      ]).success,
    ).toBe(false);
  });

  it("normalizes and rejects invocation source accounts", () => {
    expect(normalizeSourceAccount(` ${ACCOUNT_A} `)).toBe(ACCOUNT_A);
    expect(() => normalizeSourceAccount("not-a-key")).toThrow(
      /Ed25519 account public key/,
    );
  });
});

describe("source-account effects", () => {
  it("reports the consumed difference of every metric against the baseline", () => {
    const baseline = createRun("baseline", ACCOUNT_A);
    const variant = createRun("variant", ACCOUNT_B, {
      metrics: {
        ...baseline.metrics,
        cpu_instructions: { consumed: 25, limit: 100 },
      },
    });
    const effect = computeSourceAccountEffects(baseline, variant);
    expect(effect.changed_metrics).toEqual(["cpu_instructions"]);
    const cpu = effect.effects.find(
      (metric) => metric.metric === "cpu_instructions",
    );
    expect(cpu?.baseline).toBe(10);
    expect(cpu?.variant).toBe(25);
    expect(cpu?.delta).toBe(15);
    expect(cpu?.changed).toBe(true);
  });

  it("treats an unavailable metric as an unchanged metric", () => {
    const baseline = createRun("baseline", ACCOUNT_A);
    const variant = createRun("variant", ACCOUNT_B);
    const metrics = { ...baseline.metrics };
    metrics.tx_size_bytes = {
      consumed: null,
      limit: null,
      reason: "unavailable",
    };
    variant.metrics = metrics;
    const effect = computeSourceAccountEffects(baseline, variant);
    const txSize = effect.effects.find(
      (metric) => metric.metric === "tx_size_bytes",
    );
    expect(txSize?.delta).toBeNull();
    expect(txSize?.changed).toBe(false);
    expect(effect.changed_metrics).toEqual([]);
  });

  it("rejects a comparison whose environment drifted", () => {
    const baseline = createRun("baseline", ACCOUNT_A);
    const variant = createRun("variant", ACCOUNT_B, {
      provenance: createProvenance({
        source_account: ACCOUNT_B,
        protocol: 29,
      }),
    });
    expect(() => assertHeldFixed(baseline, variant)).toThrow(
      /not isolated: protocol changed/,
    );
  });

  it("accepts a comparison that only changed the source account", () => {
    const baseline = createRun("baseline", ACCOUNT_A);
    const variant = createRun("variant", ACCOUNT_B);
    expect(() => assertHeldFixed(baseline, variant)).not.toThrow();
  });
});

describe("source-account measurement", () => {
  it("rejects an invalid account before any network request", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("the network must not be contacted");
    }) as typeof globalThis.fetch;
    try {
      await expect(
        measureSourceAccountEffects({
          fixturesPath:
            "tests/fixtures/source-account/source-account-fixtures.json",
          rpcUrl: "http://localhost:8000/rpc",
          sourceAccounts: [
            { label: "malformed", public_key: "not-a-key" },
            { label: "unused", public_key: ACCOUNT_B },
          ],
        }),
      ).rejects.toThrow(/public_key must be an Ed25519 account public key/);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects a source account that does not exist on the network", async () => {
    const original = rpc.Server.prototype.getAccount;
    const originalFetch = globalThis.fetch;
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "weighin-source-account-test-"),
    );
    const keypair = Keypair.random();
    const keyFile = path.join(tempDir, "deployer.key");
    const fixturesPath = path.join(tempDir, "fixtures.json");
    fs.writeFileSync(keyFile, keypair.secret(), { mode: 0o600 });
    fs.writeFileSync(
      path.join(tempDir, "contract.wasm"),
      Buffer.from("test wasm"),
    );
    fs.writeFileSync(
      fixturesPath,
      JSON.stringify({
        contracts: [
          {
            id: "source-account-test",
            wasm_path: "contract.wasm",
            invocations: [
              { id: "constant", function_name: "constant_probe", args: [] },
            ],
          },
        ],
      }),
    );
    const accountRows =
      require("../docs/experiments/fixture-migration/bridge/rpc.json").flatMap(
        (capture: any) => capture.raw.result?.entries || [],
      );
    const accountRow = accountRows.find((entry: any) => {
      try {
        return (
          xdr.LedgerEntryData.fromXDR(entry.xdr, "base64").switch().name ===
          "account"
        );
      } catch {
        return false;
      }
    });
    const accountValue = xdr.LedgerEntryData.fromXDR(accountRow.xdr, "base64");
    accountValue.account().accountId(keypair.xdrPublicKey());
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            latestLedger: 100,
            entries: [
              {
                key: request.params.keys[0],
                xdr: accountValue.toXDR("base64"),
              },
            ],
          },
        }),
      );
    }) as typeof globalThis.fetch;
    rpc.Server.prototype.getAccount = (async () => {
      throw new Error("Account not found");
    }) as typeof rpc.Server.prototype.getAccount;
    try {
      await expect(
        measureSourceAccountEffects({
          fixturesPath,
          rpcUrl: "http://localhost:8000/rpc",
          keyFile,
          sourceAccounts: [
            { label: "missing", public_key: ACCOUNT_A },
            { label: "unused", public_key: ACCOUNT_B },
          ],
        }),
      ).rejects.toThrow(/is not available on the network/);
    } finally {
      rpc.Server.prototype.getAccount = original;
      globalThis.fetch = originalFetch;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("record schema source account", () => {
  const metrics = Object.fromEntries(
    METRIC_KEYS.map((key) => [
      key,
      {
        availability: "measured",
        consumed: 42,
        limit: 100,
        source: "soroban-simulation",
        limit_source: "protocol-28-ledger-configuration",
      },
    ]),
  );
  const record = (sourceAccount?: string) => ({
    schema_version: 4 as const,
    fixture_id: "id:suite",
    logical_id: "id:contract",
    contract_id: "CAAA",
    git_commit: "abc1234",
    soroban_sdk_version: "28.0.0",
    timestamp: 1700000000,
    benchmarks: [
      {
        function_name: "invoke",
        case_id: "id:default",
        wasm_sha256: "f".repeat(64),
        metrics,
        provenance: createProvenance(
          sourceAccount === undefined ? {} : { source_account: sourceAccount },
        ),
      },
    ],
  });

  it("accepts a record with and without a source account", () => {
    expect(() => validateMeasurementRecord(record())).not.toThrow();
    expect(() => validateMeasurementRecord(record(ACCOUNT_A))).not.toThrow();
  });

  it("rejects a malformed source account", () => {
    expect(() => validateMeasurementRecord(record("not-a-key"))).toThrow(
      /source_account/,
    );
  });

  it("rejects a comparison of records measured under different source accounts", () => {
    const base = record(ACCOUNT_A);
    const head = record(ACCOUNT_B);
    expect(() =>
      validateBenchmarkComparisonCompatibility(
        base.benchmarks[0],
        head.benchmarks[0],
      ),
    ).toThrow(/source_account/);
    expect(() =>
      validateBenchmarkComparisonCompatibility(
        base.benchmarks[0],
        record(ACCOUNT_A).benchmarks[0],
      ),
    ).not.toThrow();
  });
});
