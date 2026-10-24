# Requirements Document

## Introduction

### Feature: Reject Unknown Fixture Declaration Fields with Contextual Errors

Runtime fixture objects currently use Zod schemas that, while already marked `.strict()` in `src/config.ts`, are the **same** objects used at runtime via `parseFixtures` in `src/identity.ts`. The problem is that any consumer calling `parseFixtures` with a fixture JSON that contains unknown top-level or nested declaration keys will have those keys silently stripped by Zod's default `.strip()` mode — unless each schema in the parse path uses `.strict()`. A review of the schemas shows the four declaration-level objects (`FixturesSpecSchema`, `ContractSpecSchema`, `InvocationSpecSchema`, and `InvocationArgSchema`) already carry `.strict()`, but `InvocationArgSchema` uses a `z.lazy()` wrapper which must also be verified to propagate strictness, and the error messages that Zod emits on unknown keys do not currently identify the originating fixture file or the JSON path to the offending field.

The fix tightens the runtime parse path so that unknown keys at each declaration level produce an error that names the file and JSON path, and are guaranteed to halt parsing before any contract build, funding, deployment, or simulation step.

---

## Requirements

### R1 — Strict parsing at all four declaration levels

**User story:** As a CI operator, I want fixture files with unknown top-level or nested declaration keys to be rejected immediately, so that a typo in an optional field never silently degrades to a fallback identity strategy.

**Acceptance criteria:**

- R1.1: An unknown key at the fixture root (e.g. `"idenitifer"` instead of `"id"`) is rejected and does not parse.
- R1.2: An unknown key on a contract declaration (e.g. `"wasm_pat"` instead of `"wasm_path"`) is rejected and does not parse.
- R1.3: An unknown key on an invocation declaration (e.g. `"functoin_name"` instead of `"function_name"`) is rejected and does not parse.
- R1.4: An unknown key on a top-level typed argument (e.g. `"typ"` instead of `"type"`) is rejected and does not parse.
- R1.5: Rejection happens in `parseFixtures`, before the function returns an `IdentifiedFixtures` object and thus before any build, fund, deploy, or simulate call can proceed.

### R2 — Contextual error messages

**User story:** As a developer debugging a fixture file, I want error messages to tell me the fixture file name and the JSON path of the offending key, so I can find and fix the problem without reading Zod's internal output.

**Acceptance criteria:**

- R2.1: Every rejection error message includes the fixture file path (the `fixturePath` argument to `parseFixtures`).
- R2.2: Every rejection error message includes the dot-notation JSON path to the offending key (e.g. `contracts[0].invocations[0].typ`).
- R2.3: The existing `formatZodError` helper in `src/config.ts` already satisfies this format; `parseFixtures` must use it (or an equivalent) rather than surfacing raw Zod output.

### R3 — Misspelled optional IDs never fall back silently

**User story:** As a benchmark author, I want a misspelled optional `id` field to be caught at parse time, so that it never causes the system to silently use `wasm:` or `args:` identity instead of the intended `id:` identity.

**Acceptance criteria:**

- R3.1: A fixture object with `"idenitifer": "my-suite"` (unknown field, intended as `id`) is rejected, not treated as a fixture without an explicit id.
- R3.2: A contract object with `"ID": "my-contract"` (wrong case, unknown field) is rejected.
- R3.3: An invocation object with `"iD": "my-case"` (wrong case, unknown field) is rejected.
- R3.4: Valid fixtures that omit the optional `id` entirely still parse successfully (no regression).
- R3.5: Valid fixtures that include the optional `id` field still parse successfully.

### R4 — Payload contents are not rejected

**User story:** As a contract author, I want `vec` and `map` argument values with arbitrary object contents to parse successfully, so that legitimate structured payloads are not broken by the stricter declaration-level rules.

**Acceptance criteria:**

- R4.1: A `vec` argument whose items are well-formed typed arguments (each with exactly `type` and `value`) still parses successfully.
- R4.2: A `map` argument whose entries are well-formed `{key, value}` pairs of typed arguments still parses successfully.
- R4.3: The strictness added by this feature applies only to the **declaration objects** (`FixturesSpecSchema`, `ContractSpecSchema`, `InvocationSpecSchema`, `InvocationArgSchema`) and not to the scalar `value` field contents of primitive argument types (string, bool, u32, etc.).
- R4.4: Full recursive validation of nested `vec`/`map` typed arguments is explicitly out of scope for this feature.

### R5 — Zero-argument invocations remain valid

**User story:** As a contract author, I want invocations with an empty `args` array to continue to parse without errors, so that contracts with no arguments are not broken.

**Acceptance criteria:**

- R5.1: `{"function_name": "hello", "args": []}` parses successfully.
- R5.2: Zero-argument invocations produce a valid `case_id` (via args-based identity: `args:[]`).

### R6 — Rejection occurs before side effects

**User story:** As a CI operator, I want invalid fixtures to fail before any expensive or irreversible operation, so that no Stellar network resource is consumed for a malformed fixture run.

