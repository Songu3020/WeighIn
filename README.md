# WeighIn

WeighIn benchmarks configured Soroban contract functions in BASE and HEAD,
compares their resource usage, and fails a GitHub Action when a configured policy
is violated. It is for contract maintainers who want resource regressions visible
in pull requests.

**Tested scope:** Linux x64, protocol 28, a standalone Stellar network, Soroban
SDK 28.0.0, Stellar CLI 28.1.0 and Rust 1.95.0. See
[verified evidence](docs/EVIDENCE.md) and [known limitations](docs/KNOWN_LIMITATIONS.md).

## Why WeighIn

A contract change can preserve its interface while increasing metered compute,
memory, footprint or write usage. WeighIn compares repeatable fixture cases so
maintainers can review those changes and choose which increases should block CI.
These are Soroban simulation resources, not hardware performance or fee estimates.

## How It Works

```text
HEAD checkout (no modified tracked files) + fetched BASE worktree
  → verify HEAD workspace has no modified tracked files
  → build each revision's configured contracts
  → deploy WASM and simulate each revision's fixtures
  → capture RPC state and measure with protocol-matched native simulation
  → pair logical benchmarks independently of runtime addresses
  → calculate resource deltas
  → enforce HEAD thresholds and absolute caps
  → write report and outputs
  → pass / fail
```

The default builder uses `stellar contract build --locked --optimize=true` and
`wasm32v1-none`. It builds the Cargo packages selected by fixture WASM paths.
The Action requires at least one matched benchmark; missing baselines, invalid
policies, incompatible provenance and required unavailable metrics fail.
The baseline is the fetched base ref, not a computed merge base.
[Architecture](docs/architecture.md) explains the implementation.

## Example Result

An actual isolated change added one persistent write to `hello` while preserving
its arguments and return value:

| Metric | BASE | HEAD | Delta |
|---|---:|---:|---:|
| CPU cost-model instructions | 266,842 | 309,171 | +42,329 (+15.86%) |
| Ledger write bytes | 0 | 88 | +88 |

