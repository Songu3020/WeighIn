/**
 * Versioned PR metadata shared by the producer Action and the comment consumer.
 *
 * The producer writes the trusted repository (the base repository that owns the
 * comment workflow), the triggering pull request number and the measured HEAD
 * commit. The consumer re-validates every field against its own trusted
 * repository before it makes any GitHub API mutation.
 */

export const PR_METADATA_SCHEMA_VERSION = 1;

export interface PrMetadata {
  schemaVersion: number;
  repository: string;
  prNumber: number;
  headSha: string;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function buildPrMetadata(
  repository: string,
  prNumber: number,
  headSha: string,
): PrMetadata {
  return {
    schemaVersion: PR_METADATA_SCHEMA_VERSION,
    repository,
    prNumber,
    headSha,
  };
}

/**
 * Validate a downloaded PR metadata artifact.
 *
 * Rejects malformed JSON, non-object payloads, legacy unversioned metadata,
 * unsupported schema versions, a repository that does not match the trusted
 * consumer repository, non-positive/non-integer PR numbers and malformed
 * 40-character hexadecimal SHAs. Repository comparison is case-insensitive.
 */
export function parsePrMetadata(
  raw: string,
  expectedRepository: string,
): PrMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PR metadata is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PR metadata must be a JSON object");
  }
  const metadata = parsed as Record<string, unknown>;

  if (!Object.prototype.hasOwnProperty.call(metadata, "schemaVersion")) {
    throw new Error(
      "Legacy unversioned PR metadata is not supported; schemaVersion is required",
    );
  }
  if (metadata.schemaVersion !== PR_METADATA_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported PR metadata schemaVersion: ${JSON.stringify(metadata.schemaVersion)}`,
    );
  }
  if (
    typeof metadata.repository !== "string" ||
    metadata.repository.trim() === ""
  ) {
    throw new Error("PR metadata repository is missing");
  }
  if (
    metadata.repository.toLowerCase() !==
    expectedRepository.trim().toLowerCase()
  ) {
    throw new Error(
      `PR metadata repository ${metadata.repository} does not match trusted repository ${expectedRepository}`,
    );
  }
  if (
    typeof metadata.prNumber !== "number" ||
    !Number.isSafeInteger(metadata.prNumber) ||
    metadata.prNumber <= 0
  ) {
    throw new Error("PR metadata prNumber must be a positive integer");
  }
  if (
    typeof metadata.headSha !== "string" ||
    !SHA_PATTERN.test(metadata.headSha)
  ) {
    throw new Error(
      "PR metadata headSha must be a 40-character hexadecimal SHA",
    );
  }

  return {
    schemaVersion: metadata.schemaVersion,
    repository: metadata.repository,
    prNumber: metadata.prNumber,
    headSha: metadata.headSha,
  };
}
