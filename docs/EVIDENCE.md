# WeighIn Evidence

## What this document proves

Recorded experiments show configured BASE/HEAD contracts being built, measured,
paired by logical benchmark identity, compared, reported and evaluated against
policy. A changed WASM/runtime address does not prevent comparison. Conclusions
apply to the fixtures and environments below. This page distinguishes real live
experiments, frozen replay tests and expected-negative hosted verification.

## Published revision validation

[PR #13](https://github.com/WeighInNG/WeighIn/pull/13) published and tested reviewed
commit `bbbe9001bbd375fd6a1ff75be5da2593c86fff20`. All seven PR checks passed.
The actual GitHub merge checkout was `85cc2766b2323ffa26cf761b8c70581e1a96c22c`;
the hosted producer records distinguish it from the reviewed branch head.

| Hosted check | Result / public job |
|---|---|
| Lint, typecheck, Node/Vitest tests | [Passed](https://github.com/WeighInNG/WeighIn/actions/runs/37853815131/job/113573072994) |
| Bundle freshness | [Passed](https://github.com/WeighInNG/WeighIn/actions/runs/37853815131/job/113573073326) |
| Core benchmark, native replay and report | [Passed](https://github.com/WeighInNG/WeighIn/actions/runs/37853815131/job/113573207430) |
| Consumer benchmark and report | [Passed](https://github.com/WeighInNG/WeighIn/actions/runs/37853815150/job/113573073265) |
| Control / exit 0 | [Passed](https://github.com/WeighInNG/WeighIn/actions/runs/37853815025/job/113573073257) |
| Intentional regression / exit 0 | [Passed](https://github.com/WeighInNG/WeighIn/actions/runs/37853815025/job/113573073102) |
| Strict-threshold verification / Action exit 1 | [Passed](https://github.com/WeighInNG/WeighIn/actions/runs/37853815025/job/113573072828) |

Hosted source validation passed **189 Node, 52 Vitest and 15 native tests**,
build, bundle freshness and packaging dry-run. Dependency installation reported
zero vulnerabilities; no dedicated blocking `npm audit` step is configured.
The separately recorded local audit remains the explicit npm audit evidence.
Run/job/artifact metadata and selected validation log lines are retained in
[the publication archive](experiments/publication/).

The [new hosted environment](experiments/publication/regression/environment.json)
used Node 24.21.0, Rust 1.95.0, Stellar CLI 28.1.0, contract SDK 28.0.0,
JavaScript SDK 16.0.1 and native simulation/host 28.0.1. The pinned image,
protocol-28 standalone network and `wasm32v1-none` optimized locked build method
were unchanged. RPC software version was not independently recorded.
The tested Action bundle SHA256 is
`88a84534eabc00599094cd212252dfa98c63fded479f1d626d311a8239a83466`;
helper SHA256 is
`e7785adc8b991dfd83dc28b12bde717384dc76229cc53c19971db7867db313ea`.

The [new regression diff](experiments/publication/regression/diff.json) paired
`id:reference-contract` despite runtime IDs changing from
`CA6RT4HSPLSQERW5D5KZB5JBFCMRZ55X3LGBT3UAOWFWPRG3E2KWD37W` to
`CCFGC7ZJUFCWTCDIGMSMNPE6QDQ4BDZNVLVAG72DQY3O2QBPX5KWTJ2Z`.
WASM hashes/sizes equal those in section 1 below. CPU was **266842 → 309171**,
delta **+42329 (+15.862945%)**; memory **1123942 → 1192553** and write bytes
**0 → 88**. These equal the recorded local regression values. The hosted control
again had eight zero resource deltas. Local and hosted native helper hashes differ;
that is recorded, not treated as cross-machine binary reproducibility.

[Strict-threshold verification](experiments/publication/threshold/verification.json)
and [raw process result](experiments/publication/threshold/process.json) retain
actual exit 1, `result: fail` and two CPU-policy violations. Only this expected
failure step is continued; the mandatory verifier passed and the enclosing job
was green. [Selected public log lines](experiments/publication/proof-validation-lines.txt)
retain GitHub's process-exit error. No whole-red-job claim is made.

Hosted artifacts are `flagship-{control,regression,threshold}-37853815025-1`
([artifact IDs and metadata](experiments/publication/proof-artifacts.json)),
plus `weighin-artifacts` on each benchmark producer. Their retained copies include
sources, WASMs, hashes, raw RPC/native captures, reports, outputs and exits.
The [core comment consumer](https://github.com/WeighInNG/WeighIn/actions/runs/37854252900)
and [example consumer](https://github.com/WeighInNG/WeighIn/actions/runs/37854180132)
succeeded. The [posted PR report](https://github.com/WeighInNG/WeighIn/pull/13#issuecomment-6070391630)
was verified equal to each producer's artifact after its corresponding consumer;
the final saved body equals the core report
([equality record](experiments/publication/comment.json)). Trusted comment workflows
ran default-branch `eaeea48ca77d1ff74c3a4cdee5f158a44fb4819e`, not PR code;
their own `head_sha` must not be confused with the benchmark producer's revision.

Consumer examples pin the verified public immutable `bbbe9001bbd375fd6a1ff75be5da2593c86fff20`.
That revision is a **legacy** producer/consumer pair under the versioned metadata
contract: its producer emits unversioned metadata and its consumer accepts it.
The new versioned consumer rejects that legacy artifact instead of inferring a
repository. Historical experiments below remain attributed to their original
producers.

## External Project Validation — Soroban Forge

The permitted public [WeighInNG fork](https://github.com/WeighInNG/soroban-forge)
validated the real escrow `escrows_for_participant(participant, 0, 10)` view from
upstream `07d7935234e9c86816116471121998b871b68439`, with immutable WeighIn
`bbbe9001bbd375fd6a1ff75be5da2593c86fff20`.
The fresh-deployment empty view needs no auth/token/prior state. Permission to test
is not official adoption or endorsement, and this is not full escrow coverage.

Configuration-only B `261ab6dae6c7aedb32ae94b8475c62dad27a3eb5` preserves upstream
contract sources/locks/toolchain. Corrected harness C is
`78efe5019da2313a478420444440d8843cbbb174`; proof-only R is
`6dc3c4a7fe99ee43a173c451fdc41dec37f88dff`, adding exactly one redundant persistent
existence check without changing the interface/empty return. Control compares
B → C; regression and strict policy both compare C → the exact same R.

| Hosted proof | Actual result |
|---|---|
| [Control](https://github.com/WeighInNG/soroban-forge/actions/runs/37864288478/job/113607202958) | CPU 569098 → 569098; eight zero deltas; identical WASMs/return; Action exit 0 / `pass` |
| [Regression](https://github.com/WeighInNG/soroban-forge/actions/runs/37864749630/job/113608690883) | CPU 569098 → 583332, +14234 (+2.501151%); memory +680; changed WASMs/runtime IDs still pair; exit 0 / `pass` |
| [Strict CPU](https://github.com/WeighInNG/soroban-forge/actions/runs/37865108512/job/113609862970) | Same regression, one CPU violation; actual Action exit 1 / `fail`; expected-negative verifier job green |

**WeighIn returned the expected policy failure; the enclosing verifier job
remained green because it was asserting that the failure occurred.** Actual exits
are recorded by a pure forwarding process observer, alongside original Action
outcomes and independently checked native/RPC/return parity. Missing reports or
infrastructure errors cannot satisfy the proof.

BASE/C WASM is 45,889 bytes, SHA256
`10b761dd75460dbc44083b488783660f518c71ac9e43fdf45a72bf07e5748f98`;
R is 45,908 bytes, SHA256
`ac6869dc7c7d32865bdafb5e2c2948f6929c58749e047ed4c4fa03dd9759e0cc`.
The exact fixture/contract/function/case tuple remains matched, with no additions
or removals, and every return is `{ids: [], total: 0, next_cursor: null}`.

Forge's supported unoptimized CLI 28.0 build is preserved via `build-command`:
`stellar contract build --package soroban-forge-escrow --locked --profile release --optimize=false`.
The target is wasm32v1-none; actual compiled WASM metadata records Rust 1.95.0 and
SDK 28.0.0. The separate root `stable` version probe records 1.99.0; it is not
misrepresented as the compiler used by the Action. Node 24.21.0, official native
simulation 28.0.1 and protocol 28 standalone were used. Three unavailable metrics
stay null; no new product feature was needed.

[Full external proof](hosted-soroban-forge.md) provides exact source commits,
workflow/job/artifact links, runtime IDs, metric table, scope, failure history,
permission boundaries and reproduction. [Durable archive](experiments/hosted-soroban-forge/)
retains sanitized raw captures, sources, WASMs, reports, real exits and metadata
with [checksums](experiments/hosted-soroban-forge/sha256.json), independently checked
by `tests/hosted-external-evidence.test.cjs`. This establishes this one successful
external query path, not funded settlement, populated pagination, deposit/release
or universal compatibility. The older local optimized proof remains separately
attributed and unchanged.

## Cross-contract nested invocation attribution

The [nested invocation proof](nested-invocation.md) measures a real
caller → callee host invocation in one top-level transaction on the pinned
protocol-28 standalone network. The `nested-caller` `run` case calls
`nested-callee` `work` through a runtime `Address` with no compile-time
dependency on the callee crate.

| Diagnostic | Callee alone | Nested (caller → callee) |
|---|---|---|
| WASM SHA256 | `7a889934…` | caller `de34030d…` |
| Runtime contract ID | `CC4CPMMF…` | caller `CDDW2K52…` |
| CPU cost-model instructions | 337,065 | 674,626 |
| Memory cost-model bytes | 1,195,786 | 2,393,762 |
| RO+RW footprint entries | 3 | 6 |
| Write footprint entries | 1 | 2 |
| Disk read bytes | 0 | 0 |
| Charged events | 1 (`work`) | 2 (`work`, `caller`) |

The nested footprint reuses all three callee keys unchanged and adds exactly the
caller code, contract instance and single `last` storage key. The two charged
events are ordered callee-then-caller, the callee event is byte-identical to the
standalone callee event, and transaction data, return and ordered events agree
with the parity-accepted raw RPC response. Six promoted metrics are verified
against raw RPC; consumed CPU and memory have no direct RPC resource.

An [address-swapped control](experiments/nested-invocation/control-diff.json)
measured by a second deployer still pairs both contracts by explicit identity
with eight zero deltas each, while the runtime IDs and the materialized callee
address argument differ. A [callee-only regression](experiments/nested-invocation/regression-diff.json)
(`7a889934…` → `67c62ccf…`) leaves the caller WASM (`de34030d…`) and runtime
address (`CDDW2K52…`) unchanged and attributes the extra resources to both cases:
nested CPU +29,329 and write bytes +80, callee CPU +28,882. A strict CPU policy
yields exactly the two expected [violations](experiments/nested-invocation/violations.json).

Three failure classes are retained — application (`Simulation failed for
run_failing`), invalid input before simulation, and missing native helper after a
successful simulation — alongside an [archived-state control](experiments/nested-invocation/archive-control.json)
where expiring the captured callee instance entry makes the helper exit 1 with
`archived ledger state is unsupported`. The
[environment](experiments/nested-invocation/environment.json) records Node
24.14.0, Stellar CLI 28.1.0, rustc 1.95.0, contract SDK 28.0.0 and native
simulation 28.0.1. [Raw captures, replays, diffs, sources, WASMs and the
checksum manifest](experiments/nested-invocation/verification.json) are retained
and checked by `tests/nested-invocation.test.cjs` and
`tests/native/nested-invocation.test.cjs`. Soroban charges the nested resources to
the single top-level transaction, so the combined resources are attributed per
contract but not split per contract.

## Tested environment — historical experiments

The retained [hosted environment](experiments/hosted-comparison/regression/environment.json)
records the actual producer checkout, not just a branch name:

| Setting | Hosted comparison proof |
|---|---|
| Workflow / reviewed head | [Run 37777040210](https://github.com/WeighInNG/WeighIn/actions/runs/37777040210), head `36294f695c7e5a46268e0087910299b6f3c60b33` |
| Actual producer checkout | `d0959ab25ccf827b2955c1cd0cda53e477a3c8f4` (GitHub PR merge checkout) |
| Node | 24.21.0 |
| Rust | 1.95.0, compiler commit `59807616e`, 2026-04-14 |
| Stellar CLI | 28.1.0, commit `c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd` |
| Contract Soroban SDK | 28.0.0, locked Cargo dependencies |
| JavaScript Stellar SDK | 16.0.1, pinned in the reviewed producer's package.json/lockfile |
| Native simulation / host | 28.0.1; helper SHA256 `e7785adc8b991dfd83dc28b12bde717384dc76229cc53c19971db7867db313ea` |
| Network / RPC | Standalone quickstart, `http://localhost:8000/rpc`; hosted RPC software version not separately recorded |
| Protocol / passphrase | 28 / `Standalone Network ; February 2017` |
| Image | `stellar/quickstart@sha256:4c8bad1ef7341205b898f83d9489321da80c7bd74183100fc8e2a39a5938c7d5` |
| Target / build | `wasm32v1-none`; `stellar contract build --locked --optimize=true` |
| Action bundle SHA256 | `104be8ef72ebc176986f577a4479d040be7684f4e1a9f5a4e0928eeee32591a0` |

Sources/locks, WASMs, reports, process exits, raw RPC/native IO and SHA256 manifests
are retained under [hosted-comparison](experiments/hosted-comparison/).
The [workflow metadata](experiments/hosted-comparison/workflow-run.json) identifies
the three public jobs. The fixture harness creates temporary Git BASE/HEAD commits;
those IDs are experiment inputs, not public project revisions.

The separate five-run experiment used Node 22.23.2/npm 10.9.8, the same Rust/CLI/
contract and JavaScript SDK versions, and RPC 29.0.0 running protocol 28. Its
[environment record](experiments/repeatability/completed/environment.json)
explicitly identifies a copied working-tree snapshot, not an exact clean commit.
The source snapshot hash is
`9b8f8aa35dba73f8997e90fcec0626cd281fd8a9636a891c489e22ae3f35d654`.
It is not relabeled as a measurement of later code or dependency upgrades.

## 1. Logical BASE/HEAD comparison

The hosted regression compares fixture `path:weighin-fixtures.json`, contract
`id:reference-contract`, function `hello`, case
`args:[{"type":"symbol","value":"world"}]`.

| Diagnostic | BASE | HEAD |
|---|---|---|
| WASM SHA256 | `718ba18378a2d94ec7bf0c75b3813c7d0bb5b65beb2fb4c445b3a4726ecd5668` | `5878fa37dfcec8eaebc72111dfdbfa92447cb735bd88d23dcaf0e8edf9f7f3e8` |
| WASM bytes | 776 | 871 |
| Runtime contract ID | `CDU7C6WWP7LOIFCN3VSH2HR2DQWOQ4C3KZLQXZMRLDNADYHEM7LIFIOH` | `CDEGPA6YAUBVXGFIFKJGHYSXFWXY5ZV5T7EQTBYUFOMOZWMPPTA3TQNV` |

The [actual diff](experiments/hosted-comparison/regression/diff.json) contains a
matched logical benchmark and no added/removed contracts. Its second declaration
is the temporary historical path bridge; both declarations point to the same
modern build output. This proves two configured identities, not two independent
stateful contract deployments. [The report](experiments/hosted-comparison/regression/summary.md)
shows logical labels and both runtime addresses.

`tests/comparison-identity.test.cjs` exercises changed WASM/address pairing,
unrelated contracts/functions, multiple cases, additions/removals, improvements,
regressions and duplicate rejection. [Identity rules](comparison-identity.md)
explain why filename/address guessing is avoided.

## 2. Build reproducibility

Five independent clean reference builds started with verified-empty Cargo target
directories. Every output was **776 bytes**, SHA256
`718ba18378a2d94ec7bf0c75b3813c7d0bb5b65beb2fb4c445b3a4726ecd5668`:
byte-for-byte equality was observed for those five builds.

Rust/CLI/source/locks were fixed; incremental compilation/compiler wrappers were
disabled; build jobs were two; `RUSTFLAGS`/`CARGO_ENCODED_RUSTFLAGS` were unset.
Downloaded dependencies were cached and fetched offline, but compiled reference
artifacts were not reused. The native helper and audit contract were reused.
See [runs](experiments/repeatability/completed/runs.json),
[verification](experiments/repeatability/completed/verification.json),
[checksummed manifest](experiments/repeatability/manifest.json) and
[method](repeatability.md). `tests/repeatability-evidence.test.cjs` checks source,
empty-target records, all five WASMs and their measurements. This establishes
bounded local reproducibility, not universal cross-runner determinism.

## 3. Measurement repeatability

Seven cases were measured five times each on one advancing pinned network:
**35 live invocations**. Each of the eight supported resource fields had range
and population standard deviation **zero for each case**. Three unsupported
fields remained null. The reference `hello` was 266,842 CPU / 1,123,942 memory
units in all five samples. Nonzero reads/writes/events and a larger return were
covered by the six-case audit artifact, which was reused rather than clean-built
five times.

Snapshots spanned ledgers 833–1101; full snapshot/config hashes changed, while
compute calibration and resource caps remained fixed. See the
[metric table](experiments/repeatability/completed/metrics.csv),
[analysis](experiments/repeatability/completed/analysis.json) and
[all conditions/failed setup attempts](repeatability.md). This does not prove
failure-free RPC service or stability for ledger/time/state-sensitive contracts.

## 4. Intentional regression detection

The only intentional source change is one persistent write before the unchanged
return in `hello(Env, Symbol)`:

```rust
env.storage().persistent().set(&symbol_short!("bench"), &to);
```

[BASE source](experiments/hosted-comparison/regression/base/contract/src/lib.rs)
and [HEAD source](experiments/hosted-comparison/regression/head/contract/src/lib.rs)
retain the exact change. It existed only in the isolated experiment.

| Resource | BASE | HEAD | Absolute delta | Percentage |
|---|---:|---:|---:|---:|
| CPU cost-model instructions | 266842 | 309171 | +42329 | +15.862945% |
| Memory cost-model bytes | 1123942 | 1192553 | +68611 | +6.104496% |
| RO+RW footprint entries | 2 | 3 | +1 | +50% |
| Write footprint entries | 0 | 1 | +1 | Undefined (BASE zero) |
| Write bytes | 0 | 88 | +88 | Undefined (BASE zero) |

Disk read bytes and event count stayed zero; events+return bytes stayed 44.
The hashes above changed, but logical pairing remained intact and CPU regression
was reported. Report-only policy correctly exited 0 with positive deltas.
[Verification](experiments/hosted-comparison/regression/verification.json) and
[process capture](experiments/hosted-comparison/regression/process.json) prove it.

## 5. Threshold enforcement

```toml
[thresholds.functions.hello]
cpu_instructions = "strict_zero_tolerance"
```

Expected: +42,329 CPU violates the rule; actual: Action/harness **exit 1**, output
`result: fail`, and two CPU violations (one per temporary bridge declaration).
See [threshold verification](experiments/hosted-comparison/threshold/verification.json),
[outputs](experiments/hosted-comparison/threshold/outputs.txt),
[report](experiments/hosted-comparison/threshold/summary.md) and
[process](experiments/hosted-comparison/threshold/process.json).
The unchanged strict-policy control had eight zero resource deltas and exit 0:
[control verification](experiments/hosted-comparison/control/verification.json).

In the [hosted threshold job](https://github.com/WeighInNG/WeighIn/actions/runs/37777040210/job/113310405470),
only the expected-negative benchmark step uses `continue-on-error`. A mandatory
subsequent step requires its original outcome `failure`, verified policy evidence
and actual exit 1. GitHub shows the continued step's conclusion as successful;
the enclosing verification job/run is green. This is proof of a genuine failed
benchmark process, not a claim that the enclosing job/run finished red.
Ordinary consumer jobs do not have that exception and fail on policy violation.

## 6. Raw measurement provenance

| Metric | Source / transformation | Unavailable behavior or assumption |
|---|---|---|
| CPU | Native `simulated_instructions`, copied without budget adjustment | Cost-model consumption; RPC exposes no direct consumed CPU |
| Memory | Native `simulated_memory`, copied directly | Metered memory units, not process RSS |
| Read entries | Count distinct RO+RW footprint keys | Includes queried absence, not repeated host reads |
| Disk read bytes | Parity-accepted resources `diskReadBytes` | Classic full-entry XDR on supported live-state path; live Soroban reads contribute zero |
| Write entries | RW footprint length | No-op writes/deletion count |
| Write bytes | Resources `writeBytes`, encoded RW postimages | No-op postimages count; deletion adds zero bytes |
| Events | Successful non-diagnostic contract/system event count | No independent count cap |
| Events+return bytes | Encoded full ContractEvents plus returned ScVal size | Includes XDR padding/overhead, not payload-only bytes |
| Historical read / instance-only size / signed transaction size | No verified consumption mapping | Null with explicit reasons; required policies fail |

Every measured cap comes from the same captured protocol-28 network configuration;
event count instead has null limit and a reason. Helper input/config/header/state
hashes and the seed/auth/features are retained. Full transaction-data/return/
ordered-event parity with RPC is required; mismatches fail.

[Raw RPC](experiments/hosted-comparison/regression/rpc.json) and
[native inputs/outputs](experiments/hosted-comparison/regression/native.json)
corroborate the hosted result. `tests/public-evidence.test.cjs` independently
checks manifest integrity, native input hashes, compute values and raw RPC parity.
The [six-case raw IO/event audit](experiments/metric-provenance/verification.json)
and `tests/native/metric-provenance.test.cjs` cover nonzero fields. For upstream
source/cap mappings and schema migration, see [metric provenance](metric-provenance.md).

## 7. Hosted CI evidence

- [Control job](https://github.com/WeighInNG/WeighIn/actions/runs/37777040210/job/113310405872): unchanged source, strict CPU policy, Action exit 0.
- [Regression job](https://github.com/WeighInNG/WeighIn/actions/runs/37777040210/job/113310405899): real temporary persistent write, changed hashes/addresses, positive deltas.
- [Threshold verification job](https://github.com/WeighInNG/WeighIn/actions/runs/37777040210/job/113310405470): verified real policy-failure exit 1.
- [Core CI on reviewed head](https://github.com/WeighInNG/WeighIn/actions/runs/37777040190): formatting, types, real tests, bundle freshness, native replay, contract build and benchmark.
- [Core CI on merged main](https://github.com/WeighInNG/WeighIn/actions/runs/37778374074) and [proof on merged main](https://github.com/WeighInNG/WeighIn/actions/runs/37778374229) succeeded at `eaeea48ca77d1ff74c3a4cdee5f158a44fb4819e`.
- [PR #1 delivered comment](https://github.com/WeighInNG/WeighIn/pull/1#issuecomment-6056259444), [comment workflow](https://github.com/WeighInNG/WeighIn/actions/runs/37775914155), and [saved equality verification](experiments/comment-workflow-activation/verification.json): posted body equals the downloaded report.
- [Merged PR-only guard](https://github.com/WeighInNG/WeighIn/pull/12) and [main comment workflow](https://github.com/WeighInNG/WeighIn/actions/runs/37778805362): non-PR producer correctly skipped; [metadata](experiments/hosted-comparison/main-comment-guard.json).

GitHub artifacts have 30-day retention and may require login. The retained copies
and manifests above preserve evidence after expiration. These hosted runs predate
the later dependency/docs changes; they are not hosted validation of every future
commit. New validation results must identify their own source/bundle.

## Reproduction

From a clean checkout with Node 24, Rust 1.95.0/`wasm32v1-none`, Docker and the
checksum-verified CLI installed as in the [proof workflow](../.github/workflows/flagship-proof.yml):

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:native
npm run bundle
bash scripts/start-local-network.sh
node tests/experiments/verify-flagship-ci.cjs control /tmp/weighin-proof-control
node tests/experiments/verify-flagship-ci.cjs regression /tmp/weighin-proof-regression
node tests/experiments/verify-flagship-ci.cjs threshold /tmp/weighin-proof-threshold
# Expected exit 1 ONLY for a verified CPU policy violation:
node - <<'NODE'
const assert = require('node:assert/strict');
const proof = require('/tmp/weighin-proof-threshold/verification.json');
assert.equal(proof.status, 'VERIFIED');
assert.equal(proof.action_exit, 1);
assert.equal(proof.result, 'fail');
assert.ok(proof.violations.length > 0);
assert.ok(proof.violations.every(v => v.metric === 'cpu_instructions' && v.delta > 0));
NODE
docker stop stellar-quickstart
```

Run the expected-failure command interactively or capture its exit explicitly in
CI; a shell with `set -e` otherwise stops before the verification/cleanup commands.
Use new evidence destinations per attempt. The harness makes isolated temporary
Git revisions and a local bare origin, executes real builds/RPC/native/Action,
and never changes the production contract or posts GitHub comments. BASE/HEAD
share a Cargo cache; this is not another five-cold-build experiment. Use healthy
owned `TMPDIR` storage. [Repeatability](repeatability.md) gives the separate
five-build/five-sample experiment.

## Updated dependency and reviewer-path validation

A clean local checkout of `7f990b5` independently repeated control, regression
and threshold on Node 24.13.1/npm 11.8.0 after the targeted dependency patches.
This is **local validation**, not another hosted run. The helper was genuinely
built from the pinned source, then reused; contract Cargo artifacts were cached.
[Environment](experiments/public-docs/regression/environment.json),
[clean-checkout commands/exits](experiments/public-docs/clean-and-live.json),
[control](experiments/public-docs/control/verification.json),
[regression](experiments/public-docs/regression/verification.json) and
[threshold](experiments/public-docs/threshold/verification.json) retain their own
source/bundle/helper hashes and raw captures. Control deltas were zero; changed
WASM/address still paired with +42,329 CPU and +88 write bytes; strict CPU exited 1.

[Validation](experiments/public-docs/validation.json) records all required quality
gates, native replay, packaging, clean installation and audit results. The initial
sidecar funding deadline failure and the first clean-checkout documentation-link
failure are preserved with their successful retries; neither failure was counted
as a passing benchmark. The [security review](DEPENDENCY_SECURITY.md) identifies
the dependency updates. The publication validation above verifies the patched
public revision now used by consumer pins.

## Distinct benchmark contracts control validation

The [distinct contracts control proof](distinct-contracts-control.md) validates two
genuinely distinct contract WASMs with overlapping function and case labels (`hello` / `id:world`)
and explicit logical identities (`id:contract-alpha` and `id:contract-beta`).
Durable evidence in [distinct-contracts-control](experiments/distinct-contracts-control/)
verifies that both contracts pair independently with zero control deltas across all 8
comparable metrics, with complete return parity and verifier rejection of swapped or missing
identities. This independent deployment proof remains distinct from stateful caller/callee proofs.

## Ledger-dependent benchmark variation validation

The [controlled ledger-dependent variation proof](ledger-variation.md) demonstrates that
bounded repeatability on state-invariant fixtures does not imply arbitrary ledger/time
independence. Using a proof-only contract branch (`hello(Env, Symbol) -> Vec<Symbol>`) that
depends explicitly on `env.ledger().sequence()` and `env.ledger().timestamp()` while keeping
source, compiled WASM (`87f52e776f2689bb00c0c163a7f402c984c322c4c644d5f511bd46f25817010a`),
runtime address, seed, and cost calibration fixed, durable evidence in
[ledger-variation](experiments/ledger-variation/) records five controlled standalone ledger
steps (ledgers 900–1000). Pre-threshold snapshots (900 → 925) have zero deltas, whereas
crossing the ledger threshold (900 → 1000) produces +52,966 CPU, +70,658 memory, +96 write
bytes, and +36 event+return bytes (`REPEATABILITY_VARIATION_FOUND`), triggering all 6 configured
policy violations without suppressing them for an unchanged artifact.

## Source-account effect validation

The [source-account effect proof](source-account-effects.md) measures one contract case under
three valid source accounts on the pinned protocol-28 standalone network while the contract
code, the arguments, the protocol, the calibration and the resource limits stay fixed. Durable
evidence in [source-account-effects](experiments/source-account-effects/) retains the raw RPC
captures, the native helper replays, the per-metric effects, an identical repeatability control
and the fail-closed evidence for a malformed key and for an account that is not on the network.
The source account changed no measured metric in that case
(`cross_run_comparison_valid: true`), the repeatability control reported no changed metric, and
the account is now recorded in `provenance.source_account` and compared with the other
environment identities, so saved records measured under different accounts are reported as
incompatible instead of being compared.

## Known boundaries

See [Known limitations](KNOWN_LIMITATIONS.md). [Hosted external validation](hosted-soroban-forge.md)
covers one empty escrow view in the permitted WeighInNG fork; full stateful Forge
coverage and upstream adoption are not claimed.
