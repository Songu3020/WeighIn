import { describe, it, expect } from "vitest";
import {
  auditReportHasAdvisories,
  auditExitCodeShouldFail,
} from "../src/audit-policy";

// ---------------------------------------------------------------------------
// Labeled test fixtures
//
// These represent the three distinct outcome categories that the CI step must
// handle correctly. They are NOT live security evidence; see the actual
// npm-audit.json artifact uploaded by each CI run for that.
// ---------------------------------------------------------------------------

/**
 * FIXTURE: clean-audit
 * Outcome: npm exits 0; no advisories present.
 * Shape: `npm audit --json` with zero vulnerabilities.
 */
const auditClean = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
    dependencies: {
      prod: 6,
      dev: 4,
      optional: 0,
      peer: 0,
      peerOptional: 0,
      total: 10,
    },
  },
};

/**
 * FIXTURE: advisory-present
 * Outcome: npm exits 1 (--audit-level=moderate triggers on a moderate advisory).
 * Shape: minimal `vulnerabilities` entry as produced by `npm audit --json`.
 */
const auditWithAdvisory = {
  auditReportVersion: 2,
  vulnerabilities: {
    "example-pkg": {
      name: "example-pkg",
      severity: "moderate",
      isDirect: false,
      via: [
        {
          source: 1234567,
          name: "example-pkg",
          dependency: "example-pkg",
          title: "Prototype Pollution",
          url: "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx",
          severity: "moderate",
          cwe: ["CWE-1321"],
          cvss: {
            score: 5.6,
            vectorString: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:L",
          },
          range: "<2.0.0",
        },
      ],
      effects: [],
      range: "<2.0.0",
      nodes: ["node_modules/example-pkg"],
      fixAvailable: true,
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 1,
      high: 0,
      critical: 0,
      total: 1,
    },
    dependencies: {
      prod: 6,
      dev: 4,
      optional: 0,
      peer: 0,
      peerOptional: 0,
      total: 10,
    },
  },
};

/**
 * FIXTURE: service-failure
 * Outcome: npm exits nonzero (e.g. ENOTFOUND or ECONNRESET); no advisory data
 * is present. The failure must propagate; no empty/zero report is manufactured.
 * Shape: error envelope produced by `npm audit --json` on a registry failure.
 */
const auditServiceFailure = {
  error: {
    code: "ENOTFOUND",
    summary: "registry.npmjs.org: Name or service not known",
    detail:
      "This is a problem related to network connectivity.\nCheck your internet connection.",
  },
};

// ---------------------------------------------------------------------------
// Tests: auditReportHasAdvisories
// ---------------------------------------------------------------------------

describe("auditReportHasAdvisories", () => {
  it("[clean-audit] returns false when vulnerabilities map is empty", () => {
    expect(auditReportHasAdvisories(auditClean)).toBe(false);
  });

  it("[advisory-present] returns true when at least one vulnerability entry exists", () => {
    expect(auditReportHasAdvisories(auditWithAdvisory)).toBe(true);
  });

  it("[service-failure] returns false (failure signalled by exit code, not advisory presence)", () => {
    // A service-failure report has an `error` key but no `vulnerabilities` key.
    // auditReportHasAdvisories must not misclassify this as a clean audit;
    // the CI step's nonzero exit is the authoritative failure signal.
    expect(auditReportHasAdvisories(auditServiceFailure)).toBe(false);
  });

  it("returns false for null input", () => {
    expect(auditReportHasAdvisories(null)).toBe(false);
  });

  it("returns false for non-object input", () => {
    expect(auditReportHasAdvisories("not a report")).toBe(false);
  });

  it("returns false when vulnerabilities key is absent", () => {
    expect(auditReportHasAdvisories({ metadata: {} })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: auditExitCodeShouldFail — exit-propagation contract
// ---------------------------------------------------------------------------

describe("auditExitCodeShouldFail", () => {
  it("[clean-audit] exit 0 must not fail the job", () => {
    expect(auditExitCodeShouldFail(0)).toBe(false);
  });

  it("[advisory-present] exit 1 from npm must fail the job", () => {
    // npm exits 1 when --audit-level threshold is breached.
    expect(auditExitCodeShouldFail(1)).toBe(true);
  });

  it("[service-failure] nonzero exit from npm registry/network error must fail the job", () => {
    // npm may use exit codes other than 1 for connectivity failures; any
    // nonzero exit must be treated as a failure — no silent pass-through.
    expect(auditExitCodeShouldFail(1)).toBe(true);
    expect(auditExitCodeShouldFail(2)).toBe(true);
  });

  it("exit 0 is the only passing exit code", () => {
    // Exhaustively verify boundary: nothing other than 0 is a clean result.
    for (const code of [1, 2, 4, 8, 127, 128, 255]) {
      expect(auditExitCodeShouldFail(code)).toBe(true);
    }
  });
});
