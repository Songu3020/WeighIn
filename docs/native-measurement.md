# Native simulation measurement (schema 4)

WeighIn now measures consumed CPU and memory with the official
`soroban-simulation` / `soroban-env-host` 28.0.1 libraries. The initial supported
runtime is **Linux x64, protocol 28, standalone local network**. This is a scoped
compatibility path, not support for every network/protocol/fixture.

## Provisioning

Install Rust 1.95.0 and native Rust build prerequisites. The Action and CLI build
the shipped helper sources once per process using a pinned Cargo.lock:

```bash
npm ci
npm run build
npm run build:helper
npm test
npm run test:native
npm run bundle
```

The helper is not embedded in the JavaScript bundle. The Action checkout and npm
package include `native/simulation/Cargo.toml`, `Cargo.lock`, and `src/`. Default
provisioning invokes `cargo +1.95.0 build --release --locked` with an explicit
native target directory and `--target x86_64-unknown-linux-gnu`. Its standalone
Cargo workspace prevents it from joining a caller's contract workspace. Cargo, its toolchain and dependency access must exist;
WeighIn does not install them. On GitHub, the Action sources reside beside its
bundle, independently of the caller's workspace or base worktree.

For an already-built compatible executable, set `WEIGHIN_HELPER_PATH` to its
absolute path, or use `helperPath` in `runMeasurement` options. Overrides are
validated for executable access and versioned output; the binary's SHA256 is
recorded. Missing binaries, malformed output, host failures and unsupported
protocols produce errors, not measurements containing zero.

Helper executable identity is strictly bound to actual execution: the executable
file's content SHA256 is captured before invocation, re-verified immediately after
process termination, validated across retry attempts, and checked before emitting
provenance. If the binary is replaced, mutated, or modified during or across execution,
measurement fails fast with an explicit error. Remaining filesystem trust assumptions:
WeighIn relies on standard OS filesystem access controls and assumes the host storage
hosting the binary is not subject to in-flight inode replacement or unauthorized write
mutation by concurrent untrusted local processes outside Node's process space.

The local network script and workflow example pin the exact protocol-28 image
used in the proof. The Action's modern contract build now uses the
[Stellar build path](contract-build.md), with its own verified reference and
explicit migration limitations.

CLI example, after building a contract and provisioning RPC:

During the reference's temporary [fixture migration](fixture-migration.md), use
the shared builder to prepare both declared destinations before this CLI command.
The Action already does so; the CLI consumes existing WASMs.

```bash
node dist/cli.js weighin-fixtures.json --rpc-url http://localhost:8000/rpc --output weighin-results.json
```

The CLI writes measurement JSON and exits 1 on measurement failure. It remains a
measurement command; threshold comparison is performed by the Action.

## WASM artifact preflight and resolution

Before establishing RPC connections, initializing deployer accounts, or submitting upload/deployment transactions, WeighIn validates every declared contract WASM artifact upfront across all declared fixtures:

- **Existence & regular file**: The declared WASM path relative to the fixtures directory must exist and be a regular file (`stat.isFile()`). Directories, symlinks pointing to non-files, or missing paths fail.
- **WASM binary magic header**: The file must begin with the 8-byte WebAssembly binary magic number and version (`\0asm\x01\x00\x00\x00`). Truncated or non-WASM files are rejected immediately.
- **Multi-error aggregation**: When multiple declared WASMs are invalid across one or more contracts, WeighIn aggregates all validation failures into a single contextual error listing `[fixtureId / contractLabel]`, failing closed before funding accounts.
- **Strict target resolution**: Cross-target substitution (e.g., falling back to `wasm32-unknown-unknown` when `wasm32v1-none` is declared) is disabled by default. If a declared path is missing, measurement fails immediately. To opt in explicitly, pass `--allow-cross-target-substitution` in the CLI, `allow-cross-target-substitution: true` in the Action, or set `WEIGHIN_ALLOW_CROSS_TARGET_SUBSTITUTION=true`.

## Source and immutable state

CPU comes directly from `simulated_instructions`; memory from `simulated_memory`.
They are consumed Soroban cost-model units, not submission budgets, hardware
instruction counts or process RSS. Compute limits come from the same captured
network configuration. No RPC instruction-budget substitution is used.
Measured transactions must match the captured RPC endpoint's network passphrase;
mismatched networks fail immediately before any simulation or helper execution.

