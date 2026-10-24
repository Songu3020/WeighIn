import { describe, it, expect } from "vitest";
import records from "../docs/experiments/metric-provenance/measurements.json";

describe("archived schema-4 measurements", () => {
  it("keeps unsupported metrics explicitly unavailable rather than zero", () => {
    for (const contract of records) {
      expect(contract.schema_version).toBe(4);
      for (const benchmark of contract.benchmarks) {
        for (const key of [
          "historical_data_read_bytes",
          "contract_data_hard_limit",
          "tx_size_bytes",
        ]) {
          expect(benchmark.metrics[key].availability).toBe("unavailable");
          expect(benchmark.metrics[key].consumed).toBeNull();
          expect(benchmark.metrics[key].reason).toBeTruthy();
        }
      }
    }
  });
});
