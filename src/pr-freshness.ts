/**
 * Freshness checks for PR reports delivered by the comment consumer.
 *
 * Three revisions are involved and they are deliberately distinct:
 *  - producer: `workflow_run.head_sha` from the trusted workflow_run event, the
 *    pull request head the report was measured at;
 *  - metadata: `headSha` from the downloaded artifact. `actions/checkout` checks
 *    out the synthetic merge commit on `pull_request` events, so this is either
 *    the producer head or a merge commit that has it as a parent. It is written
 *    by the pull request's own workflow and is never used as the trust anchor;
 *  - current: the live pull request head read from the API.
 */

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface PrRevisionSource {
  getCurrentHeadSha(prNumber: number): Promise<string>;
  getCommitParents(sha: string): Promise<string[]>;
}

export type FreshnessResult =
  { fresh: true } | { fresh: false; reason: string };

export interface FreshnessInput {
  prNumber: number;
  producerSha: unknown;
  metadataSha: unknown;
}

const short = (sha: string): string => sha.slice(0, 8);

function requireSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a 40-character hexadecimal SHA`);
  }
  return value.toLowerCase();
}

export function assessFreshness(
  producerSha: unknown,
  currentHeadSha: unknown,
): FreshnessResult {
  const producer = requireSha(producerSha, "workflow run head SHA");
  const current = requireSha(currentHeadSha, "current pull request head SHA");
  if (producer === current) return { fresh: true };
  return {
    fresh: false,
    reason: `Skipped stale report: it was produced for ${short(producer)} but the pull request head is now ${short(current)}. The current comment was left untouched.`,
  };
}

async function assertMetadataMatchesRun(
  metadataSha: unknown,
  producer: string,
  source: PrRevisionSource,
): Promise<void> {
  const metadata = requireSha(metadataSha, "PR metadata headSha");
  if (metadata === producer) return;
  const parents = (await source.getCommitParents(metadata)).map((parent) =>
    parent.toLowerCase(),
  );
  if (!parents.includes(producer)) {
    throw new Error(
      `PR metadata headSha ${short(metadata)} is neither the producing run's head ${short(producer)} nor a merge commit of it`,
    );
  }
}

export async function evaluateReportFreshness(
  input: FreshnessInput,
  source: PrRevisionSource,
): Promise<FreshnessResult> {
  const producer = requireSha(input.producerSha, "workflow run head SHA");
  await assertMetadataMatchesRun(input.metadataSha, producer, source);
  const current = await source.getCurrentHeadSha(input.prNumber);
  return assessFreshness(producer, current);
}
