# Deployment state isolation design (proposal for #209)

**Status: proposal — awaiting maintainer approval.** Issue #209 is blocked
until the setup design is approved, and no approval is recorded in the issue,
its comments, the merged design pull request, or the repository. This document
therefore changes no runtime behavior. It records the traced root cause, the
proposed namespace, the compatibility impact, the planned tests, and the
decisions a maintainer must record before implementation proceeds.

Context: [committed fixture setup and typed dependency design](fixture-setup-design.md)
(issues #39, #56, #57; design merged in `design: committed fixture setup,
dependencies, and typed bindings`).

## 1. Root cause

Deployment identity has no revision or scenario dimension:

- `src/measurement.ts:572-574` derives the deployment salt from the WASM hash
  alone: `salt = sha256(wasmHash)`.
- `src/measurement.ts:282-300` turns `(deployer account, salt)` into the
  contract address, so the address is a function of the deployer and the WASM
  only.
- `src/action.ts:504-511` and `src/action.ts:554-561` measure HEAD and BASE on
  the same standalone network with the same deployer key file
  (`sharedKeyFile`), so both revisions share one account and one address space.
- `src/measurement.ts:577` and `src/measurement.ts:637-639` reuse an existing
  instance (`Already deployed at …`) instead of creating a fresh one.

Consequently identical WASM yields the identical contract address in BASE and
HEAD, and the second revision reads and writes the first revision's instance.
The comparison layer cannot see this: `src/identity.ts` and `src/diff.ts` pair
on `(fixture_id, logical_id, function_name, case_id)`, and the runtime address
is diagnostic only, so a shared instance is invisible to the diff and to
policy. The repository already records the boundary in
[known limitations](KNOWN_LIMITATIONS.md): "Identical WASM on one
network/deployer can share a runtime address."

Measured invocations are simulated today, so no state is committed and the leak
is latent. It becomes real as soon as setup commits state (issues #208, #210,
#213, #214, #215): a committed BASE setup write would be visible to the HEAD
measurement of the same contract.

## 2. Proposed design

### 2.1 Namespace

A scenario namespace is the tuple

```
[revision_sha, scenario_id, logical_contract_id]
```

and the deployment salt becomes a deterministic function of that namespace and
the artifact:

```
salt = sha256("weighin/deployment-namespace/v1" || len(revision_sha) || revision_sha
              || len(scenario_id) || scenario_id
              || len(logical_contract_id) || logical_contract_id
              || len(wasm_sha256) || wasm_sha256)
```

Length-prefixed fields plus a version tag keep the encoding unambiguous, so two
different namespaces can never serialize to the same input. The WASM hash stays
in the salt, which preserves the existing property that a changed artifact
produces a new address.

`revision_sha` is the revision being measured. It is already carried to
`runMeasurement` as `gitCommit` (`src/action.ts:507` passes `headSha`,
`src/action.ts:557` passes `baseSha`, `src/cli.ts:88` passes the local commit).
`scenario_id` names the setup scenario inside one revision; it is not a runtime
concept yet, because the setup model is still unimplemented. `logical_contract_id`
is the identified logical id from `src/identity.ts`, which keeps two different
logical contracts that share one WASM in separate instances.

### 2.2 Where the change lands

One place: the salt derivation in `src/measurement.ts`. Logical identity
resolution already happens before any side effect (`src/measurement.ts:530`
parses the fixture before the deployment loop), so the namespace inputs are
available without reordering the pipeline. `src/identity.ts`, `src/diff.ts`,
metric derivation, threshold evaluation, and the report format stay unchanged.

### 2.3 Fail-closed rules

Namespace inputs are validated before any upload, deployment, funding, or RPC
mutation. A missing, blank, malformed, or ambiguous input aborts the run; there
is no silent fallback to shared-state behavior.

| Input | Accepted | Rejected (fail closed) |
|---|---|---|
| `revision_sha` | 40-hex commit SHA | blank, `unknown`, non-SHA, whitespace |
| `scenario_id` | `[a-z0-9._-]{1,64}` | blank, uppercase/space/other characters, missing |
| `logical_contract_id` | resolved by `parseFixtures` | duplicate logical id in one fixture |
| namespace collision | one `(revision, scenario, logical_id)` per fixture | the same logical id deployed with two different WASM hashes in one run |

`runMeasurement` currently defaults `gitCommit` to `"unknown"`
(`src/measurement.ts:514`). That default must not survive into the namespace:
either the default is rejected, or the namespace is carried by a separate
explicit option that has no default at all.

### 2.4 Expected behavior

| Scenario (identical WASM) | Address | State |
|---|---|---|
| same revision, same scenario, same logical id | same | reused within the namespace, deterministic on repeat |
| different revision | different | isolated |
| different scenario id | different | isolated |
| different logical id | different | isolated |
| missing or invalid revision or scenario | none | run aborts before any side effect |

## 3. Compatibility impact

- **Every derived address changes**, including the unchanged control, where
  BASE and HEAD will now report different runtime addresses. Metric deltas,
  pairing, and policy behavior are unchanged, and no behavior test asserts
  `base_contract_id === head_contract_id` (verified across `tests/`), so no
  existing test depends on the old address equality.
- **Retained evidence stays valid as history.** Archived experiments are replayed
  from stored captures, not regenerated, so they continue to describe the run
  that produced them. New runs will show the new addresses.
- **Existing deployments are not reused.** Contracts deployed under the old salt
  are not found, so a first run against a persistent network redeploys at the
  new address. The `Already deployed` fast path then applies only inside one
  namespace.
- **Call sites need explicit namespace inputs.** The Action can pass
  `headSha`/`baseSha`; `src/cli.ts` can pass its own commit. Experiment scripts
  and tests that pass descriptive labels (`test-replay`, `nested-base`,
  `path.basename(dir)`) would be rejected by a strict SHA rule, so either those
  call sites are migrated or the namespace revision input is a separate,
  separately validated field.
- **The disposable-environment alternative is complementary, not a replacement.**
  [the setup design](fixture-setup-design.md) also allows BASE and HEAD to use
  separate disposable accounts. That isolates revisions but not two scenarios
  inside one revision, and it needs additional funding, so the salt namespace
  is the minimal mechanism that satisfies both.

## 4. Planned tests

`tests/deployment-isolation.test.cjs` (new):

1. Same revision, scenario, logical id, and WASM derive the same address
   (deterministic repeated deployment).
2. A different revision derives a different address for identical WASM.
3. A different scenario id derives a different address.
4. A different logical id derives a different address.
5. A missing, blank, or `unknown` revision fails closed before any RPC or
   deployment side effect.
6. An invalid scenario id fails closed.
7. An ambiguous namespace (same logical id, two different WASM hashes in one
   run) fails closed.
8. Logical pairing is unchanged: records with different runtime addresses and
   identical `(fixture_id, logical_id, function_name, case_id)` still pair, with
   the runtime addresses and WASM SHA-256 still present as diagnostics.
9. A golden namespace vector pins the derivation across processes.

`tests/fail-closed.test.cjs` gains the Action and CLI fail-closed paths for
missing namespace inputs. `tests/comparison-identity.test.cjs` and
`tests/native/simulation.test.cjs` are re-run unchanged as anchors: pairing is
already address independent, and the native helper has no deployment identity.

Controlled real-network proof on the pinned standalone network: deploy the same
WASM under two revision namespaces, record two distinct addresses, commit a
storage write against the first, show the second does not observe it, and prove
the unchanged-WASM control reproduces its address on a repeated run. Raw RPC
captures, native replays, environment, and checksums are retained; an
infrastructure failure is never reported as expected policy proof.

## 5. Documentation and generated artifacts in the same change

`docs/KNOWN_LIMITATIONS.md` (the "Multiple contracts" row and a new
deployment-isolation row), `docs/EVIDENCE.md` (the new proof), `README.md`, and
`docs/comparison-identity.md` (namespace note), together with regenerated
`bundled/` output and `provenance-manifest.json`.

## 6. Required maintainer decision

Approval must be recorded explicitly on issue #209, because the issue is blocked
until the setup design is approved. The decisions to record are:

- **D1** Namespace tuple: `[revision_sha, scenario_id, logical_contract_id]`, or
  a corrected tuple.
- **D2** Strictness of the revision input: 40-hex SHA only, or a separately
  validated namespace token, and how that relates to the unchanged `git_commit`
  diagnostic field.
- **D3** `scenario_id`: a required explicit input now, with the value for the
  current runtime, or deferred until the setup model exists.
- **D4** Whether an unchanged control must keep identical BASE and HEAD runtime
  addresses. The proposal drops that equality, since the addresses are
  diagnostic and no test depends on it.
- **D5** Migration scope: whether the CLI path and the existing experiment
  scripts are updated in the same change.
