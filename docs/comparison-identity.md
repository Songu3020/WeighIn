# Comparison identity (introduced in schema 2)

BASE and HEAD compare by `(fixture_id, logical_id, function_name, case_id)`.
WASM SHA256 and `contract_id` describe the built artifact and runtime deployment;
they may change without changing the configured benchmark's identity.

Existing fixtures with relative WASM paths work without IDs. Optional `id`
fields can name the fixture document, each contract, and each invocation:

```json
{
  "id": "reference-suite",
  "contracts": [{
    "id": "greeting",
    "wasm_path": "contract/target/wasm32v1-none/release/contract_test.wasm",
    "invocations": [{
      "id": "world",
      "function_name": "hello",
      "args": [{"type": "Symbol", "value": "world"}]
    }]
  }]
}
```

Without explicit IDs, the fixture identity is its normalized workspace-relative
path, the contract identity is the full normalized fixture-relative WASM path,
and the case identity is canonical typed arguments. Object key order and top-level argument type
capitalization do not affect case identity; nested type strings are preserved; argument order and values do.
Identity strings use `id:`, `path:`, `wasm:`, or `args:` prefixes to distinguish
configured IDs from derived IDs. Matching uses structured tuples, not joined
display labels, array positions, filenames alone, or runtime addresses.

An explicit ID is an assertion that this is the same configured benchmark.
Keep it stable across revisions. Use distinct contract IDs for distinct logical
contracts, even if they use the same WASM. Use distinct invocation IDs to measure
multiple cases with identical arguments. Duplicate identities fail rather than
silently replacing measurements. If a path or arguments change without an
explicit ID, the benchmark is deliberately reported as removed/new.
Adding or changing an explicit ID also changes identity: configure the same IDs
on both revisions when expecting them to pair. No filename/address inference
bridges an ID change.
For the reference's historical path migration, the temporary
[two-step fixture bridge](fixture-migration.md) preserves the exact old declaration
while introducing a stable contract ID. It uses existing matching behavior and
keeps additions/removals visible; it does not add automatic aliases to the diff.

`runMeasurement` now emits `schema_version: 5`, `fixture_id`, and `logical_id` on
each contract and `case_id` on each benchmark. The action supplies the same
workspace-relative fixture path for both worktrees. Other API callers measuring
separate worktrees should supply the same `fixtureId` option (or configure the
fixture document's `id`); its default is relative to the current directory.
Absolute WASM paths require an explicit contract ID.

The diff preserves `contract_id` as an alias for the HEAD runtime address and
adds `base_contract_id` and `head_contract_id`. Function diffs include `case_id`;
`newBenchmarks` and `removedBenchmarks` include function/case pairs. Existing
`newFunctions` and `removedFunctions` still identify whole-function changes.
New/removed contract labels and reports now identify the fixture/logical contract.
Threshold policies keep their existing per-function scope and apply to each case;
violation records include the fixture, logical contract, and case identities.

Old saved measurements lack the identity information needed to recover a
changed-WASM pairing safely. Legacy results retain address/function matching
when both sides are legacy. Legacy and schema 2 results never guess a match;
re-measure both revisions to migrate. Partial schema 2 records are rejected.

## Current native measurement schema

Schema 3 introduced consumed native compute and explicit availability. Schema 4
adds audited IO/event semantics and limit provenance; schema 5 pins the approved
per-metric source/cap mapping with the same logical tuple.
Availability, standalone record validation, and migration rules are documented in
[native measurement](native-measurement.md), the [metric audit](metric-provenance.md),
and the [authoritative record schema](record-schema.md).
Different measurement schemas are not silently mixed; measure both revisions
with the current producer to migrate.
