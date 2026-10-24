import { describe, it, expect } from "vitest";
import {
  CURRENT_RECORD_SCHEMA_VERSION,
  SUPPORTED_RECORD_SCHEMA_VERSIONS,
  SUPPORTED_MEASUREMENT_ENVELOPES,
  METRIC_KEYS,
  MeasurementRecordValidationError,
  detectRecordEnvelopeVersion,
  inspectMeasurementRecord,
  validateMeasurementRecord,
  inspectMeasurementRecords,
  validateMeasurementRecords,
  getMeasurementRecordJsonSchema,
} from "../src/record-schema";

function createLegacyRecord() {
  const metrics = Object.fromEntries(
    METRIC_KEYS.map((key) => [key, { consumed: 42, limit: 100 }]),
  );
  return {
    contract_id: "CAAA",
    git_commit: "abc1234",
    soroban_sdk_version: "25.3.1",
    timestamp: 1700000000,
    benchmarks: [
      {
        function_name: "invoke",
        wasm_sha256: "f".repeat(64),
        metrics,
      },
    ],
  };
}

describe("authoritative measurement record schema", () => {
  it("reports supported envelope versions and current schema version", () => {
    expect(CURRENT_RECORD_SCHEMA_VERSION).toBe(5);
    expect(SUPPORTED_RECORD_SCHEMA_VERSIONS).toEqual([2, 3, 4, 5]);
    expect(SUPPORTED_MEASUREMENT_ENVELOPES).toEqual(["legacy", 2, 3, 4, 5]);
  });

  it("validates legacy and schema 2 records and detects envelope versions", () => {
    const legacy = createLegacyRecord();
    expect(detectRecordEnvelopeVersion(legacy)).toBe("legacy");
    expect(validateMeasurementRecord(legacy)).toEqual(legacy);

    const schema2 = {
      ...createLegacyRecord(),
      schema_version: 2 as const,
      fixture_id: "id:suite",
      logical_id: "id:contract",
      benchmarks: [
        {
          ...createLegacyRecord().benchmarks[0],
          case_id: "id:default",
        },
      ],
    };
    expect(detectRecordEnvelopeVersion(schema2)).toBe(2);
    expect(validateMeasurementRecords([schema2])).toHaveLength(1);
  });

  it("produces field-path diagnostics for metadata, identity, and metric violations", () => {
    const badMetadata = {
      ...createLegacyRecord(),
      contract_id: "   ",
      timestamp: -5,
    };
    const res = inspectMeasurementRecord(badMetadata, 0);
    expect(res.valid).toBe(false);
    expect(res.diagnostics.map((d) => d.path)).toContain("$[0].contract_id");
    expect(res.diagnostics.map((d) => d.path)).toContain("$[0].timestamp");

    expect(() => validateMeasurementRecords([badMetadata])).toThrowError(
      MeasurementRecordValidationError,
    );
  });

  it("generates a deterministic JSON Schema with version discriminators", () => {
    const schema = getMeasurementRecordJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$defs.ContractBenchmark.oneOf).toHaveLength(5);
    expect(
      schema.$defs.Schema5Metrics.properties.cpu_instructions.properties.source
        .const,
    ).toBe("soroban-simulation.simulated_instructions");
  });
});
