# Clean-build and live measurement repeatability

This experiment tests the supported Linux x64/protocol-28 standalone path.
It uses Rust 1.95.0, official checksum-verified Stellar CLI 28.1.0, the locked
Soroban SDK 28.0.0 reference project, JavaScript Stellar SDK 16.0.1 and native
simulation/host 28.0.1.
It measures Soroban cost-model resources, not hardware CPU/RSS or wall time.

## Observed result — 2026-10-08

**Scoped repeatability passed:** five independent clean reference builds and
35 live measurements (seven cases, five samples each). All eight measured
metrics had range and population standard deviation zero for every case. Strict
policies produced zero violations with the three unavailable metrics explicitly
ignored. No production measurement or comparison behavior was changed.

All five reference artifacts were 776 bytes with SHA256
`718ba18378a2d94ec7bf0c75b3813c7d0bb5b65beb2fb4c445b3a4726ecd5668`.
The copied input snapshot SHA256 was
`9b8f8aa35dba73f8997e90fcec0626cd281fd8a9636a891c489e22ae3f35d654`.
Clean build durations were 64.438, 64.512, 64.967, 65.816 and 65.109 seconds;
these are diagnostics, not Soroban resource consumption.

Each row below had these exact values in all five samples:

| Case | CPU | Memory bytes | RO+RW entries | Disk read bytes | RW entries | Write bytes | Events | Events+return bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Reference hello | 266842 | 1123942 | 2 | 0 | 0 | 0 | 0 | 44 |
| Repeated/missing read | 420956 | 1207550 | 4 | 0 | 0 | 0 | 0 | 20 |
| No-op write | 400277 | 1207158 | 3 | 0 | 1 | 80 | 0 | 20 |
| Delete | 385991 | 1205909 | 3 | 0 | 1 | 0 | 0 | 20 |
| Event | 375269 | 1205751 | 2 | 0 | 0 | 0 | 1 | 96 |
| Classic account read | 454136 | 1215233 | 4 | 144 | 0 | 0 | 0 | 20 |
| Large return | 611669 | 1240926 | 2 | 0 | 0 | 0 | 0 | 652 |

Snapshots spanned ledgers 833–1101. Every case had five distinct snapshot and
full-configuration hashes, while compute-calibration and resource-limit hashes
remained constant. Therefore advancing ledger/config metadata did not introduce
measured resource noise in these fixtures. This does not prove arbitrary state
or ledger/time changes are harmless; see the [controlled ledger-dependent variation proof](ledger-variation.md)
for an unchanged-WASM contract whose resources vary with ledger sequence/time.

An earlier real RPC failure remains an operational limitation, detailed below.
The successful five-sample series establishes repeatable measurements conditional
on successful capture; it does not establish failure-free network operation.

Final checks passed: `npm ci`, `npm test` (101 tests), `npm run test:native`
(15 tests), `npm run build`, `npm run bundle`, `npm pack --dry-run --json`,
native `cargo fmt --check` and `git diff --check`. At that experiment snapshot no lint/typecheck scripts existed and audit reported
one moderate/four high. Current scripts and the dated dependency audit are in
[CONTRIBUTING](../CONTRIBUTING.md) and [dependency security](DEPENDENCY_SECURITY.md). Packaging proves inclusion only, not clean installation.
The helper binary's hash remained unchanged after validation; saved evidence was
checked for private account seeds. The isolated proof container was stopped.

## What is held constant

The reference source, Cargo manifest/lockfile, toolchain and fixture files are
copied byte-for-byte into five independent work directories. Their individual
SHA256 values and a combined source-snapshot hash are recorded. The repository
HEAD is recorded separately: this recorded experiment used an uncommitted working-tree
snapshot, so its contents must not be inferred from that Git SHA alone.

Each reference build starts with a newly created, verified-empty Cargo target
directory. It uses production `buildContracts`, which selects the configured
package and invokes `stellar contract build --locked --optimize=true` into a
fresh output directory. Rust/compiler wrappers and incremental compilation are
disabled for this experiment; build jobs are fixed at two. `RUSTFLAGS` and
`CARGO_ENCODED_RUSTFLAGS` are unset: even an empty `RUSTFLAGS` disables the
Stellar CLI's dependency-path remapping. Cargo runs offline
against already downloaded, locked dependency sources. Downloaded source reuse
is allowed; compiled artifacts are not reused between the five reference builds.
Only experiment-owned target directories are removed after each sample.

All measurements use production `runMeasurement` on one pinned protocol-28
network, one funded source account, one native helper binary, the same arguments
and stable logical identities. The native helper was built once and reused;
this is not a claim of five clean helper builds. Upload/deployment transactions
are real; benchmark invocation writes are simulated and discarded. Identical
WASM may reuse the existing deployment, keeping the runtime/state constant.

## Two distinct sets of samples

1. **Reference:** five clean source builds followed by live `hello(world)`
   measurements. Both artifact equality and all eight supported metrics are
   compared. The reference does not exercise nonzero writes or emitted events.
2. **Audit fixture:** five live cycles of the previously verified six-case WASM.
   It covers repeated/missing reads, no-op writes, deletion, emitted event,
   classic-account reads through SAC balance and a larger return. Its WASM is
   reused, SHA256-verified against Stage 3 and saved separately. This is live
   metric repeatability evidence, **not five clean builds of the audit contract**.

