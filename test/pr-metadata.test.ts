import { describe, it, expect } from "vitest";
import {
  buildPrMetadata,
  parsePrMetadata,
  PR_METADATA_SCHEMA_VERSION,
} from "../src/pr-metadata";

const headSha = "f".repeat(40);

describe("buildPrMetadata", () => {
  it("emits the versioned producer shape", () => {
    expect(buildPrMetadata("WeighInNG/WeighIn", 27, headSha)).toEqual({
      schemaVersion: PR_METADATA_SCHEMA_VERSION,
      repository: "WeighInNG/WeighIn",
      prNumber: 27,
      headSha,
    });
  });
});

describe("parsePrMetadata", () => {
  it("round-trips a producer artifact for the trusted repository", () => {
    const raw = JSON.stringify(
      buildPrMetadata("WeighInNG/WeighIn", 27, headSha),
    );
    expect(parsePrMetadata(raw, "WeighInNG/WeighIn")).toEqual({
      schemaVersion: 1,
      repository: "WeighInNG/WeighIn",
      prNumber: 27,
      headSha,
    });
  });

  it("matches the trusted repository case-insensitively", () => {
    const raw = JSON.stringify(
      buildPrMetadata("weighinng/weighin", 27, headSha),
    );
    expect(parsePrMetadata(raw, "WeighInNG/WeighIn").prNumber).toBe(27);
  });

  it("rejects unsupported metadata before returning a number", () => {
    const cases: Array<[string, string]> = [
      ["malformed JSON", "{ not json"],
      ["legacy unversioned metadata", JSON.stringify({ prNumber: 27 })],
      [
        "unsupported schema version",
        JSON.stringify({
          ...buildPrMetadata("WeighInNG/WeighIn", 27, headSha),
          schemaVersion: 2,
        }),
      ],
      [
        "another repository",
        JSON.stringify(buildPrMetadata("attacker/WeighIn", 27, headSha)),
      ],
      [
        "string PR number",
        JSON.stringify({
          ...buildPrMetadata("WeighInNG/WeighIn", 27, headSha),
          prNumber: "27",
        }),
      ],
      [
        "malformed SHA",
        JSON.stringify({
          ...buildPrMetadata("WeighInNG/WeighIn", 27, headSha),
          headSha: "abc",
        }),
      ],
    ];
    for (const [label, raw] of cases) {
      expect(() => parsePrMetadata(raw, "WeighInNG/WeighIn"), label).toThrow();
    }
  });
});
