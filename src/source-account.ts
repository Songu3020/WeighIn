import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Address, rpc, Transaction, xdr } from "@stellar/stellar-sdk";
import { z } from "zod";
import { redactEndpointSecrets } from "./endpoint";
import { parseFixtures, IdentifiedInvocation } from "./identity";
import {
  buildInvocationTransaction,
  calculateContractId,
  ensureContractDeployed,
  getOrInitAccount,
  metricsFromSimulation,
  normalizeSourceAccount,
  resolveContractWasmPath,
  Metrics,
} from "./measurement";
import {
  ComputeProvenance,
  measureInvocation,
  resolveSimulationHelper,
  ResourceLimits,
} from "./simulation";
import { METRIC_KEYS, MetricKey } from "./record-schema";

/** One measured source-account variant.
 *  Only the public key is required: benchmark invocations are simulated, so
 *  no account key material is ever read, held or submitted.
 */
export interface SourceAccountVariant {
  /** Stable label used in the report; must be unique within one measurement. */
  label: string;
  /** Ed25519 account public key (G...) that invokes the measured contract. */
  public_key: string;
}

export const SourceAccountVariantSchema = z
  .object({
    label: z.string().min(1),
    public_key: z
      .string()
      .min(1)
      .refine(
        (value) => {
          try {
            normalizeSourceAccount(value);
            return true;
          } catch {
            return false;
          }
        },
        {
          message:
            "public_key must be an Ed25519 account public key (G...) of an account that exists on the network",
        },
      ),
  })
  .strict();

export const SourceAccountVariantListSchema = z
  .array(SourceAccountVariantSchema)
  .min(2, "At least two source accounts are required to measure an effect")
  .superRefine((variants, ctx) => {
    const labels = new Set<string>();
    const keys = new Set<string>();
    variants.forEach((variant, index) => {
      if (labels.has(variant.label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate source-account label: ${variant.label}`,
          path: [index, "label"],
        });
      }
      labels.add(variant.label);
      if (keys.has(variant.public_key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate source account: ${variant.public_key}`,
          path: [index, "public_key"],
        });
      }
      keys.add(variant.public_key);
    });
  });

/** One measured run of the same contract case under a single source account. */
export interface SourceAccountRun {
  label: string;
  source_account: string;
  /** Auth mode reported by the native helper for this run. */
  auth_mode: string;
  host_features: string[];
  seed: number[];
  protocol: number;
  /** Ledger the immutable snapshot was captured at. */
  ledger: number;
  metrics: Metrics;
  /** Resource limits decoded from the same captured snapshot. */
  resource_limits: ResourceLimits;
  provenance: ComputeProvenance;
}

/** Consumption difference of one metric between the baseline and a variant. */
export interface SourceAccountMetricEffect {
  metric: MetricKey;
  baseline: number | null;
  variant: number | null;
  delta: number | null;
  changed: boolean;
}

export interface SourceAccountVariantEffects {
  label: string;
  source_account: string;
  effects: SourceAccountMetricEffect[];
  /** Metrics whose measured consumption changed against the baseline. */
  changed_metrics: MetricKey[];
}

/** Invariants that must hold for every measured run of one contract case.
 *  They are compared across runs, not asserted by the caller.
 */
export interface SourceAccountHeldFixed {
  wasm_sha256: string;
  host_function_sha256: string;
  protocol: number;
  auth_mode: string;
  host_features: string[];
  seed: number[];
  network_id: string;
  helper_sha256: string;
  compute_config_sha256: string;
  resource_limits_sha256: string;
}

/** Verdict on whether a source-account change invalidates comparisons. */
export interface SourceAccountComparison {
  /** True when only the source account varied between the measured runs. */
  isolated: boolean;
  /** True when at least one measured metric changed with the source account. */
  metrics_changed: boolean;
  /** Metrics whose measured consumption changed with the source account. */
  changed_metrics: MetricKey[];
  /** True when results measured under different source accounts may be
   *  compared across runs. */
  cross_run_comparison_valid: boolean;
  reason: string;
}

