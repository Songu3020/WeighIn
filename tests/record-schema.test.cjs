const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootApi = require("..");
const schemaApi = require("../dist/record-schema");
const diffApi = require("../dist/diff");
const { parseFixtures } = require("../dist/identity");

const repoRoot = path.resolve(__dirname, "..");
const schemaFilePath = path.join(
  repoRoot,
  "docs/schemas/measurement-records.schema.json",
);

const archivedSchema3Files = [
  "docs/experiments/fail-closed/base.json",
  "docs/experiments/fail-closed/head.json",
  "docs/experiments/fail-closed/control.json",
  "docs/experiments/fail-closed/cli-results.json",
  "docs/experiments/native-integration/base.json",
  "docs/experiments/native-integration/head.json",
  "docs/experiments/native-integration/control.json",
  "docs/experiments/native-integration/cli-results.json",
];

const archivedSchema4Files = [
  "docs/experiments/metric-provenance/measurements.json",
  "docs/experiments/metric-provenance/cli-results.json",
  "docs/experiments/clean-delivery/completed/installed-cli/results.json",
  "docs/experiments/external-soroban-forge/provenance-checks/original-results.json",
  "docs/experiments/external-soroban-forge/provenance-checks/isolated-results.json",
  "docs/experiments/optimizer-repeatability/live/system-temp-1-results.json",
  "docs/experiments/optimizer-repeatability/live/workspace-temp-1-results.json",
];

function createSchema2Sample() {
  const identified = parseFixtures(
    JSON.stringify({
      id: "schema2-suite",
      contracts: [
        {
          id: "greeting",
          wasm_path: "contract/target/wasm32v1-none/release/contract_test.wasm",
          invocations: [
            {
              id: "world",
              function_name: "hello",
              args: [{ type: "Symbol", value: "world" }],
            },
          ],
        },
      ],
    }),
    "weighin-fixtures.json",
  );
  const metrics = Object.fromEntries(
    schemaApi.METRIC_KEYS.map((key) => [key, { consumed: 100, limit: 1000 }]),
  );
  return identified.contracts.map((contract) => ({
    schema_version: 2,
    fixture_id: identified.fixture_id,
    logical_id: contract.logical_id,
    contract_id: "CB33U7HZTCYZIQANL4PGKAZVNTQW3JYLZO4SICFV3OE72NHOQYT7KR63",
    git_commit: "1".repeat(40),
    soroban_sdk_version: "25.3.1",
    timestamp: 1791396000,
    benchmarks: contract.invocations.map((fn) => ({
      function_name: fn.function_name,
      case_id: fn.case_id,
      metrics: structuredClone(metrics),
      wasm_sha256: "a".repeat(64),
    })),
  }));
}

function createLegacySample() {
  const sample = createSchema2Sample();
  delete sample[0].schema_version;
  delete sample[0].fixture_id;
  delete sample[0].logical_id;
  delete sample[0].benchmarks[0].case_id;
  return sample;
}

test("public package root, diff module, and record-schema module export the standalone validator and version constants", () => {
  for (const mod of [rootApi, schemaApi, diffApi]) {
    assert.deepEqual(mod.SUPPORTED_RECORD_SCHEMA_VERSIONS, [2, 3, 4, 5]);
    assert.deepEqual(mod.SUPPORTED_MEASUREMENT_ENVELOPES, [
      "legacy",
      2,
      3,
      4,
      5,
    ]);
    assert.equal(mod.CURRENT_RECORD_SCHEMA_VERSION, 5);
    assert.equal(typeof mod.validateMeasurementRecord, "function");
    assert.equal(typeof mod.validateMeasurementRecords, "function");
    assert.equal(typeof mod.inspectMeasurementRecord, "function");
    assert.equal(typeof mod.inspectMeasurementRecords, "function");
    assert.equal(typeof mod.detectRecordEnvelopeVersion, "function");
    assert.equal(typeof mod.getMeasurementRecordJsonSchema, "function");
    assert.equal(typeof mod.MeasurementRecordValidationError, "function");
    assert.ok(Array.isArray(mod.RUNTIME_RECORD_INVARIANTS));
    assert.equal(mod.RUNTIME_RECORD_INVARIANTS.length, 5);
  }
});

