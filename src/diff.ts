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

export interface BenchmarkSelector {
  fixture_id?: string;
  logical_id?: string;
  function_name: string;
  case_id?: string;
}

export interface AggregateMemberBreakdown {
  fixture_id?: string;
  logical_id?: string;
  contract_id: string;
  function_name: string;
  case_id?: string;
  base_consumed: number | null;
  head_consumed: number | null;
  delta: number | null;
}

export interface AggregateMetricDiff {
  key: MetricKey;
  base_consumed: number | null;
  head_consumed: number | null;
  delta: number | null;
  pct: number | null;
  regression: boolean;
  availability: "comparable" | "unavailable";
  reason?: string;
  description: string;
}

export interface AggregateProvenance {
  schema_version?: number;
  source: string;
  protocol_version: number;
  network_passphrase: string;
  compute_config_sha256?: string;
  calibration?: string;
}

export interface AggregateDiff {
  name: string;
  description?: string;
  members: BenchmarkSelector[];
  member_count: number;
  breakdown: Record<MetricKey, AggregateMemberBreakdown[]>;
  metrics: AggregateMetricDiff[];
  provenance?: AggregateProvenance;
  hasRegression: boolean;
}

export interface AggregateBudgetConfig {
  description?: string;
  members: BenchmarkSelector[];
  limits?: Partial<Record<MetricKey, number>>;
  thresholds?: Partial<Record<MetricKey, any>>;
}

export const AGGREGATE_METRIC_DESCRIPTIONS: Record<MetricKey, string> = {
  cpu_instructions: "Cumulative CPU Instructions",
  memory_bytes:
    "Cumulative Invocation Memory Bytes (sum of invocation costs, not peak concurrent memory)",
  ledger_read_entries: "Cumulative Footprint Read Entries (RO + RW)",
  ledger_read_bytes: "Cumulative Disk Read Bytes",
  ledger_write_entries: "Cumulative Write Footprint Entries",
  ledger_write_bytes: "Cumulative Ledger Write Bytes",
  historical_data_read_bytes: "Cumulative Historical Read Bytes",
  contract_data_hard_limit: "Cumulative Contract Data (instance)",
  tx_size_bytes: "Cumulative Tx Size Bytes",
  events_count: "Cumulative Successful Contract/System Events",
  event_data_bytes: "Cumulative Events + Return XDR Bytes",
};

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
  aggregates?: AggregateDiff[];
  /** True if any contract or aggregate has a regression */
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

export function matchesSelector(
  selector: BenchmarkSelector,
  candidate: {
    fixture_id?: string;
    logical_id?: string;
    function_name: string;
    case_id?: string;
  },
): boolean {
  if (selector.function_name !== candidate.function_name) return false;
  if (
    selector.fixture_id !== undefined &&
    selector.fixture_id !== candidate.fixture_id
  )
    return false;
  if (
    selector.logical_id !== undefined &&
    selector.logical_id !== candidate.logical_id
  )
    return false;
  if (selector.case_id !== undefined && selector.case_id !== candidate.case_id)
    return false;
  return true;
}

export function formatSelector(sel: BenchmarkSelector): string {
  const parts: string[] = [];
  if (sel.fixture_id) parts.push(`fixture:${sel.fixture_id}`);
  if (sel.logical_id) parts.push(`contract:${sel.logical_id}`);
  parts.push(`fn:${sel.function_name}`);
  if (sel.case_id) parts.push(`case:${sel.case_id}`);
  return parts.join(" / ");
}