export interface SourceAccountEffectReport {
  schema_version: 1;
  fixture_id: string;
  logical_id: string;
  contract_id: string;
  function_name: string;
  case_id: string;
  wasm_sha256: string;
  /** The first measured variant; every effect is relative to this run. */
  baseline: SourceAccountRun;
  variants: SourceAccountRun[];
  effects: SourceAccountVariantEffects[];
  held_fixed: SourceAccountHeldFixed;
  comparison: SourceAccountComparison;
}

export interface MeasureSourceAccountEffectsOptions {
  /** Absolute path to the fixtures JSON file. */
  fixturesPath: string;
  /** Stable workspace-relative fixture path, identical across variants. */
  fixtureId?: string;
  /** Soroban RPC endpoint. Defaults to localhost:8000/rpc. */
  rpcUrl?: string;
  /**
   * Absolute path to the deployer key file. The deployer signs deployment
   * only; it is never a measured source account unless it is also declared
   * as a variant.
   */
  keyFile?: string;
  /** Executable override; otherwise build the bundled pinned helper on Linux x64. */
  helperPath?: string;
  /** Logical contract identity to measure. Defaults to the first contract. */
  logicalId?: string;
  /** Invoked function name. Defaults to the first declared invocation. */
  functionName?: string;
  /** Invocation case identity. Defaults to the resolved invocation. */
  caseId?: string;
  /** Accounts to compare, in order. The first entry is the baseline. */
  sourceAccounts: SourceAccountVariant[];
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

/** Digest of the invoked host function, used to prove that only the source
 *  account changed between measured runs. */
export function hostFunctionSha256(transaction: Transaction): string {
  const operation = transaction.toEnvelope().v1().tx().operations();
  if (
    operation.length !== 1 ||
    operation[0].body().switch().name !== "invokeHostFunction"
  ) {
    throw new Error("Expected exactly one host invocation");
  }
  const hostFunction = operation[0]
    .body()
    .invokeHostFunctionOp()
    .hostFunction()
    .toXDR("base64");
  return crypto.createHash("sha256").update(hostFunction).digest("hex");
}

/** Compare one variant against the baseline and describe the differences. */
export function computeSourceAccountEffects(
  baseline: SourceAccountRun,
  variant: SourceAccountRun,
): SourceAccountVariantEffects {
  const effects: SourceAccountMetricEffect[] = METRIC_KEYS.map((metric) => {
    const base = baseline.metrics[metric].consumed;
    const other = variant.metrics[metric].consumed;
    const delta = base === null || other === null ? null : other - base;
    return {
      metric,
      baseline: base,
      variant: other,
      delta,
      changed: delta !== null && delta !== 0,
    };
  });
  return {
    label: variant.label,
    source_account: variant.source_account,
    effects,
    changed_metrics: effects
      .filter((effect) => effect.changed)
      .map((effect) => effect.metric),
  };
}

/** Fail closed when a measured run drifted away from the baseline.
 *  Comparing runs measured under different code, protocol, calibration or
 *  resource limits would report an effect that the source account did not
 *  cause, so those comparisons are rejected instead of summarised.
 */
export function assertHeldFixed(
  baseline: SourceAccountRun,
  variant: SourceAccountRun,
): void {
  const checks: [string, unknown, unknown][] = [
    ["protocol", baseline.provenance.protocol, variant.provenance.protocol],
    ["auth_mode", baseline.provenance.auth_mode, variant.provenance.auth_mode],
    [
      "host_features",
      baseline.provenance.host_features,
      variant.provenance.host_features,
    ],
    ["seed", baseline.provenance.seed, variant.provenance.seed],
    [
      "network_id",
      baseline.provenance.network_id,
      variant.provenance.network_id,
    ],
    [
      "helper_sha256",
      baseline.provenance.helper_sha256,
      variant.provenance.helper_sha256,
    ],
    [
      "compute_config_sha256",
      baseline.provenance.compute_config_sha256,
      variant.provenance.compute_config_sha256,
    ],
    [
      "resource_limits_sha256",
      baseline.provenance.resource_limits_sha256,
      variant.provenance.resource_limits_sha256,
    ],
  ];
  for (const [field, expected, actual] of checks) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(
        `Source-account comparison is not isolated: ${field} changed between ${baseline.label} and ${variant.label}`,
      );
    }
  }
}

