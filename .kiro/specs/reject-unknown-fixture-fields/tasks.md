# Implementation Plan: Reject Unknown Fixture Declaration Fields with Contextual Errors

## Overview

Five tasks implement the full scope: one source change (Task 1), two test extensions (Tasks 2–3), one documentation addition (Task 4), and one build/bundle validation pass (Task 5). All tasks are sequential — Task 1 must be complete before tests are written, tests must pass before bundles are regenerated.

## Tasks

- [x] 1. Wrap `parseFixtures` parse call with contextual error reporting

  Update `src/identity.ts` to catch `ZodError` from `FixturesSpecSchema.parse()` and re-throw via `formatZodError` with the `fixturePath` argument.

  - Add `ZodError` to the import from `"zod"` in `src/identity.ts`
  - Add `formatZodError` to the named import from `"./config"` in `src/identity.ts`
  - Wrap the `FixturesSpecSchema.parse(JSON.parse(raw))` call: catch `ZodError`, throw `new Error(formatZodError(err, fixturePath))`; re-throw all other errors unchanged
  - Assign the parse result to a named variable and use it for the remainder of `parseFixtures`
  - Run `npm run typecheck` — expect zero errors

  _Requirements: R1.1, R1.2, R1.3, R1.4, R1.5, R2.1, R2.2, R2.3, R3.1, R3.2, R3.3, R6.1_

- [x] 2. Add `fail-closed` tests for each invalid declaration level

  Extend `tests/fail-closed.test.cjs` with four `parseFixtures` rejection tests (one per declaration level) and one Action-level side-effect observer test.

  - Add `'parseFixtures rejects unknown key at fixture root'`: input has `"idenitifer"` instead of `"id"` at root; assert throws with message matching fixture path and the offending key
  - Add `'parseFixtures rejects unknown key on contract declaration'`: input has `"wasm_pat"` instead of `"wasm_path"`; assert throws with contextual message
  - Add `'parseFixtures rejects unknown key on invocation declaration'`: input has `"functoin_name"` instead of `"function_name"`; assert throws with contextual message
  - Add `'parseFixtures rejects unknown key on top-level typed argument'`: input has `"typ"` instead of `"type"` in an arg object; assert throws with contextual message
  - Add `'Action rejects unknown fixture root field before build or deployment'`: use the `action()` helper with `setupFiles` writing a fixture with `"idenitifer"` to both revisions; assert `status === 1`, `builds` empty, `keyPaths` empty, and `summary` matches `/Invalid WeighIn configuration/`
  - Run `npm test` — expect all new tests to pass

  _Requirements: R1.1–R1.4, R2.1, R2.2, R6.2, R6.3, R7.1, R7.4, R7.5_

- [x] 3. Add `comparison-identity` tests for misspelled IDs and valid payloads

  Extend `tests/comparison-identity.test.cjs` with two tests: misspelled optional `id` rejection at all three id-bearing levels, and valid `vec`/`map` payloads parsing successfully.

  - Add `'misspelled optional id at any declaration level throws rather than falling back'`: fixture root with `"idenitifer"` throws; contract with `"iD"` throws; invocation with `"iD"` throws; each error message should mention the offending key
  - Add `'vec and map payloads with valid typed-argument contents parse successfully'`: a `vec` arg with one typed element and a `map` arg with one `{key, value}` entry each parse without error and produce a valid contract in the result
  - Run `npm test` — expect both new tests to pass alongside all existing tests

  _Requirements: R3.1–R3.3, R4.1, R4.2, R7.2, R7.3, R7.4_

- [x] 4. Write `docs/strict-fixture-declarations.md`

  Create documentation covering the four strict declaration levels, the behaviour change, error format, payload passthrough, and migration guidance.

  - Add Overview section: describe the change and its motivation (silent stripping → contextual rejection)
  - Add Strict declaration levels section: table with level, schema, and allowed fields
  - Add Behaviour change section: explain prior permissive `.strip()` mode vs. new `.strict()` rejection
  - Add Error format section: show an example contextual error message
  - Add What remains unconstrained section: confirm `args[].value` contents are not validated at declaration level
  - Add Migration section: instruct users to remove custom extension fields; note that full recursive arg validation is separate future work

  _Requirements: R8.1, R8.2, R8.3_

- [x] 5. Build, bundle, and verify

  Run the full validation sequence and regenerate the bundled entry points as a single commit with the source changes.

  - Run `npm run lint` — expect zero violations
  - Run `npm run typecheck` — expect zero errors
  - Run `npm test` — expect all tests to pass
  - Run `npm run build` — expect clean TypeScript compilation
  - Run `npm run bundle` — expect `bundled/index.js` and `bundled/comment-action.js` to be regenerated
  - Run `git diff --check` — expect no whitespace errors
  - Stage `src/identity.ts`, `tests/fail-closed.test.cjs`, `tests/comparison-identity.test.cjs`, `docs/strict-fixture-declarations.md`, `bundled/index.js`, and `bundled/comment-action.js` together

  _Requirements: R9.1, R9.2, R9.3, R9.4_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": [1, 4] },
    { "wave": 2, "tasks": [2, 3] },
    { "wave": 3, "tasks": [5] }
  ]
}
```

Tasks 2 and 3 can be worked in parallel once Task 1 is complete. Task 4 has no code dependency and can be written in parallel with Tasks 2–3. Task 5 must run after all prior tasks are complete.

## Notes

- No Zod schema shapes change. The `.strict()` calls and `z.any()` on `value` are already correct in `src/config.ts`.
- The `formatZodError` helper already produces the required `file:path + json.path: message` format — no new formatter is needed.
- `bundled/index.js` and `bundled/comment-action.js` must be committed together with the source change; the Action reads the bundle, not the TypeScript source.
- Rollback is a simple PR revert of source + bundles. No persistent data is involved.
