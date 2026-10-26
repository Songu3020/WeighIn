import type { getOctokit } from "@actions/github";
import type { PrRevisionSource } from "./pr-freshness";

type Octokit = ReturnType<typeof getOctokit>;

/** GitHub API adapter for the revision lookups used by the freshness check. */
export function createOctokitRevisionSource(
  octokit: Octokit,
  owner: string,
  repo: string,
): PrRevisionSource {
  return {
    async getCurrentHeadSha(prNumber) {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return data.head.sha;
    },
    async getCommitParents(sha) {
      const { data } = await octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: sha,
      });
      return data.parents.map((parent: { sha: string }) => parent.sha);
    },
  };
}