**Acceptance criteria:**

- R6.1: `parseFixtures` throws synchronously on an unknown declaration field.
- R6.2: In the Action flow (`src/action.ts`), the fixture parse step already runs before any contract build, fund, deploy, or simulate step. This ordering must be preserved.
- R6.3: In the measurement flow (`src/measurement.ts`), the same guarantee applies.

### R7 — Test coverage via the public API

**User story:** As a contributor, I want the new validation to be covered by tests that exercise the same code path a real caller would use, so that a private refactor cannot silently drop the protection.

**Acceptance criteria:**

- R7.1: Tests are added to `tests/fail-closed.test.cjs` covering one invalid fixture per declaration level (fixture root, contract, invocation, top-level arg).
- R7.2: Tests are added to `tests/comparison-identity.test.cjs` covering valid `map` and `vec` payloads (ensuring R4 is not broken).
- R7.3: Tests confirm that a misspelled optional `id` at any declaration level throws (R3), not silently falls back.
- R7.4: All new tests call `parseFixtures` directly (the same public export used by `measurement` and `action`) — not a private helper.
- R7.5: Side-effect-observer assertions (checking `result.builds` and `result.keyPaths` are empty) are added to the Action-level integration test that exercises a fixture with an unknown declaration field, confirming rejection happened before build/fund/deploy.

### R8 — Documentation

**User story:** As a user reading the fixture format docs, I want to know that unknown fields are now errors rather than silently ignored, so that I can migrate any non-standard fixture fields before upgrading.

**Acceptance criteria:**

- R8.1: A dedicated documentation file (e.g. `docs/strict-fixture-declarations.md`) is added (or an existing fixture-format doc is updated) explaining the four strict declaration levels and the behavior change from prior permissive parsing.
- R8.2: The docs note which fields are optional (`id` at all three levels) versus required, and confirm that `args[].value` payload contents are unconstrained.
- R8.3: The docs include a migration note for users who may have added custom extension fields to fixture files.

### R9 — Bundle regeneration

**User story:** As a release manager, I want the bundled entry points to reflect the runtime schema changes, so that GitHub Action consumers receive the stricter validation without a separate release step.

**Acceptance criteria:**

- R9.1: After the implementation, `npm run build` and `npm run bundle` succeed without errors.
- R9.2: `bundled/index.js` and `bundled/comment-action.js` are regenerated and committed alongside the source changes.
- R9.3: `npm run lint`, `npm run typecheck`, and `npm test` all pass.
- R9.4: `git diff --check` reports no whitespace errors on the diff.

---

## Out of scope

- Full recursive validation of nested `vec`/`map` typed argument contents (R4.4) — this is a separate work item.
- Changes to the exported legacy `WeighinConfigSchema` / `weighin.toml` parsing in `src/config.ts` beyond what is required to support the runtime fixture path.
- Live network experiments — no Stellar testnet resource is required for these changes.
- Data migration — there is no persistent application data involved; rollback is a simple PR revert with its regenerated bundles.

---

## Glossary

| Term | Definition |
|---|---|
| Declaration level | One of the four structured objects in a fixture file: fixture root, contract, invocation, or top-level typed argument. |
| Declaration field | A key that is part of the Zod schema shape for a declaration object (e.g. `id`, `wasm_path`, `function_name`, `type`, `value`). |
| Unknown field | Any key present in a parsed JSON object that is not a declared field in the corresponding Zod schema. |
| Payload | The `value` field of a typed argument. For `vec` and `map` types the payload is an array of nested typed arguments or key/value pairs; its internal structure is not validated by this feature. |
| Permissive parsing | Zod's default `.strip()` behaviour, which silently drops unknown keys. |
| Strict parsing | Zod's `.strict()` behaviour, which rejects objects containing unknown keys with a `ZodIssueCode.unrecognized_keys` error. |
| Contextual error | A rejection message that includes the fixture file path and the dot-notation JSON path to the offending key. |
| Fallback identity | The `wasm:` or `args:` identity strategy used when no explicit `id` is provided at the fixture or contract/invocation level respectively. |
| Explicit identity | The `id:` identity strategy activated when the optional `id` field is present and non-blank. |
| `parseFixtures` | The public runtime function in `src/identity.ts` that parses, validates, and assigns logical identities to a raw fixture JSON string. |
| `FixturesSpecSchema` | The Zod schema for the fixture root object, defined in `src/config.ts`. |
| `ContractSpecSchema` | The Zod schema for a contract declaration object, defined in `src/config.ts`. |
| `InvocationSpecSchema` | The Zod schema for an invocation declaration object, defined in `src/config.ts`. |
| `InvocationArgSchema` | The Zod schema for a single typed argument object, defined in `src/config.ts`. |
| `formatZodError` | The helper in `src/config.ts` that formats a `ZodError` into a human-readable contextual message including the file name and JSON path. |
| Bundle | The esbuild-generated `bundled/index.js` and `bundled/comment-action.js` files that package the runtime for use as GitHub Actions entry points. |
