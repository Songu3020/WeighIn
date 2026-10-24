# Design Document

## Overview

This design describes the minimal change required to make the runtime fixture parser reject unknown declaration fields with contextual errors. The key insight from reading the source is that `FixturesSpecSchema`, `ContractSpecSchema`, `InvocationSpecSchema`, and `InvocationArgSchema` in `src/config.ts` **already use `.strict()`**, but the error thrown by `parseFixtures` in `src/identity.ts` is a raw `ZodError` with no file context attached to it. The fix has two parts:

1. Wrap the `FixturesSpecSchema.parse()` call in `parseFixtures` to catch `ZodError` and re-throw it using the existing `formatZodError` helper (which already formats file + JSON path).
2. Verify that `InvocationArgSchema`'s `z.lazy()` wrapper correctly propagates `.strict()` for the top-level `{type, value}` shape (it does — the inner object is already `.strict()`; only the `value` field is `z.any()`, which is correct payload handling).

No schema shapes need to change. Only the error-reporting path in `parseFixtures` needs to be updated.

---

## Components and Interfaces

### `parseFixtures(raw: string, fixturePath: string): IdentifiedFixtures`

The only public function modified by this feature. Signature is unchanged. The change is internal: a `try/catch` wraps the existing `FixturesSpecSchema.parse()` call to intercept `ZodError` and re-throw it as a plain `Error` with a contextual message via `formatZodError`.

### `formatZodError(error: ZodError, fileName: string): string`

Existing helper in `src/config.ts`. Used without modification. Produces:

```
Invalid WeighIn configuration in <fileName>:
- <json.path>: <zod message>
```

### Zod schemas (no interface changes)

All four schemas keep their existing `.strict()` shape. No new fields, no removed fields, no type changes. `InvocationArgSchema.value` stays `z.any()`.

---

## Data Models

### Fixture JSON — declaration levels and allowed fields

| Level | Schema | Allowed fields |
|---|---|---|
| Fixture root | `FixturesSpecSchema` | `id` (optional), `contracts` (required) |
| Contract | `ContractSpecSchema` | `id` (optional), `wasm_path` (required), `invocations` (required) |
| Invocation | `InvocationSpecSchema` | `id` (optional), `function_name` (required), `args` (required) |
| Typed argument | `InvocationArgSchema` | `type` (required), `value` (required) |

Any key not in the "Allowed fields" column at the corresponding level causes `FixturesSpecSchema.parse()` to throw a `ZodError`, which `parseFixtures` converts to a contextual `Error`.

`value` at the typed-argument level is `z.any()` — its contents are not schema-validated by this feature.

---

## Architecture

### Affected files

| File | Change |
|---|---|
| `src/identity.ts` | Catch `ZodError` from `FixturesSpecSchema.parse()` and re-throw via `formatZodError` |
| `tests/fail-closed.test.cjs` | New test cases for each invalid declaration level + side-effect observer assertions |
| `tests/comparison-identity.test.cjs` | New test cases for valid `vec`/`map` payloads and misspelled-ID rejection |
| `docs/strict-fixture-declarations.md` | New documentation for the stricter behaviour |
| `bundled/index.js` + `bundled/comment-action.js` | Regenerated (no manual edits) |

### Files that do NOT change

- `src/config.ts` — The schemas are already correct (`.strict()` everywhere, `z.any()` for `value`).
- `src/action.ts` — `parseFixtures` is called inside `runMeasurement`, which is already inside the try/catch that propagates failures before any build/fund/deploy step.
- `src/measurement.ts` — `parseFixtures` is called at the top of `runMeasurement`, before account init, WASM upload, deployment, or simulation.

---

## Component Design

### `src/identity.ts` — `parseFixtures`

**Current code:**
```ts
const fixtures = FixturesSpecSchema.parse(JSON.parse(raw));
```

**New code:**
```ts
import { FixturesSpecSchema, formatZodError } from "./config";
import { ZodError } from "zod";

// inside parseFixtures:
let parsed: z.infer<typeof FixturesSpecSchema>;
try {
  parsed = FixturesSpecSchema.parse(JSON.parse(raw));
} catch (err) {
  if (err instanceof ZodError) {
    throw new Error(formatZodError(err, fixturePath));
  }
  throw err;
}
```

`formatZodError` already produces the format:
```
Invalid WeighIn configuration in <fixturePath>:
- contracts[0].invocations[0].functoin_name: Unrecognized key(s) in object: 'functoin_name'
```