The adapter captures all footprint keys plus network config, ledger data,
extensions, last-modified sequence, TTL metadata and explicitly queried absence.
Read-only and read-write footprint keys from both RPC simulation and the native helper
are strictly validated for uniqueness and mutual disjointness before counting resources
or executing simulations; duplicate keys or read/write overlaps fail immediately with an explicit error.
Every required network configuration setting is identified and verified before
native helper execution; missing configuration entries fail immediately with a
bounded list of missing setting names and are not retried as ordinary ledger drift.
Batches must share the simulation's reported ledger. Header retrieval requires
exactly one matching sequence row for the captured ledger with a well-formed
history entry; ambiguous duplicate headers or malformed entry XDR are rejected,
while unrelated valid page rows are accepted according to the RPC contract.
The history-entry hash is strictly validated against the canonical SHA-256 digest of
decoded header bytes and any returned RPC row hash, rejecting corrupted or mismatched entries before native execution.
It verifies the matching ledger header, retries the entire capture on drift,
and expands discovered keys when the helper reports an uncaptured read. After 30
attempts, incomplete/drifting state is an error. This uses current-state RPC APIs;
it is not a historical-state reader.

For the observed `getLedgerEntries` JSON-RPC error `-32603` with message
`could not query captive core: http request failed with non-200 status code (404)`,
the adapter allows three retries per invocation, waiting 250, 500 and 1000 ms.
Each retry logs the failure, discards all partial rows and starts again with a
fresh RPC simulation. Retries share the existing 30-capture budget; they do not
extend it. A fourth matching failure, or reaching that budget, fails measurement.
Other RPC errors, HTTP errors, timeouts, malformed data and helper/parity failures
retain their failure behavior. This narrow handling does not repair captive core
or guarantee network availability. No measurement schema or policy changes.
See the [recovery tests and live rerun](snapshot-recovery.md).

Host settings match the proven RPC configuration: protocol 28, host features
`recording_mode` and `testutils`, auth mode `recording(true,true)`, and a fixed
32-byte zero seed. Entire helper transaction-data XDR, return value and successful
non-diagnostic events must match RPC at the captured ledger. This corroborates state/resources; RPC still exposes
no direct consumed CPU/memory values. Random-dependent or auth-dependent fixtures
that disagree fail explicitly. Archived state is unsupported. Invocation writes
are simulated and discarded; upload/deployment transactions are submitted.

BASE and HEAD can be captured at different ledgers. The diff requires matching
helper binary, library, protocol, network, compute cost/limit/TTL configuration, seed, auth mode
and host features, plus audited resource caps and metric source/limit semantics. Fee-only live-state-size windows can change between ledgers; their complete
config hashes remain diagnostics and are shown for both revisions. They do not
change the consumed compute calibration. It records both snapshot ledgers/hashes. It does not guarantee
that arbitrary live contract state remains unchanged between captures.

## Cancellation lifecycle

Measurement and helper operations accept an optional `signal?: AbortSignal` across all phases:

- **Account and network readiness**: `ensureAccountReady` and `getOrInitAccount` check cancellation before and during polling. Readiness retry backoffs listen to `signal` to abort immediately rather than waiting for remaining sleep durations.
- **RPC calls and polling**: `callRpc`, `waitForTransaction`, and `submitAndConfirm` link the caller's cancellation signal with internal timeouts via `AbortSignal.any`. Polling intervals abort promptly on signal trigger.
- **Native helper execution**: `simulateSnapshot` and `execute` pass `signal` to Node's `execFile`, which terminates the spawned native helper child process promptly (`SIGTERM` / `SIGKILL`) on abort.
- **Simulation and transient recovery**: `measureInvocation` aborts transient captive-core retry delays immediately upon cancellation and halts retry loops.
- **Resource protection**: Caller-provided key files (`keyFile`) are preserved on cancellation; temporary deployment keys and scratch files are cleaned up.
- **Fail-closed guarantees**: Cancelled measurements throw explicit cancellation errors (`AbortError`) and never produce synthetic zero or fallback benchmarks.

## Schema migration

`ContractBenchmark.schema_version` is now **4**. See the
[metric audit and migration](metric-provenance.md) for the complete mapping. The stable comparison tuple from
schema 2 remains `(fixture_id, logical_id, function_name, case_id)`; runtime
`contract_id` and WASM hash remain diagnostics.

Each metric has explicit availability:

```json
{"availability":"measured","consumed":270219,"limit":400000000,"source":"soroban-simulation.simulated_instructions","limit_source":"ConfigSettingContractComputeV0.txMaxInstructions"}
```

```json
{"availability":"unavailable","consumed":null,"limit":null,"reason":"No verified consumption source"}
```

