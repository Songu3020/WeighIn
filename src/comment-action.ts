import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import { parsePrMetadata } from "./pr-metadata";
import { evaluateReportFreshness } from "./pr-freshness";
import { createOctokitRevisionSource } from "./pr-revision-source";
import { upsertPrComment, CommentAuthorMode } from "./comment";

async function reportSkipped(reason: string): Promise<void> {
  core.warning(reason);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addHeading("WeighIn comment skipped", 3)
      .addRaw(reason, true)
      .write();
  }
}

async function run(): Promise<void> {
  try {
    const reportPath = core.getInput("report-path", { required: true });
    const metadataPath = core.getInput("metadata-path", { required: true });
    const token = core.getInput("github-token", { required: true });
    const commentAuthorModeRaw =
      core.getInput("comment-author-mode") || "github-actions";
    if (
      commentAuthorModeRaw !== "github-actions" &&
      commentAuthorModeRaw !== "authenticated-user"
    ) {
      throw new Error(
        `Unsupported comment-author-mode: "${commentAuthorModeRaw}". ` +
          'Supported values are "github-actions" and "authenticated-user".',
      );
    }
    const commentAuthorMode = commentAuthorModeRaw as CommentAuthorMode;

    if (!fs.existsSync(reportPath)) {
      throw new Error(`Report file not found: ${reportPath}`);
    }
    if (!fs.existsSync(metadataPath)) {
      throw new Error(`Metadata file not found: ${metadataPath}`);
    }

    const reportBody = fs.readFileSync(reportPath, "utf8");
    const metadataRaw = fs.readFileSync(metadataPath, "utf8");
    const { owner, repo } = github.context.repo;
    const metadata = parsePrMetadata(metadataRaw, `${owner}/${repo}`);

    const freshness = await evaluateReportFreshness(
      {
        prNumber: metadata.prNumber,
        producerSha: github.context.payload.workflow_run?.head_sha,
        metadataSha: metadata.headSha,
      },
      createOctokitRevisionSource(github.getOctokit(token), owner, repo),
    );
    if (!freshness.fresh) {
      await reportSkipped(freshness.reason);
      return;
    }

    await upsertPrComment(token, metadata.prNumber, reportBody, {
      commentAuthorMode,
      core,
    });
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
