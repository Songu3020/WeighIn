import { describe, expect, it } from "vitest";
import type { PrRevisionSource } from "../src/pr-freshness";
import { assessFreshness, evaluateReportFreshness } from "../src/pr-freshness";

const HEAD = "f".repeat(40);
const NEWER = "e".repeat(40);
const MERGE = "c".repeat(40);
const BASE = "b".repeat(40);

function source(overrides: Partial<PrRevisionSource> = {}): PrRevisionSource {
  return {
    getCurrentHeadSha: async () => HEAD,
    getCommitParents: async () => {
      throw new Error("unexpected commit lookup");
    },
    ...overrides,
  };
}

describe("assessFreshness", () => {
  it("accepts a report built from the current head", () => {
    expect(assessFreshness(HEAD, HEAD)).toEqual({ fresh: true });
  });

  it("compares SHAs case-insensitively", () => {
    expect(assessFreshness(HEAD.toUpperCase(), HEAD)).toEqual({ fresh: true });
  });

  it("reports a stale head with a visible reason naming both revisions", () => {
    const result = assessFreshness(HEAD, NEWER);
    expect(result.fresh).toBe(false);
    if (!result.fresh) {
      expect(result.reason).toMatch(/Skipped stale report/);
      expect(result.reason).toContain(HEAD.slice(0, 8));
      expect(result.reason).toContain(NEWER.slice(0, 8));
    }
  });

  it("rejects malformed SHAs instead of guessing", () => {
    expect(() => assessFreshness("abc123", HEAD)).toThrow(/40-character/);
    expect(() => assessFreshness(HEAD, "")).toThrow(/40-character/);
  });
});

describe("evaluateReportFreshness", () => {
  it("is fresh when producer, metadata and current head agree, without a commit lookup", async () => {
    await expect(
      evaluateReportFreshness(
        { prNumber: 27, producerSha: HEAD, metadataSha: HEAD },
        source(),
      ),
    ).resolves.toEqual({ fresh: true });
  });

  it("is stale when the pull request has moved on", async () => {
    const result = await evaluateReportFreshness(
      { prNumber: 27, producerSha: HEAD, metadataSha: HEAD },
      source({ getCurrentHeadSha: async () => NEWER }),
    );
    expect(result.fresh).toBe(false);
  });

  it("accepts metadata that is the synthetic merge commit of the producing head", async () => {
    const looked: string[] = [];
    const result = await evaluateReportFreshness(
      { prNumber: 27, producerSha: HEAD, metadataSha: MERGE },
      source({
        getCommitParents: async (sha) => {
          looked.push(sha);
          return [BASE, HEAD];
        },
      }),
    );
    expect(result).toEqual({ fresh: true });
    expect(looked).toEqual([MERGE]);
  });

  it("rejects metadata that is neither the run head nor its merge commit", async () => {
    await expect(
      evaluateReportFreshness(
        { prNumber: 27, producerSha: HEAD, metadataSha: MERGE },
        source({ getCommitParents: async () => [BASE] }),
      ),
    ).rejects.toThrow(/neither the producing run's head/);
  });

  it("fails closed when the event revision is missing or malformed", async () => {
    for (const producerSha of [undefined, "", "abc123", 42]) {
      await expect(
        evaluateReportFreshness(
          { prNumber: 27, producerSha, metadataSha: HEAD },
          source(),
        ),
      ).rejects.toThrow(/workflow run head SHA/);
    }
  });

  it("propagates lookup failures instead of treating them as fresh", async () => {
    await expect(
      evaluateReportFreshness(
        { prNumber: 27, producerSha: HEAD, metadataSha: HEAD },
        source({
          getCurrentHeadSha: async () => {
            throw new Error("boom");
          },
        }),
      ),
    ).rejects.toThrow("boom");
  });
});
