# Architecture

WeighIn consists of a TypeScript GitHub Action, a measurement CLI/API, and a
protocol-matched Rust simulation helper. The Action compares configured
benchmarks between a fetched BASE revision and its existing HEAD checkout.
The CLI only measures existing WASMs. [Evidence](EVIDENCE.md) records tested
behavior; [limitations](KNOWN_LIMITATIONS.md) defines the supported scope.

## Entry point and configuration

`action.yml` executes `bundled/index.js` on Node 24. `src/action.ts::run` reads
the declared inputs, resolves the existing GitHub workspace/cwd, and loads HEAD's
policy from the configured TOML path (default `weighin.toml`). Missing optional
policy means report-only. `loadConfig` validates known configuration keys/types;
`validateConfig` rejects malformed/nonfinite/negative rules before measuring.
Fixtures are parsed by `src/identity.ts::parseFixtures`, not the older generic
fixture schema exported from `src/config.ts`.

The Action validates `base-ref` as a branch, tag, or commit SHA before network
checks, builds, or deployment. Empty, whitespace-padded, option-like and invalid
Git ref values fail with an input diagnostic. HEAD is built and measured first.
BASE defaults to the PR base branch, otherwise `main`, or the supplied `base-ref`.
The Action fetches that ref from `origin` with depth 1, then creates a detached
worktree at `FETCH_HEAD`. This is not a merge-base calculation. BASE reads its own
fixture file at the same relative path and builds and measures its own declarations. HEAD policy governs the resulting diff unless
the caller opts into `trusted-policy-ref`/`trusted-policy-path`. In that mode
the action reads the exact resolved commit from `origin`, validates it before
measurement, and reports its revision and content hash; HEAD cannot replace it.
The BASE worktree is removed in `finally`; HEAD remains the caller's checkout.

## Contract build selection

`src/build-selection.ts` locates owning Cargo manifests from fixture paths,
reads locked Cargo workspace metadata, and selects uniquely matching workspace
cdylib packages by normalized WASM basename. Multiple declarations of a selected
package share a build. Unknown/ambiguous packages fail before compilation.

`src/build.ts::buildContracts` uses locked optimized `stellar contract build`
with a fresh output directory, producing the modern `wasm32v1-none` artifact.
The builder verifies CLI/Rust gates, optimization, pre/post temporary-storage
write/fsync/read probes and fresh WASM headers before copying to declared paths.
Actual tool versions/artifact hashes are logged. Per-revision Rustup resolution
is preserved unless `rust-toolchain` supplies `RUSTUP_TOOLCHAIN`.

A custom shell command runs in each revision instead, or `skip-build: true`
consumes prebuilt artifacts. These modes bypass default build guarantees; they
cannot be selected together. The [build document](contract-build.md) describes
the tested versions and storage bounds. The reference's temporary historical
path alias receives modern bytes; it does not compile the obsolete target.

## Two distinct identities

### Logical identity

`parseFixtures` derives the structured tuple:

```text
(fixture_id, logical_id, function_name, case_id)
```

Fixture/contract/invocation `id` fields provide explicit scoped identities.
Fallbacks are normalized workspace-relative fixture path, full fixture-relative
WASM path, and canonical typed arguments. Top-level argument type names are
lowercased; object keys are sorted; array order and values matter. Duplicate
identities fail. Reports use logical fixture/contract/function/case labels.
An explicit ID is the caller's assertion of continuity across revisions.

### Deployment/runtime identity

`src/measurement.ts::runMeasurement` hashes the WASM. That hash determines the
deployment salt; the address also depends on the deployer and standalone network
ID. The same WASM may reuse a deployment; changed WASM can change the address.
Upload and creation transactions are real submitted transactions. A generated
private deployer key is shared across BASE/HEAD in a private temporary file.
Submission classifies the RPC `sendTransaction` status before polling: `ERROR`
and `TRY_AGAIN_LATER` fail immediately (no confirmation poll, no dependent
upload/create step, and no hidden resubmission); `PENDING` or `DUPLICATE` with a
valid hash use the existing confirmation path and must still confirm `SUCCESS`;
any other or hash-less response fails closed. Failure diagnostics name the phase,
status and hash instead of serializing the signed envelope or transaction result.
`src/account.ts::ensureAccountReady` checks RPC account inclusion and uses local
Friendbot when necessary. The current path assumes the standalone passphrase.

`src/endpoint.ts` is the shared diagnostic policy for the configured endpoint.
CLI, Action and transport (`src/account.ts`, `src/simulation.ts`) diagnostics run
URLs through it: scheme/host/port/path are preserved, userinfo is stripped, query
values are redacted while keys remain, and fragments are dropped. Malformed input
becomes `[invalid endpoint]`. The sanitized form is display-only; requests always
use the configured endpoint unchanged.

Measurement records retain `wasm_sha256`, runtime `contract_id`, revision SHA and
logical identities separately. Runtime addresses are diagnostics, not the diff
key. `diffBenchmarks` therefore pairs changed WASM/address cases correctly without
silently treating unrelated contracts as the same. See [identity](comparison-identity.md).

## Simulation and resource extraction

Each fixture invocation is converted to ScVals and sent to RPC simulation;
benchmark invocation writes are not submitted or carried into subsequent cases.
`src/simulation.ts::measureInvocation` captures the invocation's footprint and
network configuration at the reported ledger, checks a matching ledger header,
and requires every capture batch to agree. Discovered keys trigger recapture;
ledger drift/incomplete state must resolve within 30 attempts. The exact observed
captive-core JSON-RPC 404 has three bounded retries; arbitrary RPC errors do not.

