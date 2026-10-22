import * as fs from "fs";
import * as TOML from "toml";
import { z } from "zod";
import { formatZodError } from "./config";
import { DiffResult, METRIC_KEYS, MetricDiff, MetricKey } from "./diff";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * A rule value is either a named policy string or a numeric percentage cap.
 *
 * Named policies:
 *   "strict_zero_tolerance"     — any increase fails
 *   "allow_N_percent_increase"  — N% increase allowed (e.g. "allow_10_percent_increase")
 *   "ignore"                    — never fail on this metric
 */
export type RuleValue = string | number;

export interface GlobalThresholds {
  /** If true, any metric increase (even 1 unit) fails. Default false. */
  fail_on_any_regression?: boolean;
  /** Maximum allowed CPU increase as a percentage. */
  max_allowed_cpu_increase_pct?: number;
  /** Maximum allowed memory increase as a percentage. */
  max_allowed_memory_increase_pct?: number;
}

export interface WeighinConfig {
  limits?: {
    global?: Partial<Record<MetricKey, number>>;
    functions?: Record<string, Partial<Record<MetricKey, number>>>;
  };
  thresholds?: {
    global?: GlobalThresholds;
    /** Per-function overrides keyed by function name */
    functions?: Record<string, Partial<Record<MetricKey, RuleValue>>>;
  };
}

export interface PolicyOrigin {
  mode: "head" | "trusted";
  path: string;
  revision: string;
  content_sha256: string;
}

const percentage = z.number().finite().nonnegative();
const ruleSchema = z.union([
  percentage,
  z
    .string()
    .refine(
      (value) =>
        value === "ignore" ||
        value === "strict_zero_tolerance" ||
        parseAllowPct(value) !== null,
      "Unsupported threshold rule",
    ),
]);
const metricRules = z
  .object(
    Object.fromEntries(METRIC_KEYS.map((key) => [key, ruleSchema.optional()])),
  )
  .strict();
