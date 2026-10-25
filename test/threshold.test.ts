import { describe, it, expect } from "vitest";
import {
  enforceThresholds,
  GlobalThresholds,
  WeighinConfig,
} from "../src/threshold";
import { DiffResult, MetricKey } from "../src/diff";

function createMockDiff(
  key: MetricKey,
  delta: number,
  pct: number | null,
  regression: boolean,
): DiffResult {
  return {
    contracts: [
      {
        contract_id: "contract-a",
        base_commit: "abc",
        head_commit: "def",
        hasRegression: regression,
        newFunctions: [],
        removedFunctions: [],
        functions: [
          {
            function_name: "test-fn",
            hasRegression: regression,
            metrics: [
              {
                key,
                base: { consumed: 100, limit: 0 },
                head: { consumed: 100 + delta, limit: 0 },
                delta,
                pct,
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

describe("enforceThresholds", () => {
  it("returns empty violations if config or thresholds are empty", () => {
    const diff = createMockDiff("cpu_instructions", 10, 10, true);
    expect(enforceThresholds(diff, null)).toEqual([]);
    expect(enforceThresholds(diff, {})).toEqual([]);
    expect(enforceThresholds(diff, { thresholds: {} })).toEqual([]);
  });

  it("requires a matched benchmark for configured global absolute limits", () => {
    const emptyDiff: DiffResult = {
      contracts: [],
      hasRegression: false,
      newContracts: [],
      removedContracts: [],
    };
    const config: WeighinConfig = {
      limits: { global: { cpu_instructions: 100 } },
    };

    expect(() => enforceThresholds(emptyDiff, config)).toThrow(
      /global policy or limits: no matched BASE\/HEAD benchmarks/,
    );
    expect(enforceThresholds(emptyDiff, { limits: { global: {} } })).toEqual(
      [],
    );
    expect(enforceThresholds(emptyDiff, null)).toEqual([]);
  });

  it("rejects global absolute limits when all cases are unmatched", () => {
    const diff: DiffResult = {
      contracts: [
        {
          contract_id: "contract-a",
          base_contract_id: "base-contract",
          head_contract_id: "head-contract",
          base_commit: "abc",
          head_commit: "def",
          functions: [],
          hasRegression: false,
          newFunctions: ["new-fn"],
          removedFunctions: [],
          newBenchmarks: [{ function_name: "new-fn", case_id: "args:[]" }],
          removedBenchmarks: [],
        },
      ],
      hasRegression: false,
      newContracts: [],
      removedContracts: [],
    };

    expect(() =>
      enforceThresholds(diff, {
        limits: { global: { cpu_instructions: 100 } },
      }),
    ).toThrow(/no matched BASE\/HEAD benchmarks/);
  });

  it("handles fail_on_any_regression", () => {
    const diff = createMockDiff("cpu_instructions", 10, 10, true);
    const config: WeighinConfig = {
      thresholds: { global: { fail_on_any_regression: true } },
    };
    const violations = enforceThresholds(diff, config);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("fail_on_any_regression");
  });

  it("respects max_allowed_cpu_increase_pct global rule", () => {
    const diff = createMockDiff("cpu_instructions", 10, 10, true); // 10% increase
    const config: WeighinConfig = {
      thresholds: { global: { max_allowed_cpu_increase_pct: 5 } },
    };
    const violations = enforceThresholds(diff, config);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("allow_5_percent_increase");

    const configPass: WeighinConfig = {
      thresholds: { global: { max_allowed_cpu_increase_pct: 15 } },
    };
    expect(enforceThresholds(diff, configPass)).toEqual([]);
  });

  it("strict_zero_tolerance catches any regression", () => {
    const diff = createMockDiff("events_count", 1, 1, true);
    const config: WeighinConfig = {
      thresholds: {
        functions: { "test-fn": { events_count: "strict_zero_tolerance" } },
      },
    };
    const violations = enforceThresholds(diff, config);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("strict_zero_tolerance");
  });

  it("strict_zero_tolerance passes if no regression", () => {
    const diff = createMockDiff("events_count", -1, -1, false);
    const config: WeighinConfig = {
      thresholds: {
        functions: { "test-fn": { events_count: "strict_zero_tolerance" } },
      },
    };
    const violations = enforceThresholds(diff, config);
    expect(violations).toEqual([]); // No violation if improvement
  });

  it("ignore rule skips violations even with global fail_on_any_regression", () => {
    const diff = createMockDiff("cpu_instructions", 10, 10, true);
    const config: WeighinConfig = {
      thresholds: {
        global: { fail_on_any_regression: true },
        functions: { "test-fn": { cpu_instructions: "ignore" } },
      },
    };
    const violations = enforceThresholds(diff, config);
    expect(violations).toEqual([]);
  });

  it("handles Infinity percentage (division by zero) correctly", () => {
    const diff = createMockDiff("cpu_instructions", 10, null, true); // pct = null
    const config: WeighinConfig = {
      thresholds: { global: { max_allowed_cpu_increase_pct: 100 } },
    };
    const violations = enforceThresholds(diff, config);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("Infinity");
  });

  describe("Absolute limits", () => {
    it("fails when absolute limit is exceeded", () => {
      const config = {
        limits: {
          global: {
            cpu_instructions: 50,
          },
        },
      };
      const diff = {
        contracts: [
          {
            contract_id: "c1",
            functions: [
              {
                function_name: "test",
                metrics: [
                  {
                    key: "cpu_instructions",
                    base: { consumed: 10, limit: 100 },
                    head: { consumed: 51, limit: 100 },
                    delta: 41,
                    pct: 410,
                    regression: true,
                  },
                ],
              },
            ],
          },
        ],
      };

      const v = enforceThresholds(diff as any, config as any);
      expect(v).toHaveLength(1);
      expect(v[0].rule).toBe("absolute_limit(50)");
      expect(v[0].message).toContain("exceeded absolute limit");
    });

    it("passes when absolute limit is exactly met or below", () => {
      const config = {
        limits: {
          global: {
            cpu_instructions: 51,
          },
          functions: {
            test: {
              memory_bytes: 50,
            },
          },
        },
      };
      const diff = {
        contracts: [
          {
            contract_id: "c1",
            functions: [
              {
                function_name: "test",
                metrics: [
                  {
                    key: "cpu_instructions",
                    base: { consumed: 0, limit: 100 },
                    head: { consumed: 51, limit: 100 },
                    delta: 51,
                    pct: null,
                    regression: true,
                  },
                  {
                    key: "memory_bytes",
                    base: { consumed: 0, limit: 100 },
                    head: { consumed: 40, limit: 100 },
                    delta: 40,
                    pct: null,
                    regression: true,
                  },
                ],
              },
            ],
          },
        ],
      };

      const v = enforceThresholds(diff as any, config as any);
      expect(v).toHaveLength(0);
    });

    it("evaluates absolute and regression limits independently (both fail)", () => {
      const config = {
        limits: {
          global: { cpu_instructions: 50 },
        },
        thresholds: {
          global: { max_allowed_cpu_increase_pct: 10 },
        },
      };
      const diff = {
        contracts: [
          {
            contract_id: "c1",
            functions: [
              {
                function_name: "test",
                metrics: [
                  {
                    key: "cpu_instructions",
                    base: { consumed: 10, limit: 100 },
                    head: { consumed: 51, limit: 100 },
                    delta: 41,
                    pct: 410,
                    regression: true,
                  },
                ],
              },
            ],
          },
        ],
      };
      const v = enforceThresholds(diff as any, config as any);
      expect(v).toHaveLength(2);
      expect(v[0].rule).toBe("absolute_limit(50)");
      expect(v[1].rule).toBe("allow_10_percent_increase");
    });
  });
});