CPU, memory, RO+RW footprint entries, disk read bytes, RW footprint entries,
write bytes, successful contract/system event count and encoded events plus return
bytes are measured on the audited path. Historical read bytes, instance-only size
and signed transaction size remain unavailable. Event count has no independent
network cap: its measured value has `limit: null` and `limit_reason`. Other measured
metrics provide `limit_source` from captured configuration. These meanings are
spelled out in the metric audit; footprint counts are not host-call counts.

Consumers must handle null consumption/limits. Diff records expose
`availability: comparable | unavailable`; unavailable comparisons have null
`delta`/`pct` and a reason, with no invented improvement/regression.
A measured zero is still a valid comparable zero. Benchmark provenance includes
library/host identity, binary/network/config/header/snapshot/input hashes,
ledger, seed and auth settings, plus a resource-limit hash. Diff/report records retain BASE and HEAD provenance.

Existing schema-2 results can compare with other schema-2 results, and legacy
results retain their old runtime matching. Schema 2 is never silently compared
with newer schemas: earlier numeric fields do not establish the same source semantics.
Schema-3 records retain their existing behavior when compared to schema 3; mixing
schema 3 and 4 fails explicitly.
Unmatched records are validated too. New/removed benchmark behavior is unchanged.

## Policies and reports

A configured rule for an unavailable metric returns a violation with null delta
and an explicit inability-to-evaluate message. `ignore` explicitly opts out.
Global `fail_on_any_regression` requires availability for all nonignored metrics,
so it currently fails on the three unsupported metrics unless explicitly ignored. Use targeted rules
when that is the intended policy:

```toml
[thresholds.functions.hello]
cpu_instructions = "strict_zero_tolerance"
memory_bytes = "allow_10_percent_increase"
```

The Action publishes diff JSON and result outputs, writes a Markdown job summary
when `GITHUB_STEP_SUMMARY` is provided, and optionally posts the existing PR
comment when a token is supplied. A valid comparison with violations exits 1.
Baseline checkout, build, fixture and measurement failures now return `fail` and
exit 1. The former successful `no-baseline` result has been removed. The Action
requires at least one matched benchmark, even without a threshold file; entirely
new/removed suites cannot establish a passing comparison. Individual additions
and removals remain visible when other benchmarks match. Missing optional config
still means no thresholds, but does not waive the comparison requirement.

Existing config files are validated before measurement: unknown keys/rules, wrong
types, negative/nonfinite caps and malformed percentages fail. A nonignored
function policy without any matched case fails explicitly. `ignore` is an opt-out;
it does not establish a comparison. Valid numeric caps and named decimal caps
remain supported. Downstream consumers must treat `fail` with `{}` diff JSON as
an unsuccessful comparison, not a passing report. Error job summaries explain
that no passing comparison/policy result was established.

See [Stage 1C proof](experiments/fail-closed/verification.json). The local live
harness also injects checkout/worktree/build failures, removes BASE fixtures/WASM,
and supplies an invalid policy. Every case exits 1 using the actual bundled
Action. Infrastructure failures are deliberately injected; successful measurement
uses real RPC/native meters. Unsupported schemas and malformed provenance are
covered by orchestration unit tests with controlled dependency results.

## Evidence

See [integration evidence](experiments/native-integration/verification.json),
[the regression report](experiments/native-integration/report.md), and the explicit
live harness `tests/experiments/verify-integration.cjs`.

The historical schema-3 evidence below remains unchanged. Current schema-4 proof
and raw IO/event verification are linked from the metric audit.

The harness runs genuine prebuilt bundled-contract BASE/temporary persistent-write
HEAD WASMs through production measurement, native simulation, diff and policies.
It checks CLI serialization and launches the actual bundled Action as separate
processes: unchanged control passes, measured CPU regression fails, and a policy
requiring an unavailable metric fails. Checkout/contract-build commands are
isolated infrastructure stubs; no RPC or metric response is fabricated. It sends
no GitHub comments. This proves the local Action process exit path, not a public
GitHub workflow run or the default contract build path.

Reproduce after building genuine control/regression WASMs and starting an isolated
pinned network on port 18000:

```bash
npm run build
npm run bundle
node tests/experiments/verify-integration.cjs /absolute/base.wasm /absolute/head.wasm /tmp/weighin-integration-evidence
```

The temporary HEAD preserves `hello(Env, Symbol)` and adds a persistent write
before its unchanged return. Private deployer keys remain in temporary directories
and are never copied into evidence. Frozen-snapshot native tests replay the prior
captured proof offline; they do not establish clean-build/live-network determinism.
