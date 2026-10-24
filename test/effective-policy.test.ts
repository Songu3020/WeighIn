import { describe, it, expect } from "vitest";
import {
  resolveEffectivePolicy,
  WeighinConfig,
  PolicyOrigin,
} from "../src/threshold";
import { renderComment } from "../src/comment";
import { DiffResult } from "../src/diff";

function createMockDiff(): DiffResult {
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
        hasRegression: false,
        newFunctions: [],
        removedFunctions: [],
        newBenchmarks: [],
        removedBenchmarks: [],
        functions: [
          {
            function_name: "test-fn",
            hasRegression: false,
            metrics: [
              {
                key: "cpu_instructions",
                base: { consumed: 100, limit: 1000 },
                head: { consumed: 100, limit: 1000 },
                delta: 0,
                pct: 0,
                regression: false,
              },
            ],
          },
        ],
      },
    ],
    hasRegression: false,
    newContracts: [],
    removedContracts: [],
  };
}

describe("Effective Policy Resolution (#166)", () => {
  const mockOrigin: PolicyOrigin = {
    mode: "head",
    path: "weighin.toml",
    revision: "abcdef1234567890",
    content_sha256:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };

  it("identifies absent policy and defaults to report-only", () => {
    const diff = createMockDiff();
    const effective = resolveEffectivePolicy(diff, null, null);

    expect(effective.status).toBe("absent");
    expect(effective.report_only).toBe(true);
    expect(effective.rules).toEqual([]);

    const comment = renderComment(diff, [], "main", "abcdef123", effective);
    expect(comment).toContain(
      "Policy status: **absent** (no policy configuration found; report-only mode)",
    );
  });

  it("distinguishes loaded empty policy from absent policy", () => {
    const diff = createMockDiff();
    const config: WeighinConfig = { thresholds: {}, limits: {} };
    const effective = resolveEffectivePolicy(diff, config, mockOrigin);

    expect(effective.status).toBe("empty");
    expect(effective.report_only).toBe(true);
    expect(effective.mode).toBe("head");
    expect(effective.path).toBe("weighin.toml");
    expect(effective.content_sha256).toBe(mockOrigin.content_sha256);
    expect(effective.rules).toEqual([]);

    const comment = renderComment(diff, [], "main", "abcdef123", effective);
    expect(comment).toContain("Policy status: **loaded-empty**");
    expect(comment).toContain(mockOrigin.content_sha256);
  });

  it("records resolved rules covering global, function overrides, and explicit ignore", () => {
    const diff = createMockDiff();
    const config: WeighinConfig = {
      limits: {
        global: { cpu_instructions: 5000 },
        functions: { "test-fn": { memory_bytes: 2000 } },
      },
      thresholds: {
        global: {
          fail_on_any_regression: true,
          max_allowed_cpu_increase_pct: 10,
        },
        functions: {
          "test-fn": {
            cpu_instructions: "ignore",
            memory_bytes: 5,
          },
        },
      },
    };

    const effective = resolveEffectivePolicy(diff, config, mockOrigin);

    expect(effective.status).toBe("active");
    expect(effective.report_only).toBe(false);

    // Verify rules contain global limits and overrides
    expect(effective.rules).toContainEqual({
      target: "global",
      metric: "cpu_instructions",
      rule: "absolute_limit(5000)",
      source: "global",
    });

    // Function override for ignore
    expect(effective.rules).toContainEqual({
      target: "test-fn",
      metric: "cpu_instructions",
      rule: "ignore",
      source: "ignore",
    });

    // Function override for memory
    expect(effective.rules).toContainEqual({
      target: "test-fn",
      metric: "memory_bytes",
      rule: 5,
      source: "function_override",
    });

    const comment = renderComment(diff, [], "main", "abcdef123", effective);
    expect(comment).toContain("Effective Policy Rules");
    expect(comment).toContain("`test-fn`");
    expect(comment).toContain("ignore");
    expect(comment).toContain("function_override");
  });

  it("does not disclose unrelated configuration properties or tokens", () => {
    const diff = createMockDiff();
    const configWithTokens = {
      ...({ secret_token: "secret123", internal_api_key: "key_xyz" } as any),
      thresholds: {
        global: { fail_on_any_regression: true },
      },
    };

    const effective = resolveEffectivePolicy(
      diff,
      configWithTokens,
      mockOrigin,
    );
    const serialized = JSON.stringify(effective);
    expect(serialized).not.toContain("secret123");
    expect(serialized).not.toContain("key_xyz");
  });
});
