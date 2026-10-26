# npm audit policy

This document describes the `npm audit` gate added to the `lint-and-test` CI
job.

## Placement and command

The gate runs immediately after `npm ci` in `lint-and-test`, before lint,
typecheck, and tests:

```yaml
- name: npm audit (moderate+ advisory gate)
  run: |
    npm audit --audit-level=moderate --json > npm-audit.json
    EXIT=$?
    exit $EXIT
```

## Severity threshold

`--audit-level=moderate` causes npm to exit nonzero for **moderate, high, and
critical** severities. Low and informational advisories do not fail the job.
This threshold matches the minimum recommended for CI gates in npm's own
documentation.

## Dev-dependency inclusion

No `--omit=dev` flag is passed. All packages installed by `npm ci` —
including `devDependencies` — are scanned. Rationale: dev packages (build
tooling, test runners, type checkers) execute on every CI runner and every
contributor machine. A vulnerability in `vitest` or `esbuild` is a real
exposure on those surfaces even though it is not shipped in the production
bundle.

## Exit-code propagation

The step captures JSON output to `npm-audit.json` before inspecting the exit
code:

```bash
npm audit --audit-level=moderate --json > npm-audit.json
EXIT=$?
exit $EXIT
```

`EXIT=$?` captures npm's actual exit code after the redirect. `exit $EXIT`
re-raises it so the CI step fails. There is no `|| true`, no fallback to an
empty report, and no swallowed nonzero exit. This means:

| npm outcome | Exit code | Job result |
|---|---|---|
| No advisories at or above threshold | 0 | ✅ passes |
| Moderate/high/critical advisory found | 1 | ❌ fails |
| Registry unreachable / network error | 1+ | ❌ fails |
| Malformed or truncated response | 1+ | ❌ fails |

## Retained artifact

The `Upload audit report` step runs with `if: always()`, so `npm-audit.json`
is uploaded regardless of whether the audit passed or failed. This allows
post-run diagnosis without re-running the job. The file contains only advisory
metadata produced by npm; no registry authentication tokens, `.npmrc`
contents, or credentials are written into it.

## What this step does NOT do

- Does **not** run `npm audit fix`.
- Does **not** change any dependency versions.
- Does **not** allowlist or suppress any advisories.
- Does **not** modify `.npmrc` or any registry configuration.

## Advisory remediation

Because the gate is blocking and never changes versions itself, an advisory is
cleared by a separate, deliberate dependency change: update the lockfile within
the declared range or deliberately bump an exact dependency pin to a patched
version. Regenerate the CycloneDX inventory (`npm run inventory:generate`) and
commit the matching `docs/dependency-inventory.json`. The regenerated inventory
has to cover the new locked version, so the Cargo 1.95.0 toolchain and the
locked native helper crates have to be available when it is generated.

## Distinction from native and image security

This step covers only the **npm lock graph** (`package-lock.json`). It does
not scan:

- The **Cargo lock graph** (`native/simulation/Cargo.lock`) for the Linux
  x64 simulation helper. Cargo advisories are a separate ecosystem and require
  tools such as `cargo audit`. This is noted in the dependency inventory
  documentation and is explicitly out of scope for this issue.

- **Container images or operating-system packages.** The `ubuntu-latest`
  runner image is managed by GitHub and is separate from the Node/npm
  dependency surface.

The CycloneDX dependency inventory (`docs/dependency-inventory.json`) records
all npm and Cargo locked components as a reproducible component inventory. It
is not vulnerability clearance, as noted in `docs/DEPENDENCY_SECURITY.md`.

## Tests

`test/npm-audit-policy.test.ts` contains unit tests for the two pure helpers
in `src/audit-policy.ts`:

| Fixture label | What it represents |
|---|---|
| `clean-audit` | Zero vulnerabilities, npm exits 0 |
| `advisory-present` | One moderate advisory, npm exits 1 |
| `service-failure` | Registry unreachable (`ENOTFOUND`), npm exits nonzero |

These tests verify the policy helpers and document exit-propagation
expectations. They do not make live npm calls. The actual live audit result is
the `npm-audit.json` artifact retained by each CI run of this repository.
