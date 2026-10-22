# Explicitly Scoped Aggregate Resource Budgets

This document specifies the design, interface, compatibility model, and evaluation semantics for explicitly scoped aggregate resource budgets in WeighIn (Issue #50).

## 1. Problem Statement & Motivation

Existing WeighIn policies evaluate benchmark cases independently (per-function overrides and global regression thresholds). However, complex Soroban workflows and user scenarios span multiple distinct contract invocations (e.g., reserve + transfer, initialize + quote + swap, or auth + deposit). 

Evaluating cases only in isolation leaves a validation gap: individual operations might each stay within permissive per-invocation tolerances, while the aggregate cost of the complete scenario regresses significantly or exceeds network limits.

To bound the total work of a declared scenario without introducing loose heuristics or unbounded suite totals, WeighIn provides **explicitly scoped aggregate resource budgets**.

## 2. Scope & Boundaries

- **Explicit membership only**: There is no automatic aggregation of an entire test suite, setup/deployment transactions, or cross-scenario executions. Aggregates are explicitly defined by name and declared member selectors.
- **Compatible environments only**: Aggregates can only combine benchmarks executed within compatible measurement environments (same schema version, meter source, protocol version, network passphrase, and calibration/cost configuration). Unsupported mixed-environment aggregation fails closed.
- **Audited metrics only**: Existing unsupported metrics (`historical_data_read_bytes`, `contract_data_hard_limit`) remain unavailable. Unavailable metrics on any member make the aggregate metric unavailable for that budget.
- **Independence of runtime addresses**: Membership is governed by stable logical identities, independent of runtime contract addresses or compiled WASM hashes.

---

## 3. Configuration & Selector Model

Aggregate budgets are configured in `weighin.toml` under the `[aggregates.<name>]` section. Aggregate membership reuses the reviewed logical selector model from Issue #40.

### Syntax Example

```toml
[aggregates.token_transfer_flow]
description = "Full token transfer scenario: quote followed by execution"
members = [
  { fixture_id = "id:payment-suite", logical_id = "id:token", function_name = "quote", case_id = "id:default" },
  { fixture_id = "id:payment-suite", logical_id = "id:token", function_name = "transfer", case_id = "id:default" }
]

[aggregates.token_transfer_flow.limits]
cpu_instructions = 15_000_000
memory_bytes     = 3_000_000

[aggregates.token_transfer_flow.thresholds]
cpu_instructions = "allow_5_percent_increase"
memory_bytes     = "strict_zero_tolerance"
ledger_write_bytes = "strict_zero_tolerance"
```

Limits and thresholds can also be declared in the existing sections for symmetry:
```toml
[limits.aggregates.token_transfer_flow]
cpu_instructions = 15_000_000

[thresholds.aggregates.token_transfer_flow]
cpu_instructions = "allow_5_percent_increase"
```

### Selector Specification & Membership Rules

Each entry in `members` is a logical selector:
```typescript
export interface BenchmarkSelector {
  fixture_id?: string;
  logical_id?: string;
  function_name: string;
  case_id?: string;
}
```

- **Exact resolution**: Each declared member selector must resolve to exactly one logical benchmark case `[fixture_id, logical_id, function_name, case_id]` present in the comparison diff.
- **Deterministic missing member behavior**: If a declared member matches 0 benchmark cases in the comparison diff, evaluation fails immediately with an explicit error:
  `Cannot evaluate aggregate budget "${name}": member ${selector} has no matched BASE/HEAD benchmark`.
- **Deterministic duplicate member behavior**: If multiple selectors within the same aggregate budget resolve to the same benchmark case, or if identical duplicate selectors are declared, evaluation fails immediately:
  `Cannot evaluate aggregate budget "${name}": duplicate member detected for benchmark "${key}"`.
  This prevents accidental double-counting of resources.
- **Deterministic ambiguous selector behavior**: If an omitted selector field causes a selector to match multiple benchmark cases in the diff, evaluation fails:
  `Cannot evaluate aggregate budget "${name}": member ${selector} is ambiguous (matched ${count} benchmarks)`.
- **Strict exclusion**: Benchmarks not explicitly matched by declared members are strictly excluded from the aggregate sum.

---

## 4. Aggregable Metrics & Physical Units

Each Soroban metric has specific physical characteristics when aggregated across sequential invocations:

| Metric | Physical Meaning | Aggregation Semantics | Semantic Description |
|---|---|---|---|
| `cpu_instructions` | Soroban host simulated CPU instructions | Sum of instructions | Cumulative CPU Instructions |
| `memory_bytes` | Soroban host simulated memory allocation | Sum of invocation allocations | **Cumulative Invocation Memory Bytes (not peak concurrent memory)** |
| `ledger_read_entries` | Footprint read entries | Sum of entries accessed | Cumulative Footprint Read Entries |
| `ledger_read_bytes` | Disk read bytes | Sum of disk read bytes | Cumulative Disk Read Bytes |
| `ledger_write_entries` | Write footprint entries | Sum of write entries | Cumulative Write Footprint Entries |
| `ledger_write_bytes` | Ledger write bytes | Sum of ledger write bytes | Cumulative Ledger Write Bytes |
| `tx_size_bytes` | Transaction payload bytes | Sum of transaction sizes | Cumulative Tx Size Bytes |
| `events_count` | Successful contract/system events | Sum of emitted event counts | Cumulative Contract/System Events |
| `event_data_bytes` | Event and return XDR bytes | Sum of event & return bytes | Cumulative Event + Return XDR Bytes |
| `historical_data_read_bytes` | Unsupported in protocol 28 | Unavailable | Cumulative Historical Read Bytes (Unavailable) |
| `contract_data_hard_limit` | Unsupported in protocol 28 | Unavailable | Cumulative Contract Data (Unavailable) |

### Memory Semantics (Cumulative vs. Peak)

Simulated memory (`memory_bytes`) meters the host memory allocated for each isolated contract invocation. 

> [!IMPORTANT]
> A sum of invocation memory costs across multiple sequential invocations measures the **cumulative invocation memory allocated**. It does **NOT** represent peak resident set size (RSS) or peak concurrent memory. In all machine schemas, reports, and documentation, this metric is explicitly designated as `Cumulative Invocation Memory Bytes (sum of invocation costs, not peak concurrent memory)`.

---

## 5. Environmental Compatibility & Unavailable States

All member benchmarks in an aggregate must be measured under identical, compatible environment conditions:
1. **Schema version**: Member records must share the same record schema version.
2. **Meter source**: Member records must share the same meter source (`provenance.source`, e.g. `soroban-simulation`).
3. **Protocol version**: All members must share the same protocol version (`provenance.protocol`).
4. **Network passphrase**: All members must share the same network passphrase (`provenance.network_id`).
5. **Calibration & limits**: All members must share matching calibration cost settings (`provenance.compute_config_sha256` and `provenance.resource_limits_sha256`).

If any member differs in meter source, protocol, network, or calibration, evaluation fails closed before any threshold evaluation:
`Cannot evaluate aggregate budget "${name}": incompatible measurement environments across members`.

### Unavailable Member Metrics

If any member of an aggregate has a metric marked `availability === "unavailable"` or `consumed === null`:
- The aggregate value for that metric becomes `unavailable`.
- The aggregate diff records the member that caused the unavailability.
- If an absolute limit or relative threshold rule is configured on that metric for the aggregate, evaluation fails closed with a violation describing the unavailable member metric.

---

## 6. Evaluation Semantics & Policy Interaction

### Absolute Limits

Configured via `[aggregates.<name>.limits]`.
- Binds the aggregate HEAD sum: $\sum \text{head.consumed}$.
- If $\sum \text{head.consumed} > \text{limit}$, a violation is emitted:
  `"${metric} exceeded aggregate absolute limit: limit ${limit}, actual ${actual}"`.

### Relative Thresholds

Configured via `[aggregates.<name>.thresholds]`.
- Calculates $\Delta = \sum \text{head.consumed} - \sum \text{base.consumed}$.
- If $\Delta \le 0$, no regression occurred; passes.
- `strict_zero_tolerance`: Any increase ($\Delta > 0$) emits a violation.
- `allow_N_percent_increase`:
  - **Zero baseline**: When $\sum \text{base.consumed} = 0$ and $\Delta > 0$, the relative increase is undefined ($+\infty\%$). The evaluation fails closed with:
    `"${metric} increased by Infinity% (limit ${allowedPct}%)"`.
  - **Non-zero baseline**: Evaluated against the aggregate percentage delta: $\text{pct} = \frac{\Delta}{\sum \text{base.consumed}} \times 100$. If $\text{pct} > N$, a violation is emitted:
    `"${metric} increased by ${pct.toFixed(2)}% (limit ${allowedPct}%)"`.
- `ignore`: Bypasses threshold enforcement for that metric on this aggregate.

### Policy Interaction Without Double-Counting

Per-case policies (`thresholds.functions.<fn>`, `limits.functions.<fn>`, and global rules) continue to evaluate per-function metrics independently. Aggregate policies evaluate the aggregate sum independently.
- Violations for per-case policies carry the contract and function identity.
- Violations for aggregate policies carry the `aggregate_id`.
- The PR report and job output display both independently, clearly attributing each failure to its effective rule and scope without double-counting numbers or masking individual regressions.

---

## 7. Machine Results & Report Specification

### Machine Results (`DiffResult`)

`DiffResult` includes an optional `aggregates` field:

```typescript
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
```

### GitHub PR Comment & Job Summary Report

When `aggregates` are present, `renderComment` includes an **Aggregate Resource Budgets** section:
- Summary table with aggregate name, members count, base/head sums, deltas, percentages, and semantic descriptions.
- Explicit note on memory bytes: `Cumulative Invocation Memory (sum of invocation costs, not peak concurrent memory)`.
- Collapsible `<details>` section providing the exact per-member breakdown.
- Provenance details verifying source, protocol, and network identity.
- Aggregate violations rendered under `### ❌ Violations` with aggregate identity.