The adapter provisions the packaged helper source with pinned Rust 1.95.0 and
locked official `soroban-simulation`/`soroban-env-host` 28.0.1 dependencies, or
validates an explicit executable override. Default support is Linux x64,
protocol 28. The helper consumes immutable entries/config/header, recording auth
and a zero seed, and returns consumed native CPU/memory plus resources/XDR.
Archived entries and invalid/missing state fail.

The adapter requires full transaction-data XDR, return ScVal and ordered
successful non-diagnostic event parity with RPC. RPC does not expose direct
consumed CPU/memory. The helper's consumed cost-model values supply compute;
RPC/native resource data supplies audited IO/events. No adjusted instruction
budget is substituted for consumption.

`src/measurement.ts::metricsFromSimulation` emits schema 5: eight measured resource fields and three
unavailable fields with null values/reasons. Per-metric source/cap labels are
validated against approved mappings. Caps are decoded from the same
captured configuration; event count has no independent cap. Exact definitions
and source locations are in [metric provenance](metric-provenance.md).

Provenance records helper/library/network/protocol identities, seed/auth/features,
ledger, input/header/snapshot/full-config hashes, compute calibration and resource
limit hashes. Different invocation snapshots may use different ledgers. This
records environment differences; it does not freeze state across the suite.

The provenance also records the invoking source account. `src/measurement.ts`
accepts an optional `invocationSourceAccount` for a single measured run, and
`src/source-account.ts::measureSourceAccountEffects` measures one case under
several source accounts while code, arguments, protocol, calibration and
resource limits stay fixed. It refuses to report an effect when any held-fixed
value differs and states whether the results stay comparable across accounts.
See [source-account effects](source-account-effects.md).

## Diff and policy

`src/record-schema.ts` provides the authoritative versioned schema and standalone
runtime validator (`validateMeasurementRecord`, `validateMeasurementRecords`,
`inspectMeasurementRecords`, and `getMeasurementRecordJsonSchema`) for saved
measurement envelopes (`legacy`, `2`, `3`, `4`, and `5`; see
[record schema](record-schema.md)). `src/diff.ts::diffBenchmarks` delegates record
validation to `src/record-schema.ts`, validating all records including unmatched
ones. Contracts pair by fixture/logical identity, invocations by function/case
identity. It requires equal schemas and compatible compute/resource/source
semantics. Ledger/full-config metadata can change while comparable calibration/caps
remain constant. Mixed historical/current schemas fail explicitly; legacy records
only retain their legacy runtime-address matching against other legacy records.

Comparable deltas are HEAD minus BASE. Positive values mark regressions;
negative values mark improvements. A zero baseline has null percentage, not an
invented finite percentage. Unavailable comparisons have null delta/percentage
and a reason. New/removed contracts/cases are listed separately. The Action
requires at least one matched benchmark, even with no thresholds.

`src/threshold.ts::enforceThresholds` applies HEAD's validated per-function and
global relative rules and absolute HEAD caps. Per-function rules affect every
matching case of that function. Requiring an unavailable metric, exceeding a
cap/relative rule, or configuring a nonignored unmatched function is a failure.
Explicit `ignore` opts out. Numeric caps equal to HEAD consumption pass.

## Reporting and Action outcome

`src/comment.ts::renderComment` renders logical identities, both runtime addresses,
metric sources/caps, both revisions' provenance, deltas, additions/removals and
violations. `src/report.ts` writes optional Markdown and PR metadata; metadata
is written only for PR events. The same report goes to `GITHUB_STEP_SUMMARY`.

The Markdown report is delivered atomically. `src/report.ts` writes the complete
body to a temporary file it creates exclusively (`O_CREAT | O_EXCL`) in the
destination directory, closes that handle and renames the temporary file over
the destination. The destination is therefore replaced only after a complete
write, so a failed or interrupted delivery keeps a previously published report
and never publishes a partial one. Cleanup removes only the temporary file the
failing run created; a concurrent writer's temporary file is never touched. A
cleanup failure is reported as a warning and never masks the original write or
rename error.

The PR metadata artifact is versioned (`src/pr-metadata.ts`). The producer writes
`schemaVersion`, the base `repository`, `prNumber` and `headSha`; a fork PR still
records the base repository. The consumer validates the version, repository
(case-insensitively against its trusted `github.context.repo`), positive integer
PR number and 40-character hexadecimal SHA before any API mutation. Legacy
unversioned metadata is explicitly rejected rather than inferred, so producer and
consumer versions must be paired.

The Action emits `result` and `diff-json` before failing a valid policy violation.
It retains a validated diff if a later report-file or job-summary write fails,
while preserving the delivery error as the failure diagnostic. Failures before a
valid comparison emit `fail` and `{}`; they never reuse a diff from another run.
There is no successful no-baseline fallback. Optional direct-comment failure is
warning-only.

The separate `comment/` Action runs `bundled/comment-action.js`, reads and
validates downloaded report/PR metadata, and creates or updates the comment
carrying `<!-- weighin-report -->`. It fails on missing artifacts, invalid
metadata or API failure. The example consumer runs only after successful PR
producers, on trusted default-branch workflow code; it does not execute
downloaded PR code. Failed policy reports remain in producer artifacts and
summaries. Hosted expected-negative proof jobs separately assert genuine Action
exit 1, then finish green once verified.