This satisfies R2 (file + JSON path in every error).

### Why no schema changes are needed

Reading `src/config.ts`:

- `FixturesSpecSchema` — `.strict()` ✓
- `ContractSpecSchema` — `.strict()` ✓
- `InvocationSpecSchema` — `.strict()` ✓
- `InvocationArgSchema` — inner `z.object({ type, value }).strict()` ✓, `value: z.any()` keeps payload contents unconstrained ✓

Zod's `.strict()` raises `ZodIssueCode.unrecognized_keys` for any extra key at that object level. Because `value` is `z.any()`, the contents of a `vec` or `map` payload are not subject to `.strict()` at the top-level check. The full recursive arg schema already validates `vec`/`map` element structure for type/value presence but does not reject unknown keys within nested elements — consistent with the scope statement that full recursive validation is separate work.

### Error message format

Using `formatZodError` from `src/config.ts`:

```
Invalid WeighIn configuration in weighin-fixtures.json:
- contracts[0].idenitifer: Unrecognized key(s) in object: 'idenitifer'
```

The "file path" is `fixturePath` (the second argument to `parseFixtures`), which is the stable workspace-relative path (e.g. `weighin-fixtures.json`, `nested/fixtures.json`). This matches what `fail-closed.test.cjs` already passes and what `action.ts` derives as `fixtureId`.

---

## Data Flow

```
parseFixtures(raw, fixturePath)
  │
  ├─ JSON.parse(raw)
  │
  ├─ FixturesSpecSchema.parse(...)    ← ZodError here if unknown key at any level
  │    ├─ FixturesSpecSchema.strict() ← rejects unknown fixture-root keys
  │    ├─ ContractSpecSchema.strict() ← rejects unknown contract keys
  │    ├─ InvocationSpecSchema.strict() ← rejects unknown invocation keys
  │    └─ InvocationArgSchema.strict() ← rejects unknown arg keys (not value contents)
  │
  ├─ catch ZodError → formatZodError(err, fixturePath) → throw Error
  │
  └─ assign logical identities (fixture_id, logical_id, case_id)
       ← only reached if parse succeeds
```

`runMeasurement` (in `measurement.ts`) calls `parseFixtures` before `getOrInitAccount`, before any `server.*` call, before WASM upload, before deployment, before simulation. The Action path in `action.ts` calls `runMeasurement` inside a try/catch that surfaces the error to `core.setFailed` and exits before any further network I/O.

---

## Test Design

### `tests/fail-closed.test.cjs` additions

Four new `parseFixtures` call tests (one per declaration level), plus one Action-level side-effect observer test:

```
test('parseFixtures rejects unknown key at fixture root')
  // { "idenitifer": "suite", "contracts": [...] }
  // assert.throws(..., /Invalid WeighIn configuration in fixtures.json/)
  // assert.throws(..., /idenitifer/)

test('parseFixtures rejects unknown key on contract declaration')
  // { "contracts": [{ "wasm_pat": "x.wasm", "invocations": [...] }] }

test('parseFixtures rejects unknown key on invocation declaration')
  // { "contracts": [{ "wasm_path": "x.wasm", "invocations":
  //   [{ "functoin_name": "hello", "args": [] }] }] }

test('parseFixtures rejects unknown key on top-level typed argument')
  // args: [{ "typ": "symbol", "value": "world" }]

test('Action rejects unknown fixture root field before build or deployment')
  // Uses action() helper with a fixture containing an unknown root field
  // assert result.status === 1
  // assert result.builds is empty (no build attempted)
  // assert result.keyPaths is empty (no key/account touched)
  // assert result.summary matches /Invalid WeighIn configuration/
```

### `tests/comparison-identity.test.cjs` additions

Two new tests to confirm R3 and R4 do not regress:

```
test('misspelled optional id at any declaration level throws rather than falling back')
  // Fixture root: { "idenitifer": "suite", "contracts": [...] } → throws
  // Contract:     contracts[0].iD = "c1"                        → throws
  // Invocation:   invocations[0].iD = "case-1"                  → throws

test('vec and map payloads with valid typed-argument contents parse successfully')
  // vec: { type: "vec", value: [{ type: "symbol", value: "a" }] }
  // map: { type: "map", value: [{ key: { type: "u32", value: 1 },
  //                               value: { type: "string", value: "x" } }] }
  // assert parseFixtures(...).contracts[0] is defined
```