function resolveInvocation(
  invocations: IdentifiedInvocation[],
  options: MeasureSourceAccountEffectsOptions,
): IdentifiedInvocation {
  let invocation: IdentifiedInvocation | undefined;
  if (options.functionName !== undefined && options.caseId !== undefined) {
    invocation = invocations.find(
      (candidate) =>
        candidate.function_name === options.functionName &&
        candidate.case_id === options.caseId,
    );
  } else if (options.functionName !== undefined) {
    invocation = invocations.find(
      (candidate) => candidate.function_name === options.functionName,
    );
  } else if (options.caseId !== undefined) {
    invocation = invocations.find(
      (candidate) => candidate.case_id === options.caseId,
    );
  } else {
    invocation = invocations[0];
  }
  if (!invocation) {
    throw new Error(
      `Unknown invocation: ${options.functionName ?? "*"} / ${options.caseId ?? "*"}`,
    );
  }
  return invocation;
}

/**
 * Measure the effect of the invoking source account on one contract case.
 *
 * Code, arguments, protocol, calibration and resource limits are held fixed
 * while the source account varies. Every variant is measured through the
 * production path: RPC snapshot capture, native helper execution and the
 * audited metric mapping. The result states whether the source account
 * changed the measured resources and whether results measured under
 * different source accounts may be compared across runs.
 */
