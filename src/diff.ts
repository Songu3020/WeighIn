import { ComputeProvenance } from "./simulation";
import {
  ContractBenchmark,
  BenchmarkResult,
  Metrics,
  MetricValue,
} from "./measurement";
import {
  METRIC_KEYS,
  MetricKey,
  CURRENT_RECORD_SCHEMA_VERSION,
  SUPPORTED_RECORD_SCHEMA_VERSIONS,
  SUPPORTED_MEASUREMENT_ENVELOPES,
  RUNTIME_RECORD_INVARIANTS,
  MeasurementRecordValidationError,
  detectRecordEnvelopeVersion,
  inspectMeasurementRecord,
  validateMeasurementRecord,
  inspectMeasurementRecords,
  validateMeasurementRecords,
  resolveContractIdentityKey,
  validateBenchmarkComparisonCompatibility,
  getMeasurementRecordJsonSchema,
  RecordSchemaVersion,
  MeasurementEnvelopeVersion,
  RecordValidationDiagnostic,
  SingleRecordValidationResult,
  RecordValidationResult,
} from "./record-schema";

export {
  METRIC_KEYS,
  MetricKey,
  CURRENT_RECORD_SCHEMA_VERSION,
  SUPPORTED_RECORD_SCHEMA_VERSIONS,
  SUPPORTED_MEASUREMENT_ENVELOPES,
  RUNTIME_RECORD_INVARIANTS,
  MeasurementRecordValidationError,
  detectRecordEnvelopeVersion,
  inspectMeasurementRecord,
  validateMeasurementRecord,
  inspectMeasurementRecords,
  validateMeasurementRecords,
  resolveContractIdentityKey,
  validateBenchmarkComparisonCompatibility,
  getMeasurementRecordJsonSchema,
  RecordSchemaVersion,
  MeasurementEnvelopeVersion,
  RecordValidationDiagnostic,
  SingleRecordValidationResult,
  RecordValidationResult,
};

export interface MetricDiff {
  key: MetricKey;
  base: MetricValue;
  head: MetricValue;
  /** Absolute change: head.consumed - base.consumed */
  delta: number | null;
  availability: "comparable" | "unavailable";
  reason?: string;
  /** Percentage change relative to base.consumed, or null when base.consumed === 0 */
  pct: number | null;
  /** True if head.consumed > base.consumed */
  regression: boolean;
}

export interface BenchmarkIdentity {
  function_name: string;
  case_id?: string;
}

export interface FunctionDiff extends BenchmarkIdentity {
  metrics: MetricDiff[];
  base_provenance?: ComputeProvenance;
  head_provenance?: ComputeProvenance;
  /** True if any metric regressed */
  hasRegression: boolean;
}

export interface ContractDiff {
  fixture_id?: string;
  logical_id?: string;
  /** Compatibility alias for head_contract_id. */
  contract_id: string;
  base_contract_id: string;
  head_contract_id: string;
  base_commit: string;
  head_commit: string;
  functions: FunctionDiff[];
  /** True if any function in this contract has a regression */
  hasRegression: boolean;
  /** Functions present in head but missing from base (new functions) */
  newFunctions: string[];
  /** Functions present in base but missing from head (removed functions) */
  removedFunctions: string[];
  /** Includes case additions/removals within an existing function. */
  newBenchmarks: BenchmarkIdentity[];
  removedBenchmarks: BenchmarkIdentity[];
}

export interface DiffResult {
  contracts: ContractDiff[];
  /** True if any contract has a regression */
  hasRegression: boolean;
  /** Contracts present in head but not base */
  newContracts: string[];
  /** Contracts present in base but not head */
  removedContracts: string[];
}

function diffMetrics(base: Metrics, head: Metrics): MetricDiff[] {
  return METRIC_KEYS.map((key) => {
    const b = base[key];
    const h = head[key];
    if (b.consumed === null || h.consumed === null) {
      return {
        key,
        base: b,
        head: h,
        availability: "unavailable" as const,
        reason: [
          b.reason && `BASE: ${b.reason}`,
          h.reason && `HEAD: ${h.reason}`,
        ]
          .filter(Boolean)
          .join("; "),
        delta: null,
        pct: null,
        regression: false,
      };
    }
    const delta = h.consumed - b.consumed;
    const pct = b.consumed === 0 ? null : (delta / b.consumed) * 100;
    return {
      key,
      base: b,
      head: h,
      availability: "comparable" as const,
      delta,
      pct,
      regression: delta > 0,
    };
  });
}

function diffFunctions(
  baseFns: BenchmarkResult[],
  headFns: BenchmarkResult[],
): Pick<
  ContractDiff,
  | "functions"
  | "newFunctions"
  | "removedFunctions"
  | "newBenchmarks"
  | "removedBenchmarks"