---

## Documentation Design

`docs/strict-fixture-declarations.md` covers:

1. The four strict declaration levels and what fields each accepts.
2. The behavior change: previously unknown fields were silently stripped; now they are rejected with a contextual error.
3. Migration guidance: remove any custom extension fields from fixture files.
4. Confirmation that `args[].value` payload contents remain unconstrained.
5. Example error message format.

---

## Validation Sequence

After implementation, run in order:

```
npm run lint
npm run typecheck
npm test
npm run build
npm run bundle
git diff --check
```

Commit `bundled/index.js` and `bundled/comment-action.js` together with the source changes.

---

## Correctness Properties

### Property 1: Unknown declaration fields are always rejected

For any fixture JSON that contains an unknown key at the fixture root, contract, invocation, or top-level typed-argument level, `parseFixtures` SHALL throw an `Error` before returning.

**Validates: Requirements 1.1, 1.2, 1.3, 1.4**

### Property 2: Rejection errors include the fixture file path

For any rejected fixture, the thrown error message SHALL contain the `fixturePath` argument passed to `parseFixtures`.

**Validates: Requirements 2.1**

### Property 3: Rejection errors include the JSON path to the offending key

For any rejected fixture, the thrown error message SHALL include the dot-notation JSON path to the first offending unknown key (e.g. `contracts[0].invocations[0].functoin_name`).

**Validates: Requirements 2.2**

### Property 4: Valid fixtures always parse successfully

For any fixture that was valid before this change (i.e. it contains only known declaration fields and valid required values), `parseFixtures` SHALL succeed and return a complete `IdentifiedFixtures` value.

**Validates: Requirements 3.4, 3.5, 5.1, 5.2**

### Property 5: Structured payload contents do not cause rejection

For any typed argument of type `vec` or `map` whose elements are well-formed typed arguments (each containing exactly `type` and `value`), `parseFixtures` SHALL succeed — the `value` field is unconstrained at the declaration level.

**Validates: Requirements 4.1, 4.2, 4.3**

### Property 6: No partial identity is observable on failure

For any fixture that fails the declaration-level parse, no `fixture_id`, `logical_id`, or `case_id` SHALL be assigned — the thrown error is the only observable output.

**Validates: Requirements 1.5, 3.1, 3.2, 3.3**

### Property 7: Rejection always precedes network side effects

For any fixture that fails `parseFixtures`, no account init, build, WASM upload, contract deployment, or simulation call SHALL be reached in either the `runMeasurement` or Action execution path.

**Validates: Requirements 6.1, 6.2, 6.3**

---

## Error Handling

- **`ZodError` from `FixturesSpecSchema.parse()`:** Caught in `parseFixtures`, re-thrown as `Error` with message from `formatZodError(err, fixturePath)`. The original `ZodError` is not propagated.
- **`SyntaxError` from `JSON.parse(raw)`:** Not caught by this feature. Already surfaces as a plain thrown error, which the Action's top-level catch converts to a `core.setFailed` message. No change.
- **Other errors:** Not caught. Propagate as before.
- **Action path:** `runMeasurement` is called inside a try/catch in `action.ts`. The `Error` thrown by `parseFixtures` propagates through `runMeasurement` to that catch block, which sets `core.setFailed` and exits. `result.builds` and `result.keyPaths` will be empty because no build or key step runs before `parseFixtures`.

---

## Testing Strategy

Tests exercise `parseFixtures` directly (the public entry point), matching the same code path used by `runMeasurement` and the Action. No private helper is tested in isolation.

**Unit tests (`tests/fail-closed.test.cjs`):**
- One `assert.throws` per declaration level (fixture root, contract, invocation, typed argument).
- Each assertion checks both that the error is thrown and that the message contains the fixture path and the offending key name.
- One Action-level integration test using the `action()` helper: fixture contains an unknown root field; asserts `status === 1`, `builds` is empty, `keyPaths` is empty, and summary matches `/Invalid WeighIn configuration/`.

**Regression / positive tests (`tests/comparison-identity.test.cjs`):**
- Valid `vec` and `map` payloads parse without error and produce a valid `case_id`.
- Misspelled optional `id` at each of the three id-bearing levels throws (confirming R3).
- Existing tests covering valid fixtures with and without optional `id` fields continue to pass.
