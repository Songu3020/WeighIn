# Cross-contract nested invocation attribution proof

This document records the live proof for issue #233: cross-contract resource
attribution measured through a real nested caller/callee Soroban host
invocation. It shows how the combined footprint, charged events and return value
are attributed across two contracts inside one top-level transaction, and how
runtime identity, native/RPC parity, an address-swapped control, a callee-only
regression, failure classification and archived-state rejection behave.

## Fixture design

The workspace in
[`tests/fixtures/nested-invocation/`](../tests/fixtures/nested-invocation/Cargo.toml)
builds two deterministic contracts with the pinned toolchain and the official
CLI:

- [`nested-callee`](../tests/fixtures/nested-invocation/callee/src/lib.rs)
  exposes `work(rounds) -> u32`, a bounded read-modify-write of one persistent
  counter that emits exactly one `work` event, plus `boom`, an application
  failure anchor.
- [`nested-caller`](../tests/fixtures/nested-invocation/caller/src/lib.rs)
  exposes `run(callee, rounds) -> Vec<u32>`, which performs one caller-side
  persistent write, one real nested host call into the callee `Address`, and
  emits exactly one `caller` event, plus `run_failing(callee)`.

The caller has **no compile-time dependency on the callee crate**. Its client is
a self-contained module that performs the nested call with
`Env::invoke_contract`, so the callee is reached purely through its runtime
address. This is what makes the callee-only regression below able to change the
callee WASM while leaving the caller WASM, hash and runtime address untouched.

Because the callee address is only known at runtime, the proof uses a two-pass
measurement: pass one deploys and measures the callee alone, pass two substitutes
the deployed address into the caller fixture token
`{{NESTED_CALLEE_ADDRESS}}` and measures the nested invocation. Pairing relies on
explicit invocation identities (`id:nested-invocation-suite`, `id:callee`,
`id:caller`, `id:work-once`, `id:nested-work`, `id:nested-failure`) rather than
addresses, which change between revisions and deployers.

## Combined footprint

One nested invocation is charged as a single top-level transaction. Its
footprint is exactly the callee footprint plus the caller's code, contract
instance and single storage key.

| Footprint element | Callee alone | Nested (caller → callee) |
|---|---:|---:|
| Code entries | 1 (`nested-callee`) | 2 (`nested-callee`, `nested-caller`) |
| Contract instance entries | 1 | 2 |
| Read-write storage entries | 1 (`counter`) | 2 (`counter`, caller `last`) |
| RO + RW footprint entries | 3 | 6 |
| Write footprint entries | 1 | 2 |
| Disk read bytes | 0 | 0 |

The nested snapshot reuses all three callee footprint keys unchanged and adds
exactly three caller keys. Live Soroban contract reads contribute zero disk read
bytes, so `ledger_read_bytes` is a measured zero, not an unavailable metric.

## Event and return attribution

The nested transaction charges exactly two events in callee-then-caller order.
The callee event is byte-identical to the event captured by the standalone
callee measurement, and each event's `contractId` resolves to the emitting
contract. `events_count` is `2` with a `null` limit and the reason "Protocol 28
has no independent event-count cap". `event_data_bytes` is the encoded charged
events plus the returned `ScVal`.

| Metric | Callee alone | Nested |
|---|---:|---:|
| Charged events | 1 (`work`) | 2 (`work`, `caller`) |
| Events + return XDR bytes | 80 | 168 |
| CPU cost-model instructions | 337,065 | 674,626 |
| Memory cost-model bytes | 1,195,786 | 2,393,762 |

The three unavailable metrics (`historical_data_read_bytes`,
`contract_data_hard_limit`, `tx_size_bytes`) stay `null` with reasons.

## Native / RPC parity

