# Metric provenance — protocol 28, schema 4

Supported path: Linux x64, standalone network, official `soroban-simulation`
and `soroban-env-host` **28.0.1**, SDK 16.0.1, captured protocol-28 state.
This audit concerns simulation resources. It does not measure physical disk IO,
CPU hardware instructions, process RSS, or an executed signed transaction.

## Source audit

The pinned crates identify upstream commit
[`7a7629cfef0328881497d60089f9b8acf202a495`](https://github.com/stellar/rs-soroban-env/tree/7a7629cfef0328881497d60089f9b8acf202a495).
The following source locations explain the mapping:

- `soroban-simulation/src/simulation.rs`: `simulate_invoke_host_function_op`
  records `simulated_instructions` and `simulated_memory` before constructing
  adjusted transaction resources. `SimulationAdjustmentConfig::default_adjustment`
  adjusts instructions, envelope-size estimates and refundable fees, but uses
  `SimulationAdjustmentFactor::no_adjustment()` for read/write bytes.
- `soroban-simulation/src/resources.rs`:
  `compute_adjusted_transaction_resources` passes those IO bytes through and uses
  RW footprint length for write-entry fees. It estimates maximum transaction size;
  this estimate is not the actual signed-envelope size.
- `soroban-env-host/src/e2e_invoke.rs`:
  `invoke_host_function_in_recording_mode` serializes the top-level return ScVal,
  constructs the footprint, counts classic/archive disk-read entry XDR bytes,
  excludes live ContractData/ContractCode from disk bytes, and sums encoded RW
  postimages for write bytes. Deletion has no postimage. Repeated accesses do not
  create repeated footprint keys. `encode_contract_events` excludes diagnostic
  and failed-call events, encodes whole ContractEvents, and adds their sizes to
  the return-value size.
- `soroban-env-host/src/fees.rs`: historical-data fees concern pushed transaction
  history; they do not supply historical read consumption.
- `stellar-xdr` 28.0.0's generated `config_setting_contract_compute_v0.rs`,
  `config_setting_contract_ledger_cost_v0.rs`,
  `config_setting_contract_ledger_cost_ext_v0.rs` and
  `config_setting_contract_events_v0.rs` define the captured resource caps.

[CAP-0066](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0066.md)
explains the distinction between live Soroban in-memory reads, classic/archive
disk reads and the RO+RW footprint cap. Its proposal constants are not used as
runtime limits. The production helper explicitly rejects archived state today.

## All eleven metric names

Limits below are decoded from the same immutable snapshot as the invocation.
No mainnet constants are substituted for a missing limit.

| JSON key | Consumed meaning / source | Limit setting | Availability |
|---|---|---|---|
| `cpu_instructions` | Native `simulated_instructions`: metered Soroban cost-model units | ComputeV0 `txMaxInstructions` | Measured |
| `memory_bytes` | Native `simulated_memory`: metered Soroban memory units | ComputeV0 `txMemoryLimit` | Measured |
| `ledger_read_entries` | Total distinct RO+RW footprint keys, including queried absence; **not** read-call count or disk-entry count | LedgerCostExtV0 `txMaxFootprintEntries` | Measured |
| `ledger_read_bytes` | `SorobanResources.diskReadBytes`; charged full entry XDR bytes for classic ledger entries on this supported path; live Soroban reads add zero | LedgerCostV0 `txMaxDiskReadBytes` | Measured |
| `ledger_write_entries` | RW footprint length, including no-op writes and deletion; **not** distinct changed postimages | LedgerCostV0 `txMaxWriteLedgerEntries` | Measured |
| `ledger_write_bytes` | `SorobanResources.writeBytes`: summed encoded RW postimages; no-op postimages count, deletions add zero; TTL/rent handled separately | LedgerCostV0 `txMaxWriteBytes` | Measured |
| `events_count` | Successful non-diagnostic ContractEvent count, including contract/system events | No independent protocol-28 count cap; `null` plus `limit_reason` | Measured |
| `event_data_bytes` | Whole successful ContractEvent XDR sizes **plus top-level return ScVal XDR size**, including XDR overhead/padding | EventsV0 `txMaxContractEventsSizeBytes` | Measured |
| `historical_data_read_bytes` | No corresponding protocol-28 consumption resource; historical-data fee is not a read count | Unavailable | Unavailable |
| `contract_data_hard_limit` | No verified instance-only post-invocation size/corresponding cap mapping; whole entries and per-entry limits must not be silently substituted | Unavailable | Unavailable |
| `tx_size_bytes` | Simulation's padded maximum-envelope estimate is not a signed benchmark transaction | Unavailable | Unavailable |

The pinned helper changes only instruction leeway. Promoting the IO fields relies
on its audited identity adjustment for IO. A future adjustment/library change
must revalidate this mapping; do not generalize all RPC budgets as consumption.
Zero means measured zero; unavailable records have null consumption and a reason.
A measured count with no independent cap is still comparable and usable in
regression policies. Numeric policies are permitted even when no network cap
exists; those configured caps are policy limits, not network limits.

## Transport, parity and environment checks

`src/simulation.ts` validates helper JSON against transaction-data XDR and decodes
return/event XDR. The production adapter requires full transaction-data and
return parity with RPC at the captured ledger. It now also decodes RPC
DiagnosticEvent wrappers and requires identical ordered successful non-diagnostic
ContractEvents. A mismatch fails the benchmark; it never blends conflicting
RPC/local measurements. RPC still supplies no direct consumed CPU/memory values.

Captured ComputeV0 limits must equal the helper's compute limits. All measured
caps are decoded from captured LedgerEntryData, validated, and included in
`resource_limits_sha256`. BASE/HEAD require equal resource-limit hashes, compute
calibration, helper/library/network/protocol/auth/seed identities and per-metric
sources/limits. Fee-only settings and last-modified metadata remain visible in
full config hashes and do not change the resource-limit identity.

Snapshots are per invocation. Live state and ledger-sensitive behavior can still
differ across revisions. Random/auth/archived compatibility limitations remain.
This source audit alone does not establish clean-build or live repeatability;
see the separate [repeatability experiment](repeatability.md).

## Explicit schema migration

New measurements emit `ContractBenchmark.schema_version: 4`. The logical tuple
and runtime diagnostics are unchanged. Measured metrics add `limit_source`, or
`limit_reason` when there is no independent cap. Provenance adds
`resource_limits_sha256` and the optional `source_account`, the account that
invoked the measured call. The helper input/output transport remains schema 1:
its existing footprint/IO/event fields were sufficient for this audit.

`source_account` is recorded, not assumed. It is the identity the measured
transaction invoked the contract with, and it is compared together with the
other environment identities, so records measured under different source
accounts are reported as incompatible instead of being compared. The
measurement capability and the measured proof are documented in
[source-account effects](source-account-effects.md).

The legacy key `event_data_bytes` is retained for configured policies, but schema
4 explicitly defines it as **Events + Return XDR Bytes**, not payload-only bytes.
The report labels `ledger_read_entries` as **Footprint Entries (RO + RW)**,
`ledger_read_bytes` as **Disk Read Bytes**, and `ledger_write_entries` as
**Write Footprint Entries**. They must not be silently relabeled as host call
counts or physical IO. Historical reports retain their old numeric labels.

Schema 3's other nine names were unavailable. Schema 4 promotes six; three stay
unavailable. Mixed schema comparisons fail explicitly. Legacy/schema-2/schema-3
records remain comparable only within their own schema, as before. Generate
both BASE and HEAD with the current producer to use schema 4; do not convert old
records by replacing null values with zero. Unknown/missing sources, changed
caps and incomplete schema-4 provenance fail closed even on unmatched records.
Global all-metric policies still fail on the three unsupported names unless
explicitly ignored. Targeted policies for supported metrics work normally.

## Evidence and reproduction

[Live verification](experiments/metric-provenance/verification.json),
[measurements](experiments/metric-provenance/measurements.json),
[raw RPC](experiments/metric-provenance/rpc-captures.json),
[native inputs/outputs](experiments/metric-provenance/native-replays.json) and
[report](experiments/metric-provenance/report.md) record the actual experiment.

Measured examples: repeated reads plus absence yield 4 footprint keys and zero
disk bytes; no-op write yields 1 RW entry / 80 bytes; deletion yields 1 RW entry /
zero bytes; SAC balance reads 144 classic Account XDR bytes; one event plus return
yields 96 bytes, while a larger return without events yields 652 bytes. These
values apply to the saved fixture/environment, not every Soroban project.

The explicit experiment `tests/experiments/verify-metric-provenance.cjs` builds
an isolated SDK-28 contract with the official Stellar build path, deploys it and
a native Stellar Asset Contract, runs production measurement, and records raw
RPC and native input/output. Observers forward the original IO unchanged.
The production reference contract is not edited.

Run from a repository checkout with the verified Stellar CLI on PATH and an isolated pinned quickstart
network on port 18000:

```bash
npm ci
npm run build
npm run build:helper
node tests/experiments/verify-metric-provenance.cjs /tmp/weighin-metric-evidence
npm test
npm run test:native
npm run bundle
node tests/experiments/verify-build-path.cjs /tmp/weighin-full-action-evidence
```

The live fixture covers repeated reads and queried absence, no-op writes,
deletion, positive classic-account disk reads through SAC balance, events, and
a larger return with no events. It verifies all six promoted consumption fields
directly against the parity-accepted raw simulateTransaction response and checks
the loaded caps. Private deployer keys remain in temporary directories.
Frozen-evidence tests independently replay the captured helper inputs; frozen
replay establishes snapshot repeatability, not broader live/build determinism.

## Final Action and CLI proof

[Final Action verification](experiments/metric-provenance/action/verification.json)
uses real Git fetch/worktrees and source builds with a strict write-byte policy.
Control exits 0. Temporary persistent-write HEAD changes WASM/runtime address,
still matches the configured benchmark, increases write bytes 0 → 88 and exits 1.
CPU also increases 266842 → 309171. The Action uses a shared build cache; this is
not five-clean-build or public GitHub CI proof.

```bash
WEIGHIN_EXPERIMENT_POLICY_METRIC=ledger_write_bytes node tests/experiments/verify-build-path.cjs /tmp/weighin-write-policy-proof
```

[CLI results](experiments/metric-provenance/cli-results.json) and
[process capture](experiments/metric-provenance/cli-process.json) show the production
CLI exits 0 and emits six schema-4 measurements with SDK 28.0.0 on the real network.
[Validation](experiments/metric-provenance/validation.json) records final gates;
[operational/test failures](experiments/metric-provenance/validation-failures.json)
record failed attempts and recovery. The proof network was stopped afterward.

These original source/build/data records are local evidence. Subsequent
[repeatability](repeatability.md), [fixture migration](fixture-migration.md),
[local external-project evidence](external-soroban-forge.md) and
[hosted comparison proof](EVIDENCE.md) are recorded separately with their own
producer identities. They do not change the provenance of these earlier records.