test("genuine archived schema 3 and schema 4 measurement records validate standalone without RPC or diff", () => {
  for (const relPath of archivedSchema3Files) {
    const records = JSON.parse(
      fs.readFileSync(path.join(repoRoot, relPath), "utf8"),
    );
    const inspection = rootApi.inspectMeasurementRecords(records);
    assert.equal(inspection.valid, true, `Expected ${relPath} to be valid`);
    assert.equal(inspection.version, 3);
    assert.deepEqual(inspection.diagnostics, []);
    assert.equal(
      rootApi.validateMeasurementRecords(records).length,
      records.length,
    );
  }

  for (const relPath of archivedSchema4Files) {
    const records = JSON.parse(
      fs.readFileSync(path.join(repoRoot, relPath), "utf8"),
    );
    const inspection = rootApi.inspectMeasurementRecords(records);
    assert.equal(inspection.valid, true, `Expected ${relPath} to be valid`);
    assert.equal(inspection.version, 4);
    assert.deepEqual(inspection.diagnostics, []);
    assert.equal(
      rootApi.validateMeasurementRecords(records).length,
      records.length,
    );
  }

  const repeatabilityRuns = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "docs/experiments/repeatability/completed/runs.json"),
      "utf8",
    ),
  );
  for (const run of repeatabilityRuns) {
    assert.equal(
      rootApi.inspectMeasurementRecords(run.reference_measurements).valid,
      true,
    );
    assert.equal(
      rootApi.inspectMeasurementRecords(run.audit_measurements).valid,
      true,
    );
  }

  const snapshotRecoveryRuns = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "docs/experiments/snapshot-recovery/runs.json"),
      "utf8",
    ),
  );
  for (const run of snapshotRecoveryRuns) {
    assert.equal(rootApi.inspectMeasurementRecords(run).valid, true);
  }

  const schema2 = createSchema2Sample();
  assert.equal(rootApi.inspectMeasurementRecords(schema2).version, 2);
  assert.equal(rootApi.validateMeasurementRecords(schema2).length, 1);

  const legacy = createLegacySample();
  assert.equal(rootApi.inspectMeasurementRecords(legacy).version, "legacy");
  assert.equal(rootApi.validateMeasurementRecords(legacy).length, 1);
});

