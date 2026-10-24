# Strict Fixture Declaration Validation

## Overview

As of this change, WeighIn rejects fixture JSON files that contain unknown keys at any of the four
declaration levels. Previously, Zod's default `.strip()` behaviour would silently discard unknown
fields before identity assignment; now, any unrecognised key produces an error that names the
fixture file and the JSON path to the offending field. Parsing halts before any contract build,
account funding, deployment, or simulation step.

The primary motivation is preventing silent identity fallback: a misspelled optional `id` field
(e.g. `"idenitifer"` instead of `"id"`) was previously ignored, causing the fixture to use
path-based or argument-based identity without any warning. The new behaviour makes the error
explicit and immediate.

---

## Strict Declaration Levels

Four objects in a fixture file are validated strictly. Any key not listed in the **Allowed fields**
column causes a parse error.

| Level | Schema | Allowed fields |
|---|---|---|
| Fixture root | `FixturesSpecSchema` | `id` (optional), `contracts` (required) |
| Contract | `ContractSpecSchema` | `id` (optional), `wasm_path` (required), `invocations` (required) |
| Invocation | `InvocationSpecSchema` | `id` (optional), `function_name` (required), `args` (required) |
| Typed argument | `InvocationArgSchema` | `type` (required), `value` (required) |

All four schemas are defined in `src/config.ts` and use Zod's `.strict()` mode.

---

## Behaviour Change

**Before this change** — Zod used its default `.strip()` mode at parse time inside `parseFixtures`
in `src/identity.ts`. An object like:

```json
{
  "idenitifer": "my-suite",
  "contracts": [...]
}
```

would be silently accepted as a fixture with no explicit `id`, falling back to `path:` identity.
The misspelling went undetected and the intended `id:` identity was never used.

**After this change** — the same object produces an error immediately:

```
Invalid WeighIn configuration in weighin-fixtures.json:
- idenitifer: Unrecognized key(s) in object: 'idenitifer'
```

Parsing stops. No identity is assigned. No build, deployment, or simulation is attempted.

---

## Error Format

Every rejection error includes:

1. The fixture file path (the value passed as `fixturePath` to `parseFixtures`, typically the
   workspace-relative path such as `weighin-fixtures.json` or `nested/fixtures.json`).
2. The dot-notation JSON path to the offending key.
3. Zod's `Unrecognized key(s) in object` message listing the unknown key(s).

Example — unknown key on an invocation:

```
Invalid WeighIn configuration in weighin-fixtures.json:
- contracts.0.invocations.0.functoin_name: Unrecognized key(s) in object: 'functoin_name'
```

---

## What Remains Unconstrained

The `value` field of a typed argument is typed as `z.any()`. Its contents are **not** validated
at the declaration level. This means:

- A `vec` argument whose `value` is an array of well-formed typed arguments parses successfully.
- A `map` argument whose `value` is an array of `{ key, value }` pairs of typed arguments parses
  successfully.
- Primitive `value` contents (strings, numbers, booleans, hex strings) are not constrained beyond
  the large-integer string checks already in place for `u64`/`i64`/`u128`/`i128`.

Full recursive validation of nested `vec` and `map` typed-argument contents is explicitly out of
scope for this change and is planned as separate future work.

---

## Migration

If your fixture files contain custom extension fields (fields not in the allowed list above),
remove them before upgrading.

Common patterns that will now be rejected:

| Pattern | Fix |
|---|---|
| `"comment": "..."` at any level | Remove the field; use a `// comment` in a wrapper script or README instead |
| `"label": "..."` alongside `id` | Rename to `id` if it was intended as the identity key, or remove it |
| Any camelCase variant of a known field (e.g. `wasmPath`, `functionName`) | Use the snake_case canonical name (`wasm_path`, `function_name`) |
| Any extra metadata fields added for tooling (e.g. `"owner"`, `"team"`) | Move them to a separate sidecar file outside the fixture JSON |

---

## Scope Note

This change makes the **declaration objects** strict. It does not validate the internal structure
of `vec` or `map` payload arrays beyond what was already validated by the existing `superRefine`
logic in `InvocationArgSchema`. Full recursive strict validation of nested typed arguments is a
separate work item.
