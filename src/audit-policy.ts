/**
 * audit-policy.ts
 *
 * Pure diagnostic helpers that encode the WeighIn npm audit policy. These are
 * NOT called from the runtime action; they exist to make policy expectations
 * testable and to document the contract between the CI step and the JSON report
 * format produced by `npm audit --json`.
 *
 * Policy:
 *   - `--audit-level=moderate` is passed to npm; npm itself signals a nonzero
 *     exit when any moderate-, high-, or critical-severity advisory is present.
 *   - Dev dependencies are included (no `--omit=dev`).
 *   - Registry / network failures produce a nonzero exit from npm and are NOT
 *     silently swallowed; no empty fallback report is manufactured.
 *   - `npm audit fix` is never invoked; no dependency versions are changed.
 */

/**
 * Returns true when the parsed `npm audit --json` report contains at least one
 * vulnerability entry. A clean audit has an empty or absent `vulnerabilities`
 * map. A service-failure report typically has an `error` key and no
 * `vulnerabilities` key — this function returns false for that case because the
 * failure is signalled by the nonzero exit code, not by advisory presence.
 */
export function auditReportHasAdvisories(report: unknown): boolean {
  if (
    report === null ||
    typeof report !== "object" ||
    !("vulnerabilities" in report)
  ) {
    return false;
  }
  const vulns = (report as Record<string, unknown>)["vulnerabilities"];
  if (vulns === null || typeof vulns !== "object") {
    return false;
  }
  return Object.keys(vulns as object).length > 0;
}

/**
 * Returns true when the CI step should be considered a failure. Failure is
 * determined solely by the exit code produced by npm — the same exit code that
 * the CI step propagates via `EXIT=$?; exit $EXIT`. This includes:
 *   - nonzero exit due to a moderate-or-higher advisory (per --audit-level),
 *   - nonzero exit due to a registry/network error (ENOTFOUND, ECONNRESET…),
 *   - nonzero exit due to a malformed or empty response.
 *
 * This helper does NOT re-implement npm's severity logic; it delegates entirely
 * to the exit code so tests can assert that the propagation contract is upheld.
 */
export function auditExitCodeShouldFail(exitCode: number): boolean {
  return exitCode !== 0;
}