The WASM hash and runtime contract address changed. The logical benchmark still
paired. Report-only execution passed; `strict_zero_tolerance` on CPU produced
violations and Action exit 1. The [hosted proof](https://github.com/WeighInNG/WeighIn/actions/runs/37853815025)
verified that expected failure. Its enclosing verification job is intentionally
green. [Exact source, hashes, reports and raw responses](docs/EVIDENCE.md) are retained.

## Quick Start

1. Put fixture declarations in **both** the baseline and HEAD. Commit a baseline
   containing those fixtures before the first comparison. Give logical contracts
   and cases stable IDs.
2. Provision Linux x64, Rust 1.95.0 with `wasm32v1-none`, Stellar CLI 28.1.0,
   Docker and the pinned protocol-28 standalone network.
3. Copy the [benchmark workflow](.github/workflows/weighin.yml) into your
   repository and adapt its fixture/config paths. It includes tool and sidecar
   provisioning. Pin the Action to a reviewed commit; the excerpt below uses
   the hosted-verified public immutable revision.

For a contract whose Cargo package is `contract-test`, `weighin-fixtures.json`:

```json
{
  "id": "greeting-suite",
  "contracts": [{
    "id": "greeting",
    "wasm_path": "contract/target/wasm32v1-none/release/contract_test.wasm",
    "invocations": [{
      "id": "world",
      "function_name": "hello",
      "args": [{"type": "symbol", "value": "world"}]
    }]
  }]
}
```

Adapt the WASM basename to your Cargo package and the function/arguments to your
contract interface. The path is relative to the fixture file. The default
builder finds the owning Cargo manifest; merely renaming an unrelated artifact
is not supported.

A contract that calls another deployed contract declares it in `depends_on`
(explicit contract ids) and takes its address from the committed setup instead
of a hardcoded value:

```json
{
  "id": "pool-suite",
  "contracts": [{
    "id": "pool",
    "wasm_path": "contract/target/wasm32v1-none/release/pool.wasm",
    "depends_on": ["token"],
    "invocations": [{
      "id": "deposit",
      "function_name": "deposit",
      "args": [
        {"type": "address", "binding": {"contract": "token"}},
        {"type": "i128", "value": "100"}
      ]
    }]
  }, {
    "id": "token",
    "wasm_path": "contract/target/wasm32v1-none/release/token.wasm",
    "invocations": [{"id": "name", "function_name": "name", "args": []}]
  }]
}
```

Every revision deploys each contract once, dependencies first, and commits the
whole setup before any measured invocation. Unknown, duplicate, self or cyclic
dependencies, and bindings to an undeclared dependency, are rejected before any
side effect; a failed prerequisite aborts its dependents. A binding takes the
dependency's committed create return value (its contract address), optionally
narrowed by `select` steps such as `[{"field": "admin"}, {"index": 0}]`, and
must decode to the declared `type`; a missing value, malformed path or type
mismatch fails explicitly. Case identity uses the binding declaration, never
the runtime address. See the [setup plan proof](docs/setup-plan.md).

`weighin.toml`:

```toml
[thresholds.functions.hello]
cpu_instructions = "strict_zero_tolerance"
memory_bytes = "allow_10_percent_increase"
```

The pin below passed hosted control, regression, threshold and core CI checks.
See [publication evidence](docs/EVIDENCE.md#published-revision-validation) and
[dependency security review](docs/DEPENDENCY_SECURITY.md).

After checkout, tool installation and network readiness, the Action step is:

```yaml
- uses: WeighInNG/WeighIn@bbbe9001bbd375fd6a1ff75be5da2593c86fff20
  with:
    fixtures-path: weighin-fixtures.json
    config-path: weighin.toml
    rpc-url: http://localhost:8000/rpc
    report-path: weighin-report.md
    metadata-path: pr-metadata.json
```

Upload the report with `if: always()` so failed policies remain inspectable.
For PR comments, add the [separate comment workflow](.github/workflows/weighin-comment.yml)
to the default branch. It reads report artifacts without executing PR code with
a write token. The supplied consumer posts only after a successful PR producer;
failed policy reports remain in artifacts and job summaries.
The comment sub-Action runs its bundled entry point from the Action installation;
report and metadata paths are read from the caller's working directory.

### PR comment metadata contract

The producer writes a versioned metadata artifact only for pull request events:

```json
{
  "schemaVersion": 1,
  "repository": "WeighInNG/WeighIn",
  "prNumber": 27,
  "headSha": "f679238a096b49df0edfaf7d02d5bfa2dfd6be8f"
}
```

`repository` is the base repository that owns the trusted comment workflow, so a
fork PR still records the base repository rather than the fork. Before any API
request the consumer re-validates the version, the trusted repository
(case-insensitively), a positive integer PR number and a 40-character
hexadecimal SHA. Malformed JSON, a missing or unsupported `schemaVersion`,
another repository and malformed PR-number/SHA fields all fail before mutation.
These checks only validate the artifact shape and repository identity; they do
not prove the run belongs to the PR.

**Stale reports are skipped.** After validating the metadata, the consumer compares three revisions before it touches any comment. The *producer* revision is `workflow_run.head_sha` from the trusted `workflow_run` event, which for a `pull_request` run is the pull request head the report was measured at. The *metadata* revision is `headSha` from the artifact; because `actions/checkout` checks out the synthetic merge commit on `pull_request` events, it must be either the producer revision or a merge commit that has it as a parent, and anything else is rejected before mutation. The *current* revision is the live pull request head read from the API. When the producer revision is not the current head, the consumer exits successfully without creating or updating a comment and reports `Skipped stale report` as a job warning and summary entry, so an older job that finishes late never overwrites a newer result. A missing or malformed event revision, or a failing lookup, fails before mutation. The consumer reads the pull request and a commit, so its job needs `contents: read` in addition to `pull-requests: write`. The immutable pin in `weighin-comment.yml` predates this check and only gains it when moved to a revision that includes it.

Producer and consumer versions must be paired. **Producer v1 (this revision)
requires consumer v1 (this revision), and the v1 consumer rejects legacy
unversioned metadata; it never infers a missing repository.** The previously
published immutable pins at `bbbe9001bbd375fd6a1ff75be5da2593c86fff20` remain a
documented **legacy** producer/consumer pair: that pinned producer emits
unversioned metadata and that pinned consumer accepts it. The examples here keep
that verified legacy pin; do not pair a legacy producer with the v1 consumer and
do not repin these examples to an unverified revision.

## Configuration

All supported inputs are declared in [action.yml](action.yml):

| Input | Meaning |
|---|---|
| `fixtures-path` | Required fixture path; default `weighin-fixtures.json` |
| `config-path` | HEAD policy file; default `weighin.toml`. A missing file means report-only |
| `trusted-policy-ref` | Optional ref fetched from `origin` for an immutable policy source; must be paired with `trusted-policy-path` |
| `trusted-policy-path` | Repository path read from the resolved trusted policy commit; HEAD cannot replace it |
| `rpc-url` | Compatible standalone RPC; default `http://localhost:8000/rpc` |
| `base-ref` | Baseline branch, tag, or commit SHA; PR base branch, otherwise `main`, if omitted. Invalid refs are rejected before builds or deployment. |
| `rust-toolchain` | Contract-build Rustup override; does not change pinned native-helper toolchain |
| `build-command` | Custom shell build command in each revision; replaces default build guarantees |
| `allow-cross-target-substitution` | Opt in to using a WASM artifact built for a different target when the declared target artifact is missing; disabled by default |
| `skip-build` | `true` uses prebuilt fixture WASMs in both revisions; incompatible with `build-command`. Accepts YAML 1.2 boolean spellings (`true`, `True`, `TRUE`, `false`, `False`, `FALSE`); defaults to `false`. Non-boolean values are rejected |
| `report-path` | Optional Markdown report destination; replaced atomically, so an interrupted write keeps the previously published report; must not resolve to the same file as `metadata-path`, `fixtures-path` or `config-path` (symlinks and hardlinks are rejected) |
| `metadata-path` | Optional versioned PR-number/HEAD-SHA JSON destination; emitted only in a PR context; must not resolve to the same file as `report-path`, `fixtures-path` or `config-path` |
| `github-token` | Optional direct PR-comment token; omit for the separate comment workflow |
| `comment-author-mode` | Which identity owns the report comment: `github-actions` (default, canonical GitHub Actions bot ID 41898282) or `authenticated-user` (resolves the authenticated user via `GET /user`). Unsupported values fail the action before any comment mutation. Custom installation-token writers and arbitrary third-party GitHub App identities are not supported by either mode. |

Outputs: `result` is `pass` or `fail`; `diff-json` contains the comparison.
An unsuccessful comparison emits `fail` and `{}`. A valid comparison with policy
violations emits its real diff, writes the report, then fails the Action. If a
later report or job-summary write fails after a valid comparison, the Action
still fails with that delivery diagnostic while retaining the computed diff.

The Markdown report is delivered atomically. It is written to a temporary file
this run owns, in the destination directory, and renamed over the destination
only after the complete report was written. A failed or interrupted write
therefore leaves an already published report unchanged instead of truncating
it, and never publishes a partial report. Only the temporary file created by
the failing run is cleaned up; a concurrent writer's temporary file is left
untouched. The replacement is a same-filesystem rename, so the content is not
fsynced before it becomes visible.

See [policy and package provenance](docs/policy-and-package-provenance.md) for
the trusted-policy boundary, package manifest verification, and signing
guidance.

### Endpoint diagnostics

CLI, Action and transport diagnostics render the configured RPC endpoint through
one shared sanitizer instead of echoing it. Scheme, host, port and path are kept;
userinfo is stripped, every query value is replaced with `REDACTED` (keys are
preserved) and the fragment is dropped. A malformed URL becomes a fixed
`[invalid endpoint]` placeholder rather than the raw input. The sanitized form is
for display only: requests still use the configured endpoint unchanged. This is
shape-based redaction, not a guarantee about secrets embedded in the path or in
other arbitrary text.

Relative rules accept `strict_zero_tolerance`, `allow_X_percent_increase`, a
nonnegative numeric percentage, or `ignore`. Rules are scoped by function name
and apply to every matching contract/case with that function. Global CPU/memory
percentage rules and all-metric strict policy are also supported. Absolute caps
are configured under `[limits.global]` or `[limits.functions.hello]`:

```toml
[limits.functions.hello]
cpu_instructions = 350000
```

Caps are maximum HEAD consumption; equality passes. A zero BASE with positive
HEAD has an undefined percentage in the report and violates finite percentage
rules. Unknown/invalid policy keys fail. A nonignored rule without a matched
function fails. Unavailable metrics required by a policy fail; global
`fail_on_any_regression = true` needs explicit per-function ignores for the three
unavailable metrics. Absolute caps are evaluated on matched BASE/HEAD
benchmarks; a configured global cap fails with an actionable error if there are
no matched benchmarks, rather than silently passing. New or removed cases alone
do not evaluate absolute caps. An absent policy and an explicitly empty global
limits table remain report-only. Prefer targeted rules as in the quick start.
Omitting `config-path` still loads the default file if it exists.

## Benchmark Identity

The comparison tuple is `(fixture_id, logical_id, function_name, case_id)`.
Explicit fixture/contract/invocation `id` values are stable across code changes.
Without them, normalized fixture/WASM paths and canonical typed arguments supply
identity. Different paths/arguments become new/removed cases unless both revisions
share explicit IDs. Duplicate identities fail. Runtime `contract_id` and WASM
SHA256 remain diagnostics. See [comparison identity](docs/comparison-identity.md)
and [fixture migration](docs/fixture-migration.md).

## Metrics

Eight resource fields are measured on the supported path: CPU and memory cost
units, RO+RW footprint entries, disk read bytes, RW footprint entries, encoded
write bytes, successful contract/system event count, and encoded events plus
return bytes. CPU/memory come from official native Soroban simulation with
captured network cost settings; RPC resource budgets are not consumed CPU values.
Limits come from that captured configuration. Event count has no independent cap.

Historical read bytes, instance-only contract data size and signed transaction
size are **unavailable**, represented by `null` and a reason. A measured zero is
distinct from unavailable. [Metric provenance](docs/metric-provenance.md) defines
all eleven keys and their exact semantics.

The CLI measures existing WASMs and writes JSON; it does not build, compare
revisions, enforce thresholds or post comments. Provision the native helper/RPC,
then run `node dist/cli.js <fixtures.json> --rpc-url <standalone-rpc> --output <results.json>`
from a built checkout. See [native provisioning](docs/native-measurement.md).

SDK metadata is reported per contract from the Cargo workspace/lock owning each
fixture WASM (`contract/Cargo.lock` or a root workspace `Cargo.lock`), or
`"unknown"` when no owning lock can be established; multiple declared versions
are listed rather than collapsed to one. It is best-effort on-disk metadata and
does not prove how a prebuilt WASM was compiled.

## Source Accounts

The account that invokes a measured call is recorded in
`provenance.source_account`, and `measureSourceAccountEffects` from
`weighin/dist/source-account` measures one case under several source accounts
while code, arguments, protocol, calibration and resource limits stay fixed.
It reports the per-metric effect and whether results stay comparable across
accounts. See [source-account effects](docs/source-account-effects.md).

## Evidence

[WeighIn Evidence](docs/EVIDENCE.md) links hosted control/regression/threshold
proof, raw RPC/native captures, five clean builds and five measurements per case.
Evidence conclusions are bounded by the recorded environment.
[Hosted Soroban Forge validation](docs/hosted-soroban-forge.md) additionally proves
one real escrow query: changed WASM/address pairing, +14,234 CPU and verified
strict-policy failure in a permitted isolated fork.
[Cross-contract nested invocation attribution](docs/nested-invocation.md) proves a
real caller→callee host call charging one combined footprint with per-contract
event and return attribution.

## Known Limitations

[Known limitations](docs/KNOWN_LIMITATIONS.md) covers protocol/platform scope,
state/auth/randomness, custom builds, fixture types, CLI and GitHub behavior.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for installation, formatting, types, tests,
native replay and packaging checks. CI runs real tests and checks bundle freshness.

## License

[Apache License 2.0](LICENSE).
