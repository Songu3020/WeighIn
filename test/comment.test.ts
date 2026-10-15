import { describe, it, expect } from "vitest";
import { renderComment } from "../src/comment";
import { DiffResult } from "../src/diff";
import { Violation } from "../src/threshold";

function createMockDiff(regression: boolean): DiffResult {
  return {
    contracts: [
      {
        fixture_id: "path:fixtures.json",
        logical_id: "id:contract-a",
        contract_id: "contract-a",
        base_contract_id: "base-contract-a",
        head_contract_id: "contract-a",
        base_commit: "abc",
        head_commit: "def",
        hasRegression: regression,
        newFunctions: [],
        removedFunctions: [],
        newBenchmarks: [],
        removedBenchmarks: [],
        functions: [
          {
            function_name: "test-fn",
            hasRegression: regression,
            metrics: [
              {
                key: "cpu_instructions",
                base: { consumed: 100, limit: 1000 },
                head: { consumed: regression ? 110 : 100, limit: 1000 },
                delta: regression ? 10 : 0,
                pct: regression ? 10 : 0,
                regression,
              },
            ],
          },
        ],
      },
    ],
    hasRegression: regression,
    newContracts: [],
    removedContracts: [],
  };
}

describe("renderComment", () => {
  it("renders a success status when no regressions and no violations", () => {
    const diff = createMockDiff(false);
    const comment = renderComment(diff, [], "main", "abcdef123");
    expect(comment).toContain("🟢");
    expect(comment).toContain("**All thresholds passed**");
  });

  it("renders a success status when there are regressions but no threshold violations", () => {
    const diff = createMockDiff(true);
    const comment = renderComment(diff, [], "main", "abcdef123");
    expect(comment).toContain("🟢");
    expect(comment).toContain("**All thresholds passed**");
    expect(comment).toContain(
      "🔴 | CPU Instructions | 100 | 110 | +10 | +10.0% | 1,000 |",
    );
  });

  it("renders a failure status when threshold violations exist", () => {
    const diff = createMockDiff(true);
    const violation: Violation = {
      contract_id: "contract-a",
      function_name: "test-fn",
      metric: "cpu_instructions",
      delta: 10,
      pct: 10,
      rule: "strict_zero_tolerance",
      message: "Fail msg",
    };
    const comment = renderComment(diff, [violation], "main", "abcdef123");
    expect(comment).toContain("🔴");
    expect(comment).toContain("**1 threshold violation**");
    expect(comment).toContain("### ❌ Violations");
    expect(comment).toContain("Fail msg");
  });

  it("formats missing functions and contracts", () => {
    const diff = createMockDiff(false);
    diff.newContracts.push("new-contract");
    diff.removedContracts.push("old-contract");
    diff.contracts[0].newBenchmarks.push({
      function_name: "new-fn",
      case_id: "args:[]",
    });
    diff.contracts[0].removedBenchmarks.push({
      function_name: "old-fn",
      case_id: "args:[]",
    });

    const comment = renderComment(diff, [], "main", "abcdef123");
    expect(comment).toContain("new-contract");
    expect(comment).toContain("old-contract");
    expect(comment).toContain("new-fn");
    expect(comment).toContain("old-fn");
  });

  it("escapes adversarial markdown content and preserves original diff data", () => {
    const diff = createMockDiff(true);
    const fixtureId = "fixture`|<details>\nlevel-1";
    const logicalId = "logical`|<!-- weighin-report -->\nmode";
    const caseId = "case`|</summary>\nvalue";
    const functionName = "hello`|<summary>\nvalue";
    const reason = "missing`|</details><!-- weighin-report -->\nline";
    diff.contracts[0].fixture_id = fixtureId;
    diff.contracts[0].logical_id = logicalId;
    diff.contracts[0].contract_id = "contract-a";
    diff.contracts[0].functions[0].function_name = functionName;
    diff.contracts[0].functions[0].case_id = caseId;
    diff.contracts[0].functions[0].metrics[0].reason = reason;
    diff.contracts[0].functions[0].metrics[0].head.limit_reason =
      "limit`|</details>\nboom";

    const comment = renderComment(
      diff,
      [
        {
          contract_id: "contract-a",
          function_name: functionName,
          case_id: caseId,
          metric: "cpu_instructions",
          delta: 10,
          pct: 10,
          rule: "strict_zero_tolerance",
          message: "Violation `|</details><!-- weighin-report -->\nboom",
        },
      ],
      "main",
      "abcdef123",
    );

    expect(comment.match(/<!-- weighin-report -->/g)).toHaveLength(1);
    expect(comment).toContain("fixture\\`|&lt;details&gt;\\nlevel-1");
    expect(comment).toContain(
      "logical\\`|&lt;!-- weighin-report --&gt;\\nmode",
    );
    expect(comment).toContain("hello\\`|&lt;summary&gt;\\nvalue");
    expect(comment).toContain(
      "Violation \\`\\|&lt;/details&gt;&lt;!-- weighin-report --&gt; boom",
    );
    expect(comment).not.toContain("<!-- weighin-report -->\nline");
    expect(diff.contracts[0].fixture_id).toBe(fixtureId);
    expect(diff.contracts[0].logical_id).toBe(logicalId);
    expect(diff.contracts[0].functions[0].function_name).toBe(functionName);
    expect(diff.contracts[0].functions[0].case_id).toBe(caseId);
    expect(diff.contracts[0].functions[0].metrics[0].reason).toBe(reason);
  });
});
