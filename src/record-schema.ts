import type { ComputeProvenance } from "./simulation";
import type {
  ContractBenchmark,
  BenchmarkResult,
  Metrics,
  MetricValue,
} from "./measurement";

// All 11 metric keys in display order
export const METRIC_KEYS = [
  "cpu_instructions",
  "memory_bytes",
  "ledger_read_entries",
  "ledger_read_bytes",
  "ledger_write_entries",
  "ledger_write_bytes",
  "historical_data_read_bytes",
  "contract_data_hard_limit",
  "tx_size_bytes",
  "events_count",
  "event_data_bytes",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/** Current measurement record schema emitted by `runMeasurement`. */
export const CURRENT_RECORD_SCHEMA_VERSION = 4 as const;

/** Explicitly versioned measurement record schemas accepted by WeighIn. */
export const SUPPORTED_RECORD_SCHEMA_VERSIONS = [2, 3, 4] as const;

export type RecordSchemaVersion =
  (typeof SUPPORTED_RECORD_SCHEMA_VERSIONS)[number];

/** All accepted saved measurement envelopes, including legacy unversioned records. */
export const SUPPORTED_MEASUREMENT_ENVELOPES = ["legacy", 2, 3, 4] as const;

export type MeasurementEnvelopeVersion =
  (typeof SUPPORTED_MEASUREMENT_ENVELOPES)[number];

/**
 * Invariants enforced at runtime beyond static JSON Schema validation.
 */
export const RUNTIME_RECORD_INVARIANTS = [
  {
    id: "UNIQUE_CONTRACT_IDENTITY",
    scope: "record_set",
    description:
      'Within a saved measurement array, no two ContractBenchmark entries may share the same comparison key (["legacy", contract_id] for legacy records or ["logical", fixture_id, logical_id] for schema 2/3/4 records).',
  },
  {
    id: "UNIQUE_BENCHMARK_IDENTITY",
    scope: "contract_record",
    description:
      "Within a ContractBenchmark.benchmarks array, no two BenchmarkResult entries may share the same [function_name, case_id ?? null] identity.",
  },
  {
    id: "HOMOGENEOUS_ENVELOPE_VERSION",
    scope: "record_set",
    description:
      "All ContractBenchmark entries within a single saved measurement array must use the same envelope version (legacy, 2, 3, or 4).",
  },
  {
    id: "COMPARISON_ENVIRONMENT_COMPATIBILITY",
    scope: "comparison",
    description:
      "When comparing BASE and HEAD measurement sets, versioned schemas must match, and paired benchmarks with provenance must have identical source, source_version, protocol, helper_sha256, network_id, compute_config_sha256, seed, auth_mode, host_features, resource_limits_sha256, source_account, and schema-4 per-metric availability/source/limit/limit_source/limit_reason.",
  },
  {
    id: "SAFE_INTEGER_BOUNDS",
    scope: "value",
    description:
      "Numeric consumption, limit, timestamp, ledger, and protocol values must satisfy Number.isSafeInteger in JavaScript runtime validation.",
  },
] as const;

export interface RecordValidationDiagnostic {
  /** JSONPath-style field path pointing to the offending value. */
  path: string;
  /** Detected envelope version for the record being validated. */
  version: MeasurementEnvelopeVersion | "unknown";
  /** Stable machine-readable diagnostic code. */
  code: string;
  /** Human-readable diagnostic message. */
  message: string;
}

export class MeasurementRecordValidationError extends Error {
  readonly path: string;
  readonly version: MeasurementEnvelopeVersion | "unknown";
  readonly code: string;
  readonly diagnostics: RecordValidationDiagnostic[];

  constructor(diagnostics: RecordValidationDiagnostic[]) {
    const first = diagnostics[0] ?? {
      path: "$",
      version: "unknown" as const,
      code: "INVALID_RECORD",
      message: "Invalid measurement record",
    };
    super(`${first.message} [path: ${first.path}]`);
    this.name = "MeasurementRecordValidationError";
    this.path = first.path;
    this.version = first.version;
    this.code = first.code;
    this.diagnostics = diagnostics;
  }
}

export interface SingleRecordValidationResult {
  valid: boolean;
  version: MeasurementEnvelopeVersion | "unknown";
  contractKey?: string;
  record?: ContractBenchmark;
  diagnostics: RecordValidationDiagnostic[];
}

export interface RecordValidationResult {
  valid: boolean;
  version: MeasurementEnvelopeVersion | "unknown" | null;
  records?: ContractBenchmark[];
  diagnostics: RecordValidationDiagnostic[];
}

const CONTRACT_ALLOWED_KEYS = new Set([
  "schema_version",
  "fixture_id",
  "logical_id",
  "contract_id",
  "git_commit",
  "soroban_sdk_version",
  "timestamp",
  "benchmarks",
]);

const BENCHMARK_ALLOWED_KEYS = new Set([
  "function_name",
  "case_id",
  "metrics",
  "wasm_sha256",
  "provenance",
]);

const METRIC_VALUE_ALLOWED_KEYS = new Set([
  "availability",
  "consumed",
  "limit",
  "reason",
  "source",
  "limit_source",
  "limit_reason",
]);

const PROVENANCE_ALLOWED_KEYS = new Set([
  "source",
  "source_version",
  "protocol",
  "helper_sha256",
  "network_id",
  "ledger",
  "header_sha256",
  "snapshot_sha256",
  "config_sha256",
  "compute_config_sha256",
  "input_sha256",
  "seed",
  "auth_mode",
  "host_features",
  "resource_limits_sha256",
  "source_account",
]);

const PROVENANCE_REQUIRED_STRINGS = [
  "source",
  "source_version",
  "helper_sha256",
  "network_id",
  "compute_config_sha256",
  "header_sha256",
  "snapshot_sha256",
  "config_sha256",
  "input_sha256",
  "auth_mode",
] as const;

const METRIC_KEY_SET = new Set<string>(METRIC_KEYS);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
/** Ed25519 account public keys (StrKey "G..." form). */
const ACCOUNT_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Determine the envelope version of a candidate record without throwing.
 */
export function detectRecordEnvelopeVersion(
  record: unknown,
): MeasurementEnvelopeVersion | "unknown" {
  if (!isPlainObject(record)) return "unknown";
  const hasLogical =
    record.schema_version !== undefined ||
    record.fixture_id !== undefined ||
    record.logical_id !== undefined;
  if (!hasLogical) return "legacy";
  if (
    record.schema_version === 2 ||
    record.schema_version === 3 ||
    record.schema_version === 4
  ) {
    return record.schema_version;
  }
  return "unknown";
}

function validateProvenanceObject(
  provenance: unknown,
  version: MeasurementEnvelopeVersion | "unknown",
  pPath: string,
  diagnostics: RecordValidationDiagnostic[],
): void {
  if (!isPlainObject(provenance)) {
    diagnostics.push({
      path: pPath,
      version,
      code: "INVALID_PROVENANCE_OBJECT",
      message: `Schema ${version} benchmarks require compute provenance`,
    });
    return;
  }

  for (const key of Object.keys(provenance)) {
    if (!PROVENANCE_ALLOWED_KEYS.has(key)) {
      diagnostics.push({
        path: `${pPath}.${key}`,
        version,
        code: "UNKNOWN_PROVENANCE_FIELD",
        message: `Invalid compute provenance: unexpected field ${key}`,
      });
    }
  }

  for (const field of PROVENANCE_REQUIRED_STRINGS) {
    if (!nonblank(provenance[field])) {
      diagnostics.push({
        path: `${pPath}.${field}`,
        version,
        code: "INVALID_PROVENANCE_FIELD",
        message: `Invalid compute provenance: ${field}`,
      });
    }
  }

  if (!Number.isSafeInteger(provenance.ledger) || provenance.ledger < 0) {
    diagnostics.push({
      path: `${pPath}.ledger`,
      version,
      code: "INVALID_PROVENANCE_LEDGER",
      message: "Invalid compute provenance: ledger/protocol/host_features",
    });
  }

  if (!Number.isSafeInteger(provenance.protocol) || provenance.protocol <= 0) {
    diagnostics.push({
      path: `${pPath}.protocol`,
      version,
      code: "INVALID_PROVENANCE_PROTOCOL",
      message: "Invalid compute provenance: ledger/protocol/host_features",
    });
  }

  if (
    !Array.isArray(provenance.host_features) ||
    !provenance.host_features.every(nonblank)
  ) {
    diagnostics.push({
      path: `${pPath}.host_features`,
      version,
      code: "INVALID_PROVENANCE_HOST_FEATURES",
      message: "Invalid compute provenance: ledger/protocol/host_features",
    });
  }

  if (
    !Array.isArray(provenance.seed) ||
    provenance.seed.length !== 32 ||
    !provenance.seed.every(
      (value: unknown) =>
        Number.isInteger(value) &&
        (value as number) >= 0 &&
        (value as number) <= 255,
    )
  ) {
    diagnostics.push({
      path: `${pPath}.seed`,
      version,
      code: "INVALID_PROVENANCE_SEED",
      message: "Invalid compute provenance: seed",
    });
  }

  if (
    provenance.resource_limits_sha256 !== undefined &&
    (typeof provenance.resource_limits_sha256 !== "string" ||
      !SHA256_HEX_PATTERN.test(provenance.resource_limits_sha256))
  ) {
    diagnostics.push({
      path: `${pPath}.resource_limits_sha256`,
      version,
      code: "INVALID_RESOURCE_LIMITS_DIGEST",
      message: "Schema 4 requires resource_limits_sha256",
    });
  }

  if (
    provenance.source_account !== undefined &&
    (typeof provenance.source_account !== "string" ||
      !ACCOUNT_PUBLIC_KEY_PATTERN.test(provenance.source_account))
  ) {
    diagnostics.push({
      path: `${pPath}.source_account`,
      version,
      code: "INVALID_SOURCE_ACCOUNT",
      message:
        "Invalid compute provenance: source_account must be an Ed25519 account public key",
    });
  }
}

/**
 * Inspect a single saved ContractBenchmark record and collect field-path diagnostics
 * without throwing. Usable standalone without RPC, deployment, or computing a diff.
 */
export function inspectMeasurementRecord(
  value: unknown,
  index?: number,
): SingleRecordValidationResult {
  const basePath = index === undefined ? "$" : `$[${index}]`;
  const diagnostics: RecordValidationDiagnostic[] = [];

  if (!isPlainObject(value)) {
    diagnostics.push({
      path: basePath,
      version: "unknown",
      code: "INVALID_RECORD_OBJECT",
      message: "Invalid measurement record: expected object",
    });
    return { valid: false, version: "unknown", diagnostics };
  }

  const version = detectRecordEnvelopeVersion(value);

  for (const key of Object.keys(value)) {
    if (!CONTRACT_ALLOWED_KEYS.has(key)) {
      diagnostics.push({
        path: `${basePath}.${key}`,
        version,
        code: "UNKNOWN_CONTRACT_FIELD",
        message: `Unexpected field in measurement record: ${key}`,
      });
    }
  }

  const hasLogical =
    value.schema_version !== undefined ||
    value.fixture_id !== undefined ||
    value.logical_id !== undefined;

  const benchmarksArray = Array.isArray(value.benchmarks)
    ? value.benchmarks
    : null;

  let contractKey: string | undefined;

  if (!hasLogical) {
    if (benchmarksArray) {
      benchmarksArray.forEach((fn: unknown, bIdx: number) => {
        if (isPlainObject(fn) && fn.case_id !== undefined) {
          diagnostics.push({
            path: `${basePath}.benchmarks[${bIdx}].case_id`,
            version: "legacy",
            code: "LEGACY_CASE_ID_FORBIDDEN",
            message:
              "Case identity requires fixture and logical contract identities",
          });
        }
      });
    }
    if (nonblank(value.contract_id)) {
      contractKey = JSON.stringify(["legacy", value.contract_id]);
    }
  } else {
    if (
      value.schema_version !== 2 &&
      value.schema_version !== 3 &&
      value.schema_version !== 4
    ) {
      diagnostics.push({
        path: `${basePath}.schema_version`,
        version: "unknown",
        code: "UNSUPPORTED_SCHEMA_VERSION",
        message:
          "Version 2/3/4 results require fixture_id, logical_id, and case_id for every benchmark",
      });
    }
    if (!nonblank(value.fixture_id)) {
      diagnostics.push({
        path: `${basePath}.fixture_id`,
        version,
        code: "MISSING_FIXTURE_ID",
        message:
          "Version 2/3/4 results require fixture_id, logical_id, and case_id for every benchmark",
      });
    }
    if (!nonblank(value.logical_id)) {
      diagnostics.push({
        path: `${basePath}.logical_id`,
        version,
        code: "MISSING_LOGICAL_ID",
        message:
          "Version 2/3/4 results require fixture_id, logical_id, and case_id for every benchmark",
      });
    }
    if (benchmarksArray) {
      benchmarksArray.forEach((fn: unknown, bIdx: number) => {
        if (!isPlainObject(fn) || !nonblank(fn.case_id)) {
          diagnostics.push({
            path: `${basePath}.benchmarks[${bIdx}].case_id`,
            version,
            code: "MISSING_CASE_ID",
            message:
              "Version 2/3/4 results require fixture_id, logical_id, and case_id for every benchmark",
          });
        }
      });
    }
    if (
      (version === 2 || version === 3 || version === 4) &&
      nonblank(value.fixture_id) &&
      nonblank(value.logical_id)
    ) {
      contractKey = JSON.stringify([
        "logical",
        value.fixture_id,
        value.logical_id,
      ]);
    }
  }

  if (!nonblank(value.contract_id)) {
    diagnostics.push({
      path: `${basePath}.contract_id`,
      version,
      code: "INVALID_CONTRACT_ID",
      message: "Contract contract_id must not be blank",
    });
  }

  if (!nonblank(value.git_commit)) {
    diagnostics.push({
      path: `${basePath}.git_commit`,
      version,
      code: "INVALID_GIT_COMMIT",
      message: "Contract git_commit must not be blank",
    });
  }

  if (!nonblank(value.soroban_sdk_version)) {
    diagnostics.push({
      path: `${basePath}.soroban_sdk_version`,
      version,
      code: "INVALID_SDK_VERSION",
      message: "Contract soroban_sdk_version must not be blank",
    });
  }

  if (!Number.isSafeInteger(value.timestamp) || value.timestamp < 0) {
    diagnostics.push({
      path: `${basePath}.timestamp`,
      version,
      code: "INVALID_TIMESTAMP",
      message: "Contract timestamp must be a non-negative safe integer",
    });
  }

  if (!benchmarksArray) {
    diagnostics.push({
      path: `${basePath}.benchmarks`,
      version,
      code: "INVALID_BENCHMARKS_ARRAY",
      message: "Contract benchmarks must be an array",
    });
    return { valid: false, version, diagnostics };
  }

  const seenBenchmarks = new Set<string>();

  benchmarksArray.forEach((benchmark: unknown, bIdx: number) => {
    const bPath = `${basePath}.benchmarks[${bIdx}]`;
    if (!isPlainObject(benchmark)) {
      diagnostics.push({
        path: bPath,
        version,
        code: "INVALID_BENCHMARK_OBJECT",
        message: "Invalid benchmark result: expected object",
      });
      return;
    }

    for (const key of Object.keys(benchmark)) {
      if (!BENCHMARK_ALLOWED_KEYS.has(key)) {
        diagnostics.push({
          path: `${bPath}.${key}`,
          version,
          code: "UNKNOWN_BENCHMARK_FIELD",
          message: `Unexpected field in benchmark record: ${key}`,
        });
      }
    }

    if (!nonblank(benchmark.function_name)) {
      diagnostics.push({
        path: `${bPath}.function_name`,
        version,
        code: "INVALID_FUNCTION_NAME",
        message: "Benchmark function_name must not be blank",
      });
    } else {
      const benchKey = JSON.stringify([
        benchmark.function_name,
        benchmark.case_id ?? null,
      ]);
      if (seenBenchmarks.has(benchKey)) {
        diagnostics.push({
          path: bPath,
          version,
          code: "DUPLICATE_BENCHMARK_IDENTITY",
          message: `Duplicate benchmark identity: ${benchKey}`,
        });
      } else {
        seenBenchmarks.add(benchKey);
      }
    }

    if (!nonblank(benchmark.wasm_sha256)) {
      diagnostics.push({
        path: `${bPath}.wasm_sha256`,
        version,
        code: "INVALID_WASM_SHA256",
        message: "Benchmark wasm_sha256 must not be blank",
      });
    }

    const metricsObj = benchmark.metrics;
    if (!isPlainObject(metricsObj)) {
      diagnostics.push({
        path: `${bPath}.metrics`,
        version,
        code: "INVALID_METRICS_OBJECT",
        message:
          "Missing metric cpu_instructions; use an explicit unavailable record",
      });
    } else {
      for (const extraKey of Object.keys(metricsObj)) {
        if (!METRIC_KEY_SET.has(extraKey)) {
          diagnostics.push({
            path: `${bPath}.metrics.${extraKey}`,
            version,
            code: "UNKNOWN_METRIC_KEY",
            message: `Unexpected metric key: ${extraKey}`,
          });
        }
      }

      for (const key of METRIC_KEYS) {
        const mPath = `${bPath}.metrics.${key}`;
        const metricVal = metricsObj[key];
        if (!isPlainObject(metricVal)) {
          diagnostics.push({
            path: mPath,
            version,
            code: "MISSING_METRIC",
            message: `Missing metric ${key}; use an explicit unavailable record`,
          });
          continue;
        }

        for (const fieldKey of Object.keys(metricVal)) {
          if (!METRIC_VALUE_ALLOWED_KEYS.has(fieldKey)) {
            diagnostics.push({
              path: `${mPath}.${fieldKey}`,
              version,
              code: "UNKNOWN_METRIC_FIELD",
              message: `Invalid metric field ${key}.${fieldKey}`,
            });
          }
        }

        if (
          metricVal.availability !== undefined &&
          metricVal.availability !== "measured" &&
          metricVal.availability !== "unavailable"
        ) {
          diagnostics.push({
            path: `${mPath}.availability`,
            version,
            code: "INVALID_METRIC_AVAILABILITY",
            message: `Invalid metric availability ${key}`,
          });
        }

        if (metricVal.availability === "unavailable") {
          if (metricVal.consumed !== null || !nonblank(metricVal.reason)) {
            diagnostics.push({
              path:
                metricVal.consumed !== null
                  ? `${mPath}.consumed`
                  : `${mPath}.reason`,
              version,
              code: "INVALID_UNAVAILABLE_METRIC",
              message: `Invalid unavailable metric ${key}`,
            });
          }
        } else if (
          metricVal.consumed === null ||
          !Number.isSafeInteger(metricVal.consumed) ||
          metricVal.consumed < 0
        ) {
          diagnostics.push({
            path: `${mPath}.consumed`,
            version,
            code: "INVALID_MEASURED_METRIC",
            message: `Invalid measured metric ${key}`,
          });
        }

        if (
          metricVal.limit !== null &&
          (!Number.isSafeInteger(metricVal.limit) || metricVal.limit < 0)
        ) {
          diagnostics.push({
            path: `${mPath}.limit`,
            version,
            code: "INVALID_METRIC_LIMIT",
            message: `Invalid metric limit ${key}`,
          });
        }
      }
    }

    if (version === 3 || version === 4) {
      if (!benchmark.provenance) {
        diagnostics.push({
          path: `${bPath}.provenance`,
          version,
          code: "MISSING_PROVENANCE",
          message: `Schema ${version} benchmarks require compute provenance`,
        });
      } else {
        validateProvenanceObject(
          benchmark.provenance,
          version,
          `${bPath}.provenance`,
          diagnostics,
        );
      }

      if (isPlainObject(metricsObj)) {
        for (const key of METRIC_KEYS) {
          const mPath = `${bPath}.metrics.${key}`;
          const metricVal = metricsObj[key];
          if (!isPlainObject(metricVal)) continue;

          if (
            metricVal.availability === undefined ||
            (metricVal.availability === "measured" &&
              !nonblank(metricVal.source))
          ) {
            diagnostics.push({
              path:
                metricVal.availability === undefined
                  ? `${mPath}.availability`
                  : `${mPath}.source`,
              version,
              code: "MISSING_METRIC_SOURCE_OR_AVAILABILITY",
              message: `Schema ${version} requires explicit availability and measured source for ${key}`,
            });
          }

          if (version === 4 && metricVal.availability === "measured") {
            if (
              metricVal.limit === null
                ? !nonblank(metricVal.limit_reason)
                : !nonblank(metricVal.limit_source)
            ) {
              diagnostics.push({
                path:
                  metricVal.limit === null
                    ? `${mPath}.limit_reason`
                    : `${mPath}.limit_source`,
                version,
                code: "MISSING_METRIC_LIMIT_PROVENANCE",
                message: `Schema 4 requires explicit limit provenance for ${key}`,
              });
            }
          }
        }
      }

      if (
        version === 4 &&
        isPlainObject(benchmark.provenance) &&
        !SHA256_HEX_PATTERN.test(
          benchmark.provenance.resource_limits_sha256 ?? "",
        )
      ) {
        const alreadyReported = diagnostics.some(
          (d) => d.path === `${bPath}.provenance.resource_limits_sha256`,
        );
        if (!alreadyReported) {
          diagnostics.push({
            path: `${bPath}.provenance.resource_limits_sha256`,
            version,
            code: "MISSING_RESOURCE_LIMITS_DIGEST",
            message: "Schema 4 requires resource_limits_sha256",
          });
        }
      }
    } else if (benchmark.provenance !== undefined) {
      validateProvenanceObject(
        benchmark.provenance,
        version,
        `${bPath}.provenance`,
        diagnostics,
      );
    }
  });

  if (diagnostics.length > 0) {
    return { valid: false, version, diagnostics };
  }

  return {
    valid: true,
    version,
    contractKey,
    record: value as unknown as ContractBenchmark,
    diagnostics: [],
  };
}

/**
 * Validate a single saved ContractBenchmark record or throw a
 * MeasurementRecordValidationError with field-path diagnostics.
 */
export function validateMeasurementRecord(
  value: unknown,
  index?: number,
): ContractBenchmark {
  const result = inspectMeasurementRecord(value, index);
  if (!result.valid || !result.record) {
    throw new MeasurementRecordValidationError(result.diagnostics);
  }
  return result.record;
}

/**
 * Inspect an array of saved ContractBenchmark records without throwing.
 * Enforces both per-record versioned constraints and collection-level invariants
 * (unique contract identity and uniform envelope version).
 */
export function inspectMeasurementRecords(
  value: unknown,
): RecordValidationResult {
  if (!Array.isArray(value)) {
    return {
      valid: false,
      version: "unknown",
      diagnostics: [
        {
          path: "$",
          version: "unknown",
          code: "INVALID_RECORDS_ARRAY",
          message: "Invalid measurement records: expected array",
        },
      ],
    };
  }

  const diagnostics: RecordValidationDiagnostic[] = [];
  const seenContractKeys = new Set<string>();
  const records: ContractBenchmark[] = [];
  let detectedVersion: MeasurementEnvelopeVersion | "unknown" | null = null;

  value.forEach((item: unknown, index: number) => {
    const single = inspectMeasurementRecord(item, index);
    if (detectedVersion === null) {
      detectedVersion = single.version;
    } else if (
      single.version !== "unknown" &&
      detectedVersion !== "unknown" &&
      single.version !== detectedVersion
    ) {
      diagnostics.push({
        path: `$[${index}].schema_version`,
        version: single.version,
        code: "MIXED_SCHEMA_VERSIONS",
        message: "Cannot compare measurements with different schema versions",
      });
    }

    if (single.contractKey !== undefined) {
      if (seenContractKeys.has(single.contractKey)) {
        diagnostics.push({
          path: `$[${index}]`,
          version: single.version,
          code: "DUPLICATE_CONTRACT_IDENTITY",
          message: `Duplicate logical contract identity: ${single.contractKey}`,
        });
      } else {
        seenContractKeys.add(single.contractKey);
      }
    }

    if (single.diagnostics.length > 0) {
      diagnostics.push(...single.diagnostics);
    } else if (single.record) {
      records.push(single.record);
    }
  });

  if (diagnostics.length > 0) {
    return {
      valid: false,
      version: detectedVersion,
      diagnostics,
    };
  }

  return {
    valid: true,
    version: detectedVersion,
    records,
    diagnostics: [],
  };
}

/**
 * Validate an array of saved ContractBenchmark records or throw a
 * MeasurementRecordValidationError with field-path diagnostics.
 */
export function validateMeasurementRecords(
  value: unknown,
): ContractBenchmark[] {
  const result = inspectMeasurementRecords(value);
  if (!result.valid || !result.records) {
    throw new MeasurementRecordValidationError(result.diagnostics);
  }
  return result.records;
}

/**
 * Resolve the canonical contract comparison key for a validated ContractBenchmark.
 */
export function resolveContractIdentityKey(
  contract: ContractBenchmark,
  index?: number,
): string {
  const result = inspectMeasurementRecord(contract, index);
  if (!result.valid || !result.contractKey) {
    throw new MeasurementRecordValidationError(result.diagnostics);
  }
  return result.contractKey;
}

/**
 * Validate that two benchmark results from matched BASE and HEAD contracts
 * have compatible measurement environments and metric semantics.
 */
export function validateBenchmarkComparisonCompatibility(
  baseFn: BenchmarkResult,
  headFn: BenchmarkResult,
): void {
  if (!baseFn.provenance && !headFn.provenance) {
    return;
  }
  const fields = [
    "source",
    "source_version",
    "protocol",
    "helper_sha256",
    "network_id",
    "compute_config_sha256",
    "seed",
    "auth_mode",
    "host_features",
    // The invoking account is part of the measured environment: results
    // measured under different source accounts are not comparable.
    "source_account",
  ] as const;
  for (const field of fields) {
    if (
      !baseFn.provenance ||
      !headFn.provenance ||
      JSON.stringify(baseFn.provenance[field]) !==
        JSON.stringify(headFn.provenance[field])
    ) {
      throw new Error(`Incompatible measurement environment: ${field}`);
    }
  }
  if (
    JSON.stringify(baseFn.provenance?.resource_limits_sha256) !==
    JSON.stringify(headFn.provenance?.resource_limits_sha256)
  ) {
    throw new Error(
      "Incompatible measurement environment: resource_limits_sha256",
    );
  }
  if (headFn.provenance?.resource_limits_sha256) {
    for (const metric of METRIC_KEYS) {
      for (const field of [
        "availability",
        "source",
        "limit",
        "limit_source",
        "limit_reason",
      ] as const) {
        if (baseFn.metrics[metric][field] !== headFn.metrics[metric][field]) {
          throw new Error(`Incompatible metric semantics: ${metric}.${field}`);
        }
      }
    }
  }
}

/**
 * Build the authoritative machine-readable JSON Schema (Draft 2020-12) for
 * saved WeighIn measurement record sets, with explicit version discriminators
 * for legacy, schema_version 2, schema_version 3, and schema_version 4 envelopes.
 */
export function getMeasurementRecordJsonSchema(): Record<string, any> {
  const metricsProperties = (metricRef: string) =>
    Object.fromEntries(METRIC_KEYS.map((key) => [key, { $ref: metricRef }]));

  const provenanceBaseProperties = {
    source: { $ref: "#/$defs/NonBlankString" },
    source_version: { $ref: "#/$defs/NonBlankString" },
    protocol: { $ref: "#/$defs/SafePositiveInteger" },
    helper_sha256: { $ref: "#/$defs/NonBlankString" },
    network_id: { $ref: "#/$defs/NonBlankString" },
    ledger: { $ref: "#/$defs/SafeNonNegativeInteger" },
    header_sha256: { $ref: "#/$defs/NonBlankString" },
    snapshot_sha256: { $ref: "#/$defs/NonBlankString" },
    config_sha256: { $ref: "#/$defs/NonBlankString" },
    compute_config_sha256: { $ref: "#/$defs/NonBlankString" },
    input_sha256: { $ref: "#/$defs/NonBlankString" },
    seed: { $ref: "#/$defs/SeedArray" },
    auth_mode: { $ref: "#/$defs/NonBlankString" },
    host_features: {
      type: "array",
      items: { $ref: "#/$defs/NonBlankString" },
    },
    resource_limits_sha256: { $ref: "#/$defs/Sha256Hex" },
    source_account: { $ref: "#/$defs/AccountPublicKey" },
  };

  const provenanceSchema3Required = [
    "source",
    "source_version",
    "protocol",
    "helper_sha256",
    "network_id",
    "ledger",
    "header_sha256",
    "snapshot_sha256",
    "config_sha256",
    "compute_config_sha256",
    "input_sha256",
    "seed",
    "auth_mode",
    "host_features",
  ];

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://weighin.dev/schemas/measurement-records.schema.json",
    title: "WeighIn Saved Measurement Records",
    description:
      "Authoritative versioned schema for WeighIn saved measurement record arrays across legacy unversioned, schema_version 2, schema_version 3, and schema_version 4 envelopes.",
    type: "array",
    items: {
      $ref: "#/$defs/ContractBenchmark",
    },
    "x-weighin-current-version": CURRENT_RECORD_SCHEMA_VERSION,
    "x-weighin-supported-versions": [...SUPPORTED_MEASUREMENT_ENVELOPES],
    "x-weighin-runtime-invariants": RUNTIME_RECORD_INVARIANTS.map((item) => ({
      ...item,
    })),
    $defs: {
      NonBlankString: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
      },
      SafeNonNegativeInteger: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      SafePositiveInteger: {
        type: "integer",
        minimum: 1,
        maximum: 9007199254740991,
      },
      NullableSafeNonNegativeInteger: {
        oneOf: [{ $ref: "#/$defs/SafeNonNegativeInteger" }, { type: "null" }],
      },
      Sha256Hex: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      AccountPublicKey: {
        type: "string",
        pattern: "^G[A-Z2-7]{55}$",
      },
      SeedByte: {
        type: "integer",
        minimum: 0,
        maximum: 255,
      },
      SeedArray: {
        type: "array",
        items: { $ref: "#/$defs/SeedByte" },
        minItems: 32,
        maxItems: 32,
      },
      LegacyOrSchema2MetricValue: {
        oneOf: [
          {
            title: "MeasuredMetricValue",
            type: "object",
            additionalProperties: false,
            required: ["consumed", "limit"],
            properties: {
              availability: { const: "measured" },
              consumed: { $ref: "#/$defs/SafeNonNegativeInteger" },
              limit: { $ref: "#/$defs/NullableSafeNonNegativeInteger" },
              reason: { $ref: "#/$defs/NonBlankString" },
              source: { $ref: "#/$defs/NonBlankString" },
              limit_source: { $ref: "#/$defs/NonBlankString" },
              limit_reason: { $ref: "#/$defs/NonBlankString" },
            },
          },
          {
            title: "UnavailableMetricValue",
            type: "object",
            additionalProperties: false,
            required: ["availability", "consumed", "limit", "reason"],
            properties: {
              availability: { const: "unavailable" },
              consumed: { type: "null" },
              limit: { $ref: "#/$defs/NullableSafeNonNegativeInteger" },
              reason: { $ref: "#/$defs/NonBlankString" },
              source: { $ref: "#/$defs/NonBlankString" },
              limit_source: { $ref: "#/$defs/NonBlankString" },
              limit_reason: { $ref: "#/$defs/NonBlankString" },
            },
          },
        ],
      },
      Schema3MetricValue: {
        oneOf: [
          {
            title: "Schema3MeasuredMetricValue",
            type: "object",
            additionalProperties: false,
            required: ["availability", "consumed", "limit", "source"],
            properties: {
              availability: { const: "measured" },
              consumed: { $ref: "#/$defs/SafeNonNegativeInteger" },
              limit: { $ref: "#/$defs/NullableSafeNonNegativeInteger" },
              source: { $ref: "#/$defs/NonBlankString" },
              reason: { $ref: "#/$defs/NonBlankString" },
              limit_source: { $ref: "#/$defs/NonBlankString" },
              limit_reason: { $ref: "#/$defs/NonBlankString" },
            },
          },
          {
            title: "Schema3UnavailableMetricValue",
            type: "object",
            additionalProperties: false,
            required: ["availability", "consumed", "limit", "reason"],
            properties: {
              availability: { const: "unavailable" },
              consumed: { type: "null" },
              limit: { $ref: "#/$defs/NullableSafeNonNegativeInteger" },
              reason: { $ref: "#/$defs/NonBlankString" },
              source: { $ref: "#/$defs/NonBlankString" },
              limit_source: { $ref: "#/$defs/NonBlankString" },
              limit_reason: { $ref: "#/$defs/NonBlankString" },
            },
          },
        ],
      },
      Schema4MetricValue: {
        oneOf: [
          {
            title: "Schema4MeasuredBoundedMetricValue",
            type: "object",
            additionalProperties: false,
            required: [
              "availability",
              "consumed",
              "limit",
              "source",
              "limit_source",
            ],
            properties: {
              availability: { const: "measured" },
              consumed: { $ref: "#/$defs/SafeNonNegativeInteger" },
              limit: { $ref: "#/$defs/SafeNonNegativeInteger" },
              source: { $ref: "#/$defs/NonBlankString" },
              limit_source: { $ref: "#/$defs/NonBlankString" },
              limit_reason: { $ref: "#/$defs/NonBlankString" },
              reason: { $ref: "#/$defs/NonBlankString" },
            },
          },
          {
            title: "Schema4MeasuredUnboundedMetricValue",
            type: "object",
            additionalProperties: false,
            required: [
              "availability",
              "consumed",
              "limit",
              "source",
              "limit_reason",
            ],
            properties: {
              availability: { const: "measured" },
              consumed: { $ref: "#/$defs/SafeNonNegativeInteger" },
              limit: { type: "null" },
              source: { $ref: "#/$defs/NonBlankString" },
              limit_reason: { $ref: "#/$defs/NonBlankString" },
              limit_source: { $ref: "#/$defs/NonBlankString" },
              reason: { $ref: "#/$defs/NonBlankString" },
            },
          },
          {
            title: "Schema4UnavailableMetricValue",
            type: "object",
            additionalProperties: false,
            required: ["availability", "consumed", "limit", "reason"],
            properties: {
              availability: { const: "unavailable" },
              consumed: { type: "null" },
              limit: { $ref: "#/$defs/NullableSafeNonNegativeInteger" },
              reason: { $ref: "#/$defs/NonBlankString" },
              source: { $ref: "#/$defs/NonBlankString" },
              limit_source: { $ref: "#/$defs/NonBlankString" },
              limit_reason: { $ref: "#/$defs/NonBlankString" },
            },
          },
        ],
      },
      LegacyOrSchema2Metrics: {
        type: "object",
        additionalProperties: false,
        required: [...METRIC_KEYS],
        properties: metricsProperties("#/$defs/LegacyOrSchema2MetricValue"),
      },
      Schema3Metrics: {
        type: "object",
        additionalProperties: false,
        required: [...METRIC_KEYS],
        properties: metricsProperties("#/$defs/Schema3MetricValue"),
      },
      Schema4Metrics: {
        type: "object",
        additionalProperties: false,
        required: [...METRIC_KEYS],
        properties: metricsProperties("#/$defs/Schema4MetricValue"),
      },
      Schema3ComputeProvenance: {
        type: "object",
        additionalProperties: false,
        required: provenanceSchema3Required,
        properties: provenanceBaseProperties,
      },
      Schema4ComputeProvenance: {
        type: "object",
        additionalProperties: false,
        required: [...provenanceSchema3Required, "resource_limits_sha256"],
        properties: provenanceBaseProperties,
      },
      LegacyBenchmarkResult: {
        type: "object",
        additionalProperties: false,
        required: ["function_name", "metrics", "wasm_sha256"],
        properties: {
          function_name: { $ref: "#/$defs/NonBlankString" },
          metrics: { $ref: "#/$defs/LegacyOrSchema2Metrics" },
          wasm_sha256: { $ref: "#/$defs/NonBlankString" },
          provenance: { $ref: "#/$defs/Schema3ComputeProvenance" },
        },
      },
      Schema2BenchmarkResult: {
        type: "object",
        additionalProperties: false,
        required: ["function_name", "case_id", "metrics", "wasm_sha256"],
        properties: {
          function_name: { $ref: "#/$defs/NonBlankString" },
          case_id: { $ref: "#/$defs/NonBlankString" },
          metrics: { $ref: "#/$defs/LegacyOrSchema2Metrics" },
          wasm_sha256: { $ref: "#/$defs/NonBlankString" },
          provenance: { $ref: "#/$defs/Schema3ComputeProvenance" },
        },
      },
      Schema3BenchmarkResult: {
        type: "object",
        additionalProperties: false,
        required: [
          "function_name",
          "case_id",
          "metrics",
          "wasm_sha256",
          "provenance",
        ],
        properties: {
          function_name: { $ref: "#/$defs/NonBlankString" },
          case_id: { $ref: "#/$defs/NonBlankString" },
          metrics: { $ref: "#/$defs/Schema3Metrics" },
          wasm_sha256: { $ref: "#/$defs/NonBlankString" },
          provenance: { $ref: "#/$defs/Schema3ComputeProvenance" },
        },
      },
      Schema4BenchmarkResult: {
        type: "object",
        additionalProperties: false,
        required: [
          "function_name",
          "case_id",
          "metrics",
          "wasm_sha256",
          "provenance",
        ],
        properties: {
          function_name: { $ref: "#/$defs/NonBlankString" },
          case_id: { $ref: "#/$defs/NonBlankString" },
          metrics: { $ref: "#/$defs/Schema4Metrics" },
          wasm_sha256: { $ref: "#/$defs/NonBlankString" },
          provenance: { $ref: "#/$defs/Schema4ComputeProvenance" },
        },
      },
      LegacyContractBenchmark: {
        title: "LegacyContractBenchmark",
        "x-weighin-envelope-version": "legacy",
        type: "object",
        additionalProperties: false,
        required: [
          "contract_id",
          "git_commit",
          "soroban_sdk_version",
          "timestamp",
          "benchmarks",
        ],
        properties: {
          contract_id: { $ref: "#/$defs/NonBlankString" },
          git_commit: { $ref: "#/$defs/NonBlankString" },
          soroban_sdk_version: { $ref: "#/$defs/NonBlankString" },
          timestamp: { $ref: "#/$defs/SafeNonNegativeInteger" },
          benchmarks: {
            type: "array",
            items: { $ref: "#/$defs/LegacyBenchmarkResult" },
          },
        },
      },
      Schema2ContractBenchmark: {
        title: "Schema2ContractBenchmark",
        "x-weighin-envelope-version": 2,
        type: "object",
        additionalProperties: false,
        required: [
          "schema_version",
          "fixture_id",
          "logical_id",
          "contract_id",
          "git_commit",
          "soroban_sdk_version",
          "timestamp",
          "benchmarks",
        ],
        properties: {
          schema_version: { const: 2 },
          fixture_id: { $ref: "#/$defs/NonBlankString" },
          logical_id: { $ref: "#/$defs/NonBlankString" },
          contract_id: { $ref: "#/$defs/NonBlankString" },
          git_commit: { $ref: "#/$defs/NonBlankString" },
          soroban_sdk_version: { $ref: "#/$defs/NonBlankString" },
          timestamp: { $ref: "#/$defs/SafeNonNegativeInteger" },
          benchmarks: {
            type: "array",
            items: { $ref: "#/$defs/Schema2BenchmarkResult" },
          },
        },
      },
      Schema3ContractBenchmark: {
        title: "Schema3ContractBenchmark",
        "x-weighin-envelope-version": 3,
        type: "object",
        additionalProperties: false,
        required: [
          "schema_version",
          "fixture_id",
          "logical_id",
          "contract_id",
          "git_commit",
          "soroban_sdk_version",
          "timestamp",
          "benchmarks",
        ],
        properties: {
          schema_version: { const: 3 },
          fixture_id: { $ref: "#/$defs/NonBlankString" },
          logical_id: { $ref: "#/$defs/NonBlankString" },
          contract_id: { $ref: "#/$defs/NonBlankString" },
          git_commit: { $ref: "#/$defs/NonBlankString" },
          soroban_sdk_version: { $ref: "#/$defs/NonBlankString" },
          timestamp: { $ref: "#/$defs/SafeNonNegativeInteger" },
          benchmarks: {
            type: "array",
            items: { $ref: "#/$defs/Schema3BenchmarkResult" },
          },
        },
      },
      Schema4ContractBenchmark: {
        title: "Schema4ContractBenchmark",
        "x-weighin-envelope-version": 4,
        type: "object",
        additionalProperties: false,
        required: [
          "schema_version",
          "fixture_id",
          "logical_id",
          "contract_id",
          "git_commit",
          "soroban_sdk_version",
          "timestamp",
          "benchmarks",
        ],
        properties: {
          schema_version: { const: 4 },
          fixture_id: { $ref: "#/$defs/NonBlankString" },
          logical_id: { $ref: "#/$defs/NonBlankString" },
          contract_id: { $ref: "#/$defs/NonBlankString" },
          git_commit: { $ref: "#/$defs/NonBlankString" },
          soroban_sdk_version: { $ref: "#/$defs/NonBlankString" },
          timestamp: { $ref: "#/$defs/SafeNonNegativeInteger" },
          benchmarks: {
            type: "array",
            items: { $ref: "#/$defs/Schema4BenchmarkResult" },
          },
        },
      },
      ContractBenchmark: {
        description:
          "Discriminated union of supported WeighIn saved contract measurement envelopes.",
        oneOf: [
          { $ref: "#/$defs/LegacyContractBenchmark" },
          { $ref: "#/$defs/Schema2ContractBenchmark" },
          { $ref: "#/$defs/Schema3ContractBenchmark" },
          { $ref: "#/$defs/Schema4ContractBenchmark" },
        ],
      },
    },
  };
}