The owner account is funded for this network. The native SAC is created if
absent; this series reuses the SAC created during an earlier recorded attempt.
Its address arguments remain constant for all five cycles. Deployment
and warm-up are captured separately and excluded from the five samples.
The same network continues advancing; it is not reset between runs.

## What is recorded and checked

Each of the 35 live invocation samples records measurement JSON, the exact
parity-accepted native inputs/outputs and raw RPC requests/responses. Snapshot
ledgers, headers, state/config hashes, compute calibration and resource caps
remain visible. Full config or ledger drift is distinct from consumed-resource
drift. Production diff rejects incompatible calibration, helper/network/protocol,
metric sources or caps rather than comparing unlike environments.

The analysis computes min, max, range, mean and population standard deviation
per metric and case. It preserves every individual value. Both increases and
decreases indicate noise; an apparent improvement does not prove repeatability.
Different artifacts with equal consumed resources are identified separately.
Missing cases, fewer than five samples, duplicate runs, changed source, dirty
target directories or build/measurement hash disagreement cannot establish the
five-clean-build claim. Three unsupported metrics remain null, not invented zero.

Strict regression policies cover all eight measured metrics, with explicit
ignores only for historical read consumption, instance-only size and signed
transaction size. All comparisons use run 1 as the baseline. This invokes real
production diff/policy logic; it does not run five public GitHub Actions jobs.

## Evidence

The experiment writes [environment](experiments/repeatability/completed/environment.json),
[all runs](experiments/repeatability/completed/runs.json),
[analysis](experiments/repeatability/completed/analysis.json),
[verification](experiments/repeatability/completed/verification.json),
[metric table](experiments/repeatability/completed/metrics.csv), policies and
reports, source copies and each clean-built WASM. Per-run RPC/native captures
provide replayable state. The execution harness/source and SHA256 manifest
identify the producer. Private seeds stay in temporary directories.
See the [checksummed manifest](experiments/repeatability/manifest.json),
[attempt index](experiments/repeatability/attempts.json),
[quality gate commands and exits](experiments/repeatability/completed/validation.json)
and [artifact checks](experiments/repeatability/completed/artifact-verification.json).

The first fresh-network attempt failed account funding before any measurement
samples. Its failure/environment and later successful real funding diagnostic
are preserved under `attempt-1-startup/`. RPC health alone did not establish
friendbot readiness. The experiment now records funding responses and retries
transient HTTP errors before starting samples. No response is fabricated.

Other attempts remain separate from the definitive series:

- `attempt-2-empty-rustflags/`: partial measurements with an empty `RUSTFLAGS`;
  stopped because the CLI warned that dependency remapping was disabled.
- `attempt-3-existing-sac/`: setup failed when trying to create an existing SAC;
  the harness now checks for it first.
- `attempt-4-captive-core/`: warm-up failed with RPC error -32603, captive core
  HTTP 404 on `getLedgerEntries`. The exact request subsequently succeeded three
  times; both failure and recovery are saved. At the time of this experiment,
  production measurement failed immediately on this error. Stage 4B added
  [bounded recovery](snapshot-recovery.md). A completed metric series does not prove RPC availability or
  reliable unattended operation, and these failed attempts must not be discarded.

## Reproduce

From a repository checkout, provision the exact verified CLI on PATH, Rust
1.95.0/wasm32v1-none and the pinned quickstart image on localhost port 18000:

```bash
npm ci
npm run build
npm run build:helper
cargo +1.95.0 fetch --locked --manifest-path contract/Cargo.toml --target wasm32v1-none
docker run --rm -d --name weighin-repeatability-proof \
  -p 127.0.0.1:18000:8000 \
  stellar/quickstart@sha256:4c8bad1ef7341205b898f83d9489321da80c7bd74183100fc8e2a39a5938c7d5 --local
node tests/experiments/verify-repeatability.cjs /tmp/weighin-repeatability-evidence
npm test
npm run test:native
npm run bundle
docker stop weighin-repeatability-proof
```

See [build provisioning](contract-build.md), [native provisioning](native-measurement.md)
and [metric meanings](metric-provenance.md). The harness creates temporary
workspaces, touches no production contract source, and sends no GitHub comments.
Use a new evidence destination for each attempt. Stop the isolated network after
capturing results.
`npm test` checks the saved repository evidence; the harness independently
analyzes the new evidence destination when it finishes.
The saved series used the source/fixture copy linked above. New runs measure the
current declared fixtures and report their actual case count; the temporary
[migration bridge](fixture-migration.md) adds one reference invocation, so a run
against that fixture has eight cases per cycle rather than the saved seven.

## Bounds of the conclusion

Equal hashes/metrics on this host and these fixtures establish local evidence
under the recorded inputs. They do not guarantee cross-machine/compiler/library
determinism, separate GitHub CI runs, arbitrary user contracts, live state that
changes between invocations, ledger/time/random-dependent behavior, archived
state or unverified authorization cases. Changed build flags, SDK/Rust/CLI,
protocol/cost settings, helper binary, seed, arguments and ledger state can change
measurements. Current production provenance guards some of these differences;
it does not freeze arbitrary live state or record every caller build option.

Repeated immutable native snapshot replay remains a separate check. It cannot
substitute for these five fresh source builds and live captures. Subsequent [hosted CI](EVIDENCE.md), [fixture-path migration](fixture-migration.md)
and [local external-project evidence](external-soroban-forge.md) have their own
records. Hosted external-repository CI remains unverified.