const configSchema = z
  .object({
    limits: z
      .object({
        global: z.record(z.enum(METRIC_KEYS), percentage).optional(),
        functions: z
          .record(z.string().min(1), z.record(z.enum(METRIC_KEYS), percentage))
          .optional(),
      })
      .strict()
      .optional(),
    thresholds: z
      .object({
        global: z
          .object({
            fail_on_any_regression: z.boolean().optional(),
            max_allowed_cpu_increase_pct: percentage.optional(),
            max_allowed_memory_increase_pct: percentage.optional(),
          })
          .strict()
          .optional(),
        functions: z.record(z.string().min(1), metricRules).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Validate policies independently of whether a benchmark happened to regress. */
export function validateConfig(value: unknown): WeighinConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(formatZodError(parsed.error, "weighin.toml"));
  return parsed.data as WeighinConfig;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and parse weighin.toml. Returns null if the file does not exist
 * (no thresholds enforced). Throws on parse errors.
 */
export function loadConfig(configPath: string): WeighinConfig | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const raw = fs.readFileSync(configPath, "utf8");
  try {
    return validateConfig(TOML.parse(raw));
  } catch (error: any) {
    if (
      error instanceof Error &&
      error.message.startsWith("Invalid WeighIn configuration")
    )
      throw error;
    throw new Error(`Failed to parse TOML in ${configPath}: ${error.message}`);
  }
}

/** Parse policy content while retaining a verifiable origin for reports. */
export function loadConfigContent(
  content: string,
  sourcePath: string,
): WeighinConfig {
  try {
    return validateConfig(TOML.parse(content));
  } catch (error: any) {
    if (
      error instanceof Error &&
      error.message.startsWith("Invalid WeighIn configuration")
    )
      throw error;
    throw new Error(`Failed to parse TOML in ${sourcePath}: ${error.message}`);
  }
}

export function policyContentSha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

export interface Violation {
  fixture_id?: string;
  logical_id?: string;
  case_id?: string;
  contract_id: string;
  function_name: string;
  metric: MetricKey;
  delta: number | null;
  pct: number | null;
  rule: string;
  message: string;
}

function parseAllowPct(rule: string): number | null {
  // Matches "allow_10_percent_increase", "allow_2.5_percent_increase", etc.
  const m = rule.match(/^allow_(\d+(?:\.\d+)?)_percent_increase$/);
  const value = m ? Number(m[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

function evaluateRule(
  rule: RuleValue,
  diff: MetricDiff,
  contractId: string,
  functionName: string,
): Violation | null {
  const ruleStr =
    typeof rule === "number" ? `allow_${rule}_percent_increase` : rule;

  if (ruleStr === "ignore") return null;
  if (diff.availability === "unavailable") {
    return {
      contract_id: contractId,
      function_name: functionName,
      metric: diff.key,
      delta: null,
      pct: null,
      rule: ruleStr,
      message: `${diff.key} unavailable; cannot evaluate configured policy: ${diff.reason}`,
    };
  }
  if (!diff.regression) return null;

  if (ruleStr === "strict_zero_tolerance") {
    return {
      contract_id: contractId,
      function_name: functionName,
      metric: diff.key,
      delta: diff.delta,
      pct: diff.pct,
      rule: ruleStr,
      message: `${diff.key} increased by ${diff.delta} (strict zero tolerance)`,
    };
  }

  const allowedPct = typeof rule === "number" ? rule : parseAllowPct(ruleStr);
  if (allowedPct !== null) {
    if (diff.pct === null || diff.pct > allowedPct) {
      const pctStr = diff.pct === null ? "Infinity" : diff.pct.toFixed(2);
      return {
        contract_id: contractId,
        function_name: functionName,
        metric: diff.key,
        delta: diff.delta,
        pct: diff.pct,
        rule: ruleStr,
        message: `${diff.key} increased by ${pctStr}% (limit ${allowedPct}%)`,
      };
    }
    return null;
  }

  throw new Error(`Unsupported threshold rule "${ruleStr}" for ${diff.key}`);
}

// Map from global threshold fields to metric keys + default rules
const GLOBAL_RULE_MAP: Array<{
  field: keyof GlobalThresholds;
  metric: MetricKey;
  toRule: (val: number) => RuleValue;
}> = [
  {
    field: "max_allowed_cpu_increase_pct",
    metric: "cpu_instructions",
    toRule: (v) => v,
  },
  {
    field: "max_allowed_memory_increase_pct",
    metric: "memory_bytes",
    toRule: (v) => v,
  },
];

/**
 * Enforce all threshold rules against a DiffResult.
 * Returns the list of violations (empty = pass).
 */
export function enforceThresholds(
  diff: DiffResult,
  config: WeighinConfig | null,
): Violation[] {
  if (config !== null) config = validateConfig(config);
  if (!config?.thresholds && !config?.limits) return [];

  const global = config?.thresholds?.global ?? {};
  const perFunction = config?.thresholds?.functions ?? {};
  const globalLimits = config?.limits?.global ?? {};
  const functionLimits = config?.limits?.functions ?? {};
  const violations: Violation[] = [];

  const comparedNames = new Set(
    diff.contracts.flatMap((contract) =>
      contract.functions.map((fn) => fn.function_name),
    ),
  );
  for (const [name, rules] of Object.entries(perFunction)) {
    if (
      Object.values(rules).some((rule) => rule !== "ignore") &&
      !comparedNames.has(name)
    ) {
      throw new Error(
        `Cannot evaluate configured policy: function ${name} has no matched BASE/HEAD benchmark`,
      );
    }
  }
  for (const [name, limits] of Object.entries(functionLimits)) {
    if (Object.keys(limits).length > 0 && !comparedNames.has(name)) {
      throw new Error(
        `Cannot evaluate configured limits: function ${name} has no matched BASE/HEAD benchmark`,
      );
    }
  }
  if (
    (global.fail_on_any_regression ||
      GLOBAL_RULE_MAP.some(({ field }) => global[field] !== undefined) ||
      Object.keys(globalLimits).length > 0) &&
    comparedNames.size === 0
  ) {
    throw new Error(
      "Cannot evaluate configured global policy or limits: no matched BASE/HEAD benchmarks",
    );
  }

  for (const contract of diff.contracts) {
    for (const fn of contract.functions) {
      const identity = {
        fixture_id: contract.fixture_id,
        logical_id: contract.logical_id,
        case_id: fn.case_id,
      };
      for (const metricDiff of fn.metrics) {
        const absoluteLimit =
          functionLimits[fn.function_name]?.[metricDiff.key] ??
          globalLimits[metricDiff.key];
        if (absoluteLimit !== undefined) {
          if (
            metricDiff.availability === "unavailable" ||
            metricDiff.head.consumed === null
          ) {
            violations.push({
              ...identity,
              contract_id: contract.contract_id,
              function_name: fn.function_name,
              metric: metricDiff.key,
              delta: null,
              pct: null,
              rule: `absolute_limit(${absoluteLimit})`,
              message: `${metricDiff.key} unavailable; cannot evaluate configured absolute limit: ${metricDiff.reason ?? "measured value unavailable"}`,
            });
          } else if (metricDiff.head.consumed > absoluteLimit) {
            violations.push({
              ...identity,
              contract_id: contract.contract_id,
              function_name: fn.function_name,
              metric: metricDiff.key,
              delta: metricDiff.head.consumed - absoluteLimit,
              pct: null,
              rule: `absolute_limit(${absoluteLimit})`,
              message: `${metricDiff.key} exceeded absolute limit: limit ${absoluteLimit}, actual ${metricDiff.head.consumed}`,
            });
          }
        }
        // 1. Per-function overrides take priority over global rules
        const fnOverrides = perFunction[fn.function_name];
        const fnRule = fnOverrides?.[metricDiff.key];
        if (fnRule !== undefined) {
          const v = evaluateRule(
            fnRule,
            metricDiff,
            contract.contract_id,
            fn.function_name,
          );
          if (v) violations.push({ ...v, ...identity });
          continue;
        }

        // 2. Global fail_on_any_regression
        if (
          global.fail_on_any_regression &&
          (metricDiff.regression || metricDiff.availability === "unavailable")
        ) {
          violations.push({
            ...identity,
            contract_id: contract.contract_id,
            function_name: fn.function_name,
            metric: metricDiff.key,
            delta: metricDiff.delta,
            pct: metricDiff.pct,
            rule: "fail_on_any_regression",
            message:
              metricDiff.availability === "unavailable"
                ? `${metricDiff.key} unavailable; cannot evaluate fail_on_any_regression: ${metricDiff.reason}`
                : `${metricDiff.key} increased by ${metricDiff.delta} (fail_on_any_regression)`,
          });
          continue;
        }

        // 3. Named global rules (cpu, memory caps)
        for (const { field, metric, toRule } of GLOBAL_RULE_MAP) {
          if (metricDiff.key !== metric) continue;
          const val = global[field];
          if (val !== undefined) {
            const v = evaluateRule(
              toRule(val as number),
              metricDiff,
              contract.contract_id,
              fn.function_name,
            );
            if (v) violations.push({ ...v, ...identity });
          }
        }
      }
    }
  }

  return violations;
}