export function computeAggregateDiffs(
  diff: DiffResult,
  config?: {
    aggregates?: Record<string, AggregateBudgetConfig>;
    limits?: {
      aggregates?: Record<string, Partial<Record<MetricKey, number>>>;
    };
    thresholds?: {
      aggregates?: Record<string, Partial<Record<MetricKey, any>>>;
    };
  } | null,
): AggregateDiff[] {
  if (!config) return [];

  const aggregateNames = new Set<string>();
  if (config.aggregates) {
    for (const name of Object.keys(config.aggregates)) aggregateNames.add(name);
  }
  if (config.limits?.aggregates) {
    for (const name of Object.keys(config.limits.aggregates))
      aggregateNames.add(name);
  }
  if (config.thresholds?.aggregates) {
    for (const name of Object.keys(config.thresholds.aggregates))
      aggregateNames.add(name);
  }

  if (aggregateNames.size === 0) return [];

  const aggregateDiffs: AggregateDiff[] = [];

  for (const name of aggregateNames) {
    const aggDef = config.aggregates?.[name];
    if (
      !aggDef ||
      !aggDef.members ||
      !Array.isArray(aggDef.members) ||
      aggDef.members.length === 0
    ) {
      throw new Error(
        `Cannot evaluate aggregate budget "${name}": missing required member selectors in [aggregates.${name}]`,
      );
    }

    // 1. Check for duplicate selectors declared in members
    const seenSelectors = new Set<string>();
    for (const member of aggDef.members) {
      if (!member.function_name) {
        throw new Error(
          `Cannot evaluate aggregate budget "${name}": member selector missing required function_name`,
        );
      }
      const selKey = JSON.stringify([
        member.fixture_id ?? "",
        member.logical_id ?? "",
        member.function_name,
        member.case_id ?? "",
      ]);
      if (seenSelectors.has(selKey)) {
        throw new Error(
          `Cannot evaluate aggregate budget "${name}": duplicate member selector ${formatSelector(member)}`,
        );
      }
      seenSelectors.add(selKey);
    }

    // 2. Resolve members against diff.contracts
    interface MatchedMember {
      selector: BenchmarkSelector;
      contract: ContractDiff;
      fn: FunctionDiff;
      canonicalKey: string;
    }

    const resolvedMembers: MatchedMember[] = [];
    const matchedCanonicalKeys = new Set<string>();

    for (const member of aggDef.members) {
      const matches: Array<{ contract: ContractDiff; fn: FunctionDiff }> = [];
      for (const contract of diff.contracts) {
        for (const fn of contract.functions) {
          if (
            matchesSelector(member, {
              fixture_id: contract.fixture_id,
              logical_id: contract.logical_id,
              function_name: fn.function_name,
              case_id: fn.case_id,
            })
          ) {
            matches.push({ contract, fn });
          }
        }
      }

      if (matches.length === 0) {
        throw new Error(
          `Cannot evaluate aggregate budget "${name}": member ${formatSelector(member)} has no matched BASE/HEAD benchmark`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `Cannot evaluate aggregate budget "${name}": member ${formatSelector(member)} is ambiguous (matched ${matches.length} benchmarks)`,
        );
      }

      const { contract, fn } = matches[0];
      const canonicalKey = JSON.stringify([
        contract.fixture_id ?? "",
        contract.logical_id ?? "",
        fn.function_name,
        fn.case_id ?? "",
      ]);

      if (matchedCanonicalKeys.has(canonicalKey)) {
        throw new Error(
          `Cannot evaluate aggregate budget "${name}": duplicate member detected for benchmark "${contract.logical_id ?? contract.contract_id} / ${fn.function_name}${fn.case_id ? ` / ${fn.case_id}` : ""}"`,
        );
      }

      matchedCanonicalKeys.add(canonicalKey);
      resolvedMembers.push({ selector: member, contract, fn, canonicalKey });
    }

    // 3. Validate environment compatibility across all resolved members
    let commonSource: string | undefined;
    let commonProtocol: number | undefined;
    let commonNetwork: string | undefined;
    let commonComputeConfig: string | undefined;
    let commonLimitsConfig: string | undefined;

    for (const { fn } of resolvedMembers) {
      const prov = fn.head_provenance;
      if (!prov) continue;
      if (commonSource === undefined) {
        commonSource = prov.source;
        commonProtocol = prov.protocol;
        commonNetwork = prov.network_id;
        commonComputeConfig = prov.compute_config_sha256;
        commonLimitsConfig = prov.resource_limits_sha256;
      } else {
        if (prov.source !== commonSource) {
          throw new Error(
            `Cannot evaluate aggregate budget "${name}": incompatible measurement environments across members (mismatched meter source: ${commonSource} vs ${prov.source})`,
          );
        }
        if (prov.protocol !== commonProtocol) {
          throw new Error(
            `Cannot evaluate aggregate budget "${name}": incompatible measurement environments across members (mismatched protocol: ${commonProtocol} vs ${prov.protocol})`,
          );
        }
        if (prov.network_id !== commonNetwork) {
          throw new Error(
            `Cannot evaluate aggregate budget "${name}": incompatible measurement environments across members (mismatched network: ${commonNetwork} vs ${prov.network_id})`,
          );
        }
        if (prov.compute_config_sha256 !== commonComputeConfig) {
          throw new Error(
            `Cannot evaluate aggregate budget "${name}": incompatible measurement environments across members (mismatched compute configuration / calibration)`,
          );
        }
        if (prov.resource_limits_sha256 !== commonLimitsConfig) {
          throw new Error(
            `Cannot evaluate aggregate budget "${name}": incompatible measurement environments across members (mismatched resource limits configuration)`,
          );
        }
      }
    }

    // 4. Compute metrics and breakdown
    const breakdown: Record<MetricKey, AggregateMemberBreakdown[]> = {} as any;
    const metrics: AggregateMetricDiff[] = [];

    for (const key of METRIC_KEYS) {
      const memberRows: AggregateMemberBreakdown[] = [];
      let allComparable = true;
      let unavailableReason: string | undefined;
      let baseSum = 0;
      let headSum = 0;

      for (const { contract, fn } of resolvedMembers) {
        const mDiff = fn.metrics.find((m) => m.key === key);
        const baseVal = mDiff?.base.consumed ?? null;
        const headVal = mDiff?.head.consumed ?? null;
        const delta =
          mDiff?.delta ??
          (baseVal !== null && headVal !== null ? headVal - baseVal : null);

        memberRows.push({
          fixture_id: contract.fixture_id,
          logical_id: contract.logical_id,
          contract_id: contract.head_contract_id || contract.contract_id,
          function_name: fn.function_name,
          case_id: fn.case_id,
          base_consumed: baseVal,
          head_consumed: headVal,
          delta,
        });

        if (
          !mDiff ||
          mDiff.availability === "unavailable" ||
          baseVal === null ||
          headVal === null
        ) {
          allComparable = false;
          if (!unavailableReason) {
            unavailableReason = `Member ${contract.logical_id ?? contract.contract_id} / ${fn.function_name}${fn.case_id ? ` / ${fn.case_id}` : ""} ${key} is unavailable: ${mDiff?.reason ?? "measured value unavailable"}`;
          }
        } else {
          baseSum += baseVal;
          headSum += headVal;
        }
      }

      breakdown[key] = memberRows;

      if (!allComparable) {
        metrics.push({
          key,
          base_consumed: null,
          head_consumed: null,
          delta: null,
          pct: null,
          regression: false,
          availability: "unavailable",
          reason: unavailableReason,
          description: AGGREGATE_METRIC_DESCRIPTIONS[key],
        });
      } else {
        const delta = headSum - baseSum;
        const regression = delta > 0;
        const pct =
          baseSum === 0 ? (delta > 0 ? null : 0) : (delta / baseSum) * 100;

        metrics.push({
          key,
          base_consumed: baseSum,
          head_consumed: headSum,
          delta,
          pct,
          regression,
          availability: "comparable",
          description: AGGREGATE_METRIC_DESCRIPTIONS[key],
        });
      }
    }

    const hasRegression = metrics.some((m) => m.regression);
    const provenance: AggregateProvenance | undefined = commonSource
      ? {
          source: commonSource,
          protocol_version: commonProtocol ?? 0,
          network_passphrase: commonNetwork ?? "",
          compute_config_sha256: commonComputeConfig,
        }
      : undefined;

    aggregateDiffs.push({
      name,
      description: aggDef.description,
      members: aggDef.members,
      member_count: resolvedMembers.length,
      breakdown,
      metrics,
      provenance,
      hasRegression,
    });
  }

  diff.aggregates = aggregateDiffs;
  if (aggregateDiffs.some((a) => a.hasRegression)) {
    diff.hasRegression = true;
  }

  return aggregateDiffs;
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
  config?: {
    aggregates?: Record<string, AggregateBudgetConfig>;
    limits?: {
      aggregates?: Record<string, Partial<Record<MetricKey, number>>>;
    };
    thresholds?: {
      aggregates?: Record<string, Partial<Record<MetricKey, any>>>;
    };
  } | null,
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

  const diff: DiffResult = {
    contracts,
    hasRegression: contracts.some((c) => c.hasRegression),
    newContracts,
    removedContracts,
  };

  if (config) {
    computeAggregateDiffs(diff, config);
  }

  return diff;
}
