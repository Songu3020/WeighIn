# Policy selectors, build provenance, hosted reproducibility, and payload bounds

This document is the design/prototype deliverable for issues #40, #41, #42,
and #44. It deliberately does not change the production policy wire format,
measurement result schema, hosted workflow behavior, or transport behavior
before maintainer review.

## Issue #40: structured logical selectors

The selector is a structured tuple, never a display-label string:

```json
{
  "fixture_id": "id:payments",
  "logical_id": "id:transfer",
  "function_name": "quote",
  "case_id": "id:large"
}
```

The proposed policy entry contains `selector` plus a metric-to-rule map. The
existing function-wide configuration remains valid and is interpreted as a
legacy selector with only `function_name` populated. Exact matching is on the
canonical tuple fields; omitted fields are not wildcards in the new exact-case
form.

Precedence is deterministic and independent for each metric:

1. global rule;
2. function-wide rule;
3. exact fixture/contract/function/case rule.

The most specific matching rule wins. Absolute limits are evaluated separately
from regression rules and the stricter result is retained. `ignore` is an
explicit terminal rule for that metric; it does not make an unmatched selector
valid. A non-ignored configured selector that matches no BASE/HEAD case is an
error before policy success. Malformed, duplicate, ambiguous, or partially
specified exact selectors are rejected. Runtime contract IDs appear only as
diagnostics in violations and reports.

The report must show the resolved tuple, selected rule, and effective rule
source. Existing unavailable metrics remain fail-closed unless explicitly
ignored, and legacy function-wide configurations continue through the same
exported validator and runtime evaluator.

## Issue #41: versioned build provenance

Each selected artifact gets a provenance record associated with the actual
`BuiltContract`, not merely the fixture declaration:

```json
{
  "schema_version": 1,
  "mode": "default",
  "verification": "verified",
  "package": "contract_test",
  "manifest_sha256": "...",
  "toolchain": { "rust": "...", "stellar": "...", "sdk": "..." },
  "flags": ["--locked", "--optimize=true", "--target=wasm32v1-none"],
  "inputs": { "source_sha256": "...", "cargo_lock_sha256": "..." },
  "output": { "wasm_sha256": "...", "size_bytes": 1234 }
}
```

`mode` is `default`, `custom`, or `prebuilt`. Default builds record resolved
package/manifest, tool versions, target/profile/features, relevant source and
lockfile identities, and output hash. Custom commands are recorded with the
command text hash and `verification: unknown` unless the caller supplies an
independently verified artifact-to-source manifest. Prebuilt artifacts are
`caller-supplied` and never presented as source-verified merely because a
command was logged.

The reviewed implementation plan is to return these records from
`buildForRevision`, attach the selected record to each revision's measurement,
and render it in reports. Existing result interpretation remains valid when
the provenance field is absent. Differing provenance is informational by
default; a future explicit compatibility policy may require matching verified
provenance, in which case comparison fails closed rather than mixing values.
Archived evidence is not rewritten.

## Issue #42: hosted clean-build reproducibility

The hosted proof must use separate workflow runs/attempts, not two jobs in one
run relabeled as independent samples. The proposed bounded matrix is two
`ubuntu-24.04` executions with the same immutable source revision, fixture
snapshot, lockfile, Rust 1.95.0 toolchain/target, checksum-verified Stellar CLI,
Node/npm versions, optimizer flags, and standalone protocol image. Each run:

1. starts with a fresh contract target directory;
2. records runner image, tool versions, environment controls, source/input
   hashes, and the authenticated workflow run/attempt/revision tuple;
3. builds the same selected artifacts and records exact bytes, sizes, and
   SHA-256 values;
4. uploads a minimal sanitized evidence bundle containing only the manifest,
   checksums, process outcomes, and artifact metadata.

The verifier accepts a reproducibility result only when both runs completed,
all required artifacts exist, source/tool/input associations match, and each
reported WASM hash matches its bytes. It reports byte equality or the actual
per-artifact differences. Missing artifacts, failed builds, stale outputs,
forged source associations, or incompatible tool settings are invalid evidence,
not a reproducibility failure and not a pass. Existing local repeatability
evidence remains valid but is not relabeled as hosted evidence.

The workflow should be manually dispatchable and gated from becoming a required
red check until maintainers approve its cost and artifact-retention policy.
The proof is scoped to the selected Linux image/toolchain; it makes no
cross-machine or universal determinism claim.

## Issue #44: bounded payloads

Limits are derived separately for each layer and recorded with the failure:

| Layer | Bound | Required behavior |
| --- | --- | --- |
| RPC body | configured byte ceiling with documented headroom over supported captures | read chunks, count bytes, cancel response on overflow; do not trust Content-Length |
| JSON/XDR nesting | maximum decoded depth and collection counts | reject before unbounded recursive accumulation |
| snapshot | total entries, key bytes, value bytes, events, and result bytes | reject the complete snapshot; never accept a partial capture |
| native input | serialized stdin byte ceiling | reject before helper execution/materialization |
| native output | stdout byte ceiling and schema limits | classify as transport/resource failure, not unavailable metrics |

The limits must be recorded with protocol, helper/calibration, and source
capture identities. Boundary-equal payloads are accepted; one byte over is
rejected. Missing or misleading `Content-Length` is handled by counting the
stream. A stalled body is terminated by the existing request deadline and is a
transport failure. Malformed XDR, oversized stdin, and incomplete snapshot
assembly all fail closed. No size failure becomes zero or `unavailable`.

The implementation plan is to introduce a bounded reader used by RPC and native
transport, then apply the same accounting to XDR/event/snapshot accumulation.
The native helper's own process limits remain separate; the wrapper cannot claim
to contain an arbitrary hostile executable.

## Prototype and review boundary

`tests/foundations-design.test.cjs` exercises the proposed selector precedence,
unmatched behavior, provenance verification states, and inclusive/exclusive
payload boundaries without changing production behavior or fabricating network
evidence. Maintainer review is required before converting these proposals into
public config/result schemas or transport changes.