test("machine-readable JSON Schema matches checked-in artifact and defines explicit version discriminators and runtime invariants", () => {
  assert.ok(fs.existsSync(schemaFilePath), "JSON Schema file must exist");
  const diskSchema = JSON.parse(fs.readFileSync(schemaFilePath, "utf8"));
  const runtimeSchema = rootApi.getMeasurementRecordJsonSchema();
  assert.deepEqual(diskSchema, runtimeSchema);

  assert.equal(
    diskSchema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(diskSchema["x-weighin-current-version"], 5);
  assert.deepEqual(diskSchema["x-weighin-supported-versions"], [
    "legacy",
    2,
    3,
    4,
    5,
  ]);
  assert.equal(diskSchema.$defs.ContractBenchmark.oneOf.length, 5);
  assert.equal(
    diskSchema.$defs.LegacyContractBenchmark["x-weighin-envelope-version"],
    "legacy",
  );
  assert.equal(
    diskSchema.$defs.Schema2ContractBenchmark.properties.schema_version.const,
    2,
  );
  assert.equal(
    diskSchema.$defs.Schema3ContractBenchmark.properties.schema_version.const,
    3,
  );
  assert.equal(
    diskSchema.$defs.Schema4ContractBenchmark.properties.schema_version.const,
    4,
  );
  assert.equal(
    diskSchema.$defs.Schema5ContractBenchmark.properties.schema_version.const,
    5,
  );
  assert.equal(
    diskSchema.$defs.Schema5Metrics.properties.cpu_instructions.properties
      .source.const,
    "soroban-simulation.simulated_instructions",
  );
  assert.equal(
    diskSchema.$defs.Sha256Hex.pattern,
    "^[a-f0-9]{64}$",
    "Resource limits digest pattern must be preserved",
  );

  const invariantIds = diskSchema["x-weighin-runtime-invariants"].map(
    (item) => item.id,
  );
  assert.deepEqual(invariantIds, [
    "UNIQUE_CONTRACT_IDENTITY",
    "UNIQUE_BENCHMARK_IDENTITY",
    "HOMOGENEOUS_ENVELOPE_VERSION",
    "COMPARISON_ENVIRONMENT_COMPATIBILITY",
    "SAFE_INTEGER_BOUNDS",
  ]);
});

test("validator rejects unknown versions, missing metrics, unavailable-as-zero, and malformed provenance with exact field-path diagnostics", () => {
  const archivedS4 = JSON.parse(
    fs.readFileSync(
      path.join(
        repoRoot,
        "docs/experiments/metric-provenance/measurements.json",
      ),
      "utf8",
    ),
  );

  // 1. Unknown schema versions
  for (const invalidVersion of [0, 1, 6, 999, "4", null]) {
    const mutated = structuredClone(archivedS4);
    mutated[0].schema_version = invalidVersion;
    const res = rootApi.inspectMeasurementRecords(mutated);
    assert.equal(res.valid, false);
    assert.equal(res.diagnostics[0].path, "$[0].schema_version");
    assert.equal(res.diagnostics[0].code, "UNSUPPORTED_SCHEMA_VERSION");
    assert.throws(
      () => rootApi.validateMeasurementRecords(mutated),
      (err) => {
        assert.ok(err instanceof rootApi.MeasurementRecordValidationError);
        assert.equal(err.path, "$[0].schema_version");
        assert.match(err.message, /Version 2\/3\/4\/5 results require/);
        return true;
      },
    );
  }

  // 2. Missing metrics
  for (const key of ["cpu_instructions", "tx_size_bytes", "event_data_bytes"]) {
    const mutated = structuredClone(archivedS4);
    delete mutated[0].benchmarks[0].metrics[key];
    const res = rootApi.inspectMeasurementRecords(mutated);
    assert.equal(res.valid, false);
    assert.equal(
      res.diagnostics[0].path,
      `$[0].benchmarks[0].metrics.${key}`,
    );
    assert.equal(res.diagnostics[0].code, "MISSING_METRIC");
    assert.match(res.diagnostics[0].message, new RegExp(`Missing metric ${key}`));
  }

  // 3. Unavailable-as-zero and missing unavailable reason
  {
    const unavailableZero = structuredClone(archivedS4);
    unavailableZero[0].benchmarks[0].metrics.tx_size_bytes.consumed = 0;
    const res = rootApi.inspectMeasurementRecords(unavailableZero);
    assert.equal(res.valid, false);
    assert.equal(
      res.diagnostics[0].path,
      "$[0].benchmarks[0].metrics.tx_size_bytes.consumed",
    );
    assert.equal(res.diagnostics[0].code, "INVALID_UNAVAILABLE_METRIC");
    assert.match(res.diagnostics[0].message, /Invalid unavailable metric tx_size_bytes/);

    const unavailableBlankReason = structuredClone(archivedS4);
    unavailableBlankReason[0].benchmarks[0].metrics.tx_size_bytes.reason = "  ";
    const resReason = rootApi.inspectMeasurementRecords(unavailableBlankReason);
    assert.equal(resReason.valid, false);
    assert.equal(
      resReason.diagnostics[0].path,
      "$[0].benchmarks[0].metrics.tx_size_bytes.reason",
    );
    assert.equal(resReason.diagnostics[0].code, "INVALID_UNAVAILABLE_METRIC");
  }

  // 4. Malformed provenance and preserved resource_limits_sha256 digest check
  {
    const missingDigest = structuredClone(archivedS4);
    delete missingDigest[0].benchmarks[0].provenance.resource_limits_sha256;
    const resMissing = rootApi.inspectMeasurementRecords(missingDigest);
    assert.equal(resMissing.valid, false);
    assert.equal(
      resMissing.diagnostics[0].path,
      "$[0].benchmarks[0].provenance.resource_limits_sha256",
    );
    assert.match(
      resMissing.diagnostics[0].message,
      /Schema 4 requires resource_limits_sha256/,
    );

    const upperDigest = structuredClone(archivedS4);
    upperDigest[0].benchmarks[0].provenance.resource_limits_sha256 =
      "A".repeat(64);
    const resUpper = rootApi.inspectMeasurementRecords(upperDigest);
    assert.equal(resUpper.valid, false);
    assert.equal(
      resUpper.diagnostics[0].path,
      "$[0].benchmarks[0].provenance.resource_limits_sha256",
    );

    const badSeed = structuredClone(archivedS4);
    badSeed[0].benchmarks[0].provenance.seed = [1, 2, 3];
    const resSeed = rootApi.inspectMeasurementRecords(badSeed);
    assert.equal(resSeed.valid, false);
    assert.equal(
      resSeed.diagnostics[0].path,
      "$[0].benchmarks[0].provenance.seed",
    );
    assert.match(resSeed.diagnostics[0].message, /Invalid compute provenance: seed/);

    const badLedger = structuredClone(archivedS4);
    badLedger[0].benchmarks[0].provenance.ledger = -1;
    const resLedger = rootApi.inspectMeasurementRecords(badLedger);
    assert.equal(resLedger.valid, false);
    assert.equal(
      resLedger.diagnostics[0].path,
      "$[0].benchmarks[0].provenance.ledger",
    );
    assert.match(
      resLedger.diagnostics[0].message,
      /Invalid compute provenance: ledger\/protocol\/host_features/,
    );
  }
});

test("diffBenchmarks reuses the standalone validator, rejects malformed matched and unmatched records equally, and rejects mixed schemas", () => {
  const archivedS4 = JSON.parse(
    fs.readFileSync(
      path.join(
        repoRoot,
        "docs/experiments/metric-provenance/measurements.json",
      ),
      "utf8",
    ),
  );
  const archivedS3 = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "docs/experiments/native-integration/base.json"),
      "utf8",
    ),
  );

  // Malformed matched vs unmatched records fail with the exact same MeasurementRecordValidationError
  for (const matched of [true, false]) {
    const mutated = structuredClone(archivedS4);
    if (!matched) {
      mutated[0].logical_id = "id:unmatched-contract";
    }
    mutated[0].benchmarks[0].metrics.historical_data_read_bytes.consumed = 0;

    assert.throws(
      () => diffApi.diffBenchmarks(archivedS4, mutated),
      (err) => {
        assert.ok(err instanceof rootApi.MeasurementRecordValidationError);
        assert.equal(
          err.path,
          "$[0].benchmarks[0].metrics.historical_data_read_bytes.consumed",
        );
        assert.match(
          err.message,
          /Invalid unavailable metric historical_data_read_bytes/,
        );
        return true;
      },
    );
  }

  // Mixed versioned schemas fail explicitly whether matched or unmatched
  assert.throws(
    () => diffApi.diffBenchmarks(archivedS3, archivedS4),
    /Cannot compare measurements with different schema versions/,
  );

  const schema2 = createSchema2Sample();
  assert.throws(
    () => diffApi.diffBenchmarks(schema2, archivedS3),
    /Cannot compare measurements with different schema versions/,
  );

  // Mixing schema versions within a single saved measurement array is rejected
  assert.throws(
    () => rootApi.validateMeasurementRecords([archivedS3[0], archivedS4[0]]),
    (err) => {
      assert.ok(err instanceof rootApi.MeasurementRecordValidationError);
      assert.equal(err.path, "$[1].schema_version");
      assert.equal(err.code, "MIXED_SCHEMA_VERSIONS");
      assert.match(
        err.message,
        /Cannot compare measurements with different schema versions/,
      );
      return true;
    },
  );
});
