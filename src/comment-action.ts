import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import { parsePrMetadata } from "./pr-metadata";
import { upsertPrComment, CommentAuthorMode } from "./comment";

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

    await upsertPrComment(token, metadata.prNumber, reportBody, {
      commentAuthorMode,
      core,
    });
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