> {
  const baseMap = benchmarkMap(baseFns);
  const headMap = benchmarkMap(headFns);

  const baseNames = new Set(baseFns.map((fn) => fn.function_name));
  const headNames = new Set(headFns.map((fn) => fn.function_name));
  const newFunctions = [...headNames].filter((name) => !baseNames.has(name));
  const removedFunctions = [...baseNames].filter(
    (name) => !headNames.has(name),
  );
  const newBenchmarks: BenchmarkIdentity[] = [];
  const removedBenchmarks: BenchmarkIdentity[] = [];
  const functions: FunctionDiff[] = [];

  for (const [key, fn] of headMap) {
    if (!baseMap.has(key)) newBenchmarks.push(benchmarkIdentity(fn));
  }
  for (const [key, fn] of baseMap) {
    if (!headMap.has(key)) removedBenchmarks.push(benchmarkIdentity(fn));
  }

  for (const [key, headFn] of headMap) {
    const baseFn = baseMap.get(key);
    if (!baseFn) continue;

    validateBenchmarkComparisonCompatibility(baseFn, headFn);
    const metrics = diffMetrics(baseFn.metrics, headFn.metrics);
    const hasRegression = metrics.some((m) => m.regression);
    functions.push({
      ...benchmarkIdentity(headFn),
      metrics,
      hasRegression,
      base_provenance: baseFn.provenance,
      head_provenance: headFn.provenance,
    });
  }

  return {
    functions,
    newFunctions,
    removedFunctions,
    newBenchmarks,
    removedBenchmarks,
  };
}

function benchmarkIdentity(fn: BenchmarkResult): BenchmarkIdentity {
  return {
    function_name: fn.function_name,
    ...(fn.case_id === undefined ? {} : { case_id: fn.case_id }),
  };
}

function benchmarkMap(
  functions: BenchmarkResult[],
): Map<string, BenchmarkResult> {
  const result = new Map<string, BenchmarkResult>();
  for (const fn of functions) {
    const key = JSON.stringify([fn.function_name, fn.case_id ?? null]);
    result.set(key, fn);
  }
  return result;
}

function contractMap(
  contracts: ContractBenchmark[],
): Map<string, ContractBenchmark> {
  const validated = validateMeasurementRecords(contracts);
  const result = new Map<string, ContractBenchmark>();
  validated.forEach((contract, index) => {
    const key = resolveContractIdentityKey(contract, index);
    result.set(key, contract);
  });
  return result;
}

export function contractLabel(
  contract: Pick<
    ContractBenchmark,
    "fixture_id" | "logical_id" | "contract_id"
  >,
): string {
  return contract.logical_id === undefined
    ? contract.contract_id
    : `${contract.fixture_id} / ${contract.logical_id}`;
}

/**
 * Compute a structural diff between a base and head measurement run.
 *
 * Versions 2–5 contracts match by (fixture_id, logical_id), and invocations by
 * (function_name, case_id). Runtime addresses and WASM hashes may differ.
 * Legacy results only match other legacy results by runtime address/function;
 * mixed schemas never guess a match. Additions/removals are not regressions.
 */
export function diffBenchmarks(
  base: ContractBenchmark[],
  head: ContractBenchmark[],
): DiffResult {
  const baseMap = contractMap(base);
  const headMap = contractMap(head);

  if (
    base.length > 0 &&
    head.length > 0 &&
    base[0].schema_version !== undefined &&
    head[0].schema_version !== undefined &&
    base[0].schema_version !== head[0].schema_version
  ) {
    throw new Error(
      "Cannot compare measurements with different schema versions",
    );
  }

  const newContracts: string[] = [];
  const removedContracts: string[] = [];
  const contracts: ContractDiff[] = [];

  for (const [key, contract] of headMap) {
    if (!baseMap.has(key)) newContracts.push(contractLabel(contract));
  }
  for (const [key, contract] of baseMap) {
    if (!headMap.has(key)) removedContracts.push(contractLabel(contract));
  }

  for (const [key, headContract] of headMap) {
    const baseContract = baseMap.get(key);
    if (!baseContract) continue;

    if (baseContract.schema_version !== headContract.schema_version)
      throw new Error(
        "Cannot compare measurements with different schema versions",
      );
    const benchmarkDiff = diffFunctions(
      baseContract.benchmarks,
      headContract.benchmarks,
    );
    const hasRegression = benchmarkDiff.functions.some((f) => f.hasRegression);

    contracts.push({
      fixture_id: headContract.fixture_id,
      logical_id: headContract.logical_id,
      contract_id: headContract.contract_id,
      base_contract_id: baseContract.contract_id,
      head_contract_id: headContract.contract_id,
      base_commit: baseContract.git_commit,
      head_commit: headContract.git_commit,
      ...benchmarkDiff,
      hasRegression,
    });
  }

  return {
    contracts,
    hasRegression: contracts.some((c) => c.hasRegression),
    newContracts,
    removedContracts,
  };
}