export async function measureSourceAccountEffects(
  options: MeasureSourceAccountEffectsOptions,
): Promise<SourceAccountEffectReport> {
  const variants = SourceAccountVariantListSchema.parse(
    options.sourceAccounts,
  ).map((variant) => ({
    ...variant,
    public_key: normalizeSourceAccount(variant.public_key),
  }));
  if (options.signal?.aborted) {
    throw options.signal.reason || new Error("Measurement cancelled");
  }

  const effectiveRpcUrl = options.rpcUrl ?? "http://localhost:8000/rpc";
  const fixturesDir = path.dirname(path.resolve(options.fixturesPath));
  const keyFile =
    options.keyFile ?? path.join(fixturesDir, ".weighin-temp-key");
  const fixturesSpec = parseFixtures(
    fs.readFileSync(options.fixturesPath, "utf8"),
    options.fixtureId ??
      path.relative(process.cwd(), path.resolve(options.fixturesPath)),
  );

  const contractSpec =
    options.logicalId === undefined
      ? fixturesSpec.contracts[0]
      : fixturesSpec.contracts.find(
          (contract) => contract.logical_id === options.logicalId,
        );
  if (!contractSpec) {
    throw new Error(
      `Unknown logical contract identity: ${options.logicalId} (available: ${fixturesSpec.contracts
        .map((contract) => contract.logical_id)
        .join(", ")})`,
    );
  }

  const invocation = resolveInvocation(contractSpec.invocations, options);
  const wasmPath = resolveContractWasmPath(fixturesDir, contractSpec.wasm_path);
  const wasmBytes = fs.readFileSync(wasmPath);
  const wasmHash = crypto.createHash("sha256").update(wasmBytes).digest();
  const wasmSha256 = wasmHash.toString("hex");
  const salt = crypto.createHash("sha256").update(wasmHash).digest();

  const server = new rpc.Server(effectiveRpcUrl, { allowHttp: true });
  const deployer = await getOrInitAccount(
    keyFile,
    effectiveRpcUrl,
    options.signal,
  );

  // Every declared source account must exist on the network before the
  // contract is deployed and before any measurement runs, so an invalid
  // account fails closed without side effects.
  for (const variant of variants) {
    try {
      await server.getAccount(variant.public_key);
    } catch (err: any) {
      throw new Error(
        `Source account ${variant.label} is not available on the network: ${variant.public_key} (${redactEndpointSecrets(String(err?.message ?? err), effectiveRpcUrl)})`,
      );
    }
  }

  const contractId = calculateContractId(deployer.publicKey(), salt);
  await ensureContractDeployed({
    server,
    deployer,
    deployerAddress: Address.fromString(deployer.publicKey()),
    wasmBytes,
    wasmHash,
    salt,
    contractId,
    rpcUrl: effectiveRpcUrl,
    signal: options.signal,
  });

  const helperPath = await resolveSimulationHelper(options.helperPath);
  const runs: SourceAccountRun[] = [];
  const hostFunctionDigests: string[] = [];

  for (const variant of variants) {
    if (options.signal?.aborted) {
      throw options.signal.reason || new Error("Measurement cancelled");
    }
    const transaction = await buildInvocationTransaction({
      server,
      sourceAccount: variant.public_key,
      contractId,
      invocation,
      rpcUrl: effectiveRpcUrl,
      signal: options.signal,
    });
    const { output, provenance, limits } = await measureInvocation(
      effectiveRpcUrl,
      transaction,
      helperPath,
      { signal: options.signal },
    );
    if (provenance.source_account !== variant.public_key) {
      throw new Error(
        `Measured source account does not match the requested account for ${variant.label}: ${provenance.source_account ?? "unknown"}`,
      );
    }
    runs.push({
      label: variant.label,
      source_account: variant.public_key,
      auth_mode: output.auth_mode,
      host_features: output.host_features,
      seed: provenance.seed,
      protocol: output.protocol,
      ledger: provenance.ledger,
      metrics: metricsFromSimulation(output, limits),
      resource_limits: limits,
      provenance,
    });
    hostFunctionDigests.push(hostFunctionSha256(transaction));
  }

  const baseline = runs[0];
  for (let index = 1; index < runs.length; index++) {
    assertHeldFixed(baseline, runs[index]);
    if (hostFunctionDigests[0] !== hostFunctionDigests[index]) {
      throw new Error(
        `Source-account comparison is not isolated: the invoked host function changed between ${baseline.label} and ${runs[index].label}`,
      );
    }
  }

  const effects = runs
    .slice(1)
    .map((variant) => computeSourceAccountEffects(baseline, variant));
  const changedMetrics = Array.from(
    new Set(effects.flatMap((effect) => effect.changed_metrics)),
  ) as MetricKey[];

  return {
    schema_version: 1,
    fixture_id: fixturesSpec.fixture_id,
    logical_id: contractSpec.logical_id,
    contract_id: contractId,
    function_name: invocation.function_name,
    case_id: invocation.case_id,
    wasm_sha256: wasmSha256,
    baseline,
    variants: runs.slice(1),
    effects,
    held_fixed: {
      wasm_sha256: wasmSha256,
      host_function_sha256: hostFunctionDigests[0],
      protocol: baseline.provenance.protocol,
      auth_mode: baseline.provenance.auth_mode,
      host_features: baseline.provenance.host_features,
      seed: baseline.provenance.seed,
      network_id: baseline.provenance.network_id,
      helper_sha256: baseline.provenance.helper_sha256,
      compute_config_sha256: baseline.provenance.compute_config_sha256,
      resource_limits_sha256: baseline.provenance.resource_limits_sha256 ?? "",
    },
    comparison: {
      isolated: true,
      metrics_changed: changedMetrics.length > 0,
      changed_metrics: changedMetrics,
      cross_run_comparison_valid: changedMetrics.length === 0,
      reason:
        changedMetrics.length === 0
          ? "The source account did not change any measured resource for this contract case; results measured under different source accounts stay comparable for this case."
          : `The source account changed the measured resources (${changedMetrics.join(", ")}); results measured under different source accounts are not comparable.`,
    },
  };
}