For the nested invocation the native replay is linked by reported
`input_sha256`, and the raw RPC response is linked by `latestLedger`, transaction
data and host function XDR. Transaction data, returned value and the ordered
charged events agree exactly. Six promoted metrics (`ledger_read_entries`,
`ledger_read_bytes`, `ledger_write_entries`, `ledger_write_bytes`,
`events_count`, `event_data_bytes`) are verified against the raw RPC resources
and results; consumed CPU and memory have no direct RPC resource and are taken
from the official native cost model.

## Controls

**Address-swapped control.** A second funded deployer measures the same fixtures
at different runtime addresses. Pairing by explicit identity still succeeds:
both contracts report eight comparable metrics each with zero deltas, while the
runtime contract IDs and the materialized callee address argument differ.

**Callee-only regression.** A callee variant with one extra persistent audit
write per round changes only the callee WASM
(`7a889934…` → `67c62ccf…`). The caller WASM (`de34030d…`) and its runtime
address (`CDDW2K52…`) are unchanged. The regression is attributed to both the
callee's own case and the measured nested caller case:

| Case | CPU delta | Write bytes delta | Write entries delta |
|---|---:|---:|---:|
| `id:callee / work / id:work-once` | +28,882 | +80 | +1 |
| `id:caller / run / id:nested-work` | +29,329 | +80 | +1 |

A strict zero-tolerance CPU policy produces exactly the two expected violations
([`violations.json`](experiments/nested-invocation/violations.json),
[`report.md`](experiments/nested-invocation/report.md)).

**Failure classification.** Three distinct classes are retained: an application
failure (the nested `boom` trap surfaced by RPC as
`Simulation failed for run_failing: …`), an invalid-input failure raised while
converting the address argument before any simulation, and an infrastructure
failure raised after a successful simulation when the native helper is missing
(`Simulation helper missing or not executable`).

**Archived-state control.** Expiring the captured callee instance entry
(`live_until = header_ledger − 1`) makes the native helper exit `1` with
`archived ledger state is unsupported` instead of inventing a measurement.

## Environment

| Setting | Value |
|---|---|
| Node | v24.14.0 (linux-x64) |
| Stellar CLI | 28.1.0 |
| rustc | 1.95.0 (pinned by `rust-toolchain.toml`) |
| Contract SDK | 28.0.0 |
| soroban-simulation / host | 28.0.1 |
| Network | protocol 28, `Standalone Network ; February 2017` |
| Quickstart image | `stellar/quickstart@sha256:4c8bad1e…` |

The pinned `rust-toolchain.toml` is copied next to the script's working
directory so the pinned toolchain is always resolved; an unpinned default
toolchain recompiles different WASM bytes and is asserted against.

## Evidence and automated verification

The sanitized records are retained in
[`docs/experiments/nested-invocation/`](experiments/nested-invocation/verification.json):

- `measurements.json`, `rpc-captures.json`, `native-replays.json`: base, control
  and head measurements with raw RPC captures and native replays.
- `control-diff.json`, `regression-diff.json`, `violations.json`, `report.md`:
  the unchanged control, the callee-only regression and its policy violations.
- `failure-probes.json`, `archive-control.json`: failure classification and the
  archived-state rejection.
- `environment.json`, `verification.json`, `sha256.json`: environment, the
  pass/fail audit and the integrity manifest.
- `nested-callee.wasm`, `nested-caller.wasm`, `nested-callee-regression.wasm`
  and the fixture sources and manifests.

Behavior tests are in
[`tests/nested-invocation.test.cjs`](../tests/nested-invocation.test.cjs) and
native replay tests in
[`tests/native/nested-invocation.test.cjs`](../tests/native/nested-invocation.test.cjs).

## Scope

Soroban charges the resources of a nested call to the single top-level
transaction, so this proof attributes the **combined** footprint, the charged
events and the return value per contract; it does not fabricate a per-contract
split of consumed CPU, memory or bytes. Results are simulation-only (recording
auth, fixed seed), tied to the pinned environment above, and do not prove signed
production authorization. See [known limitations](KNOWN_LIMITATIONS.md) and
[metric provenance](metric-provenance.md).
