import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { runMeasurement, ContractBenchmark } from "./measurement";
import { diffBenchmarks, DiffResult, contractLabel } from "./diff";
import {
  loadConfig,
  loadConfigContent,
  policyContentSha256,
  enforceThresholds,
  resolveEffectivePolicy,
  Violation,
  PolicyOrigin,
} from "./threshold";

import { renderComment } from "./comment";
import { buildForRevision, parseOptionalBooleanInput } from "./build-selection";
import { writeReportFile, generateFailureReport } from "./report";
import { buildPrMetadata } from "./pr-metadata";
import {
  parseJsonRpcResponse,
  redactEndpointSecrets,
  sanitizeEndpoint,
} from "./endpoint";
import {
  SUPPORTED_NETWORK_PASSPHRASE,
  SUPPORTED_PROTOCOL_VERSION,
} from "./network";
import {
  isWorkspaceClean,
  getModifiedFiles,
  getHeadSha,
  capture,
  captureRaw,
} from "./git-utils";

// The configured endpoint is tracked only so the terminal failure path can
// redact any credential it may contain before reporting.
let configuredRpcUrl = "";
let validatedDiffJson: string | null = null;

class RpcCompatibilityError extends Error {}

// ---------------------------------------------------------------------------
// RPC health check
// ---------------------------------------------------------------------------

/**
 * Verify that the RPC endpoint is reachable and responding to getHealth and getNetwork.
 * Fails the action with a clear message if not — the caller is responsible
 * for starting the network before invoking this action.
 */
async function assertRpcHealthy(rpcUrl: string): Promise<void> {
  core.info(`Checking RPC health at ${sanitizeEndpoint(rpcUrl)} ...`);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const health = parseJsonRpcResponse(await res.text(), 1);
    if ("error" in health) {
      throw new Error(
        `RPC getHealth method error: ${JSON.stringify(health.error)}`,
      );
    }
    if ((health.result as any)?.status !== "healthy")
      throw new Error("RPC has not reported healthy");
    const network = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getNetwork" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!network.ok)
      throw new Error(`HTTP ${network.status} ${network.statusText}`);
    const metadata = parseJsonRpcResponse(await network.text(), 2);
    if ("error" in metadata) {
      throw new Error(
        `RPC getNetwork method error: ${JSON.stringify(metadata.error)}`,
      );
    }
    const networkResult = metadata.result as {
      passphrase?: unknown;
      protocolVersion?: unknown;
    } | null;
    if (
      typeof networkResult?.passphrase !== "string" ||
      !networkResult.passphrase.trim() ||
      !Number.isInteger(networkResult.protocolVersion)
    ) {
      throw new RpcCompatibilityError(
        "RPC is healthy but incompatible: invalid network metadata (a passphrase and integer protocolVersion are required)",
      );
    }
    if (networkResult.passphrase !== SUPPORTED_NETWORK_PASSPHRASE)
      throw new RpcCompatibilityError(
        `RPC is healthy but incompatible: unsupported network passphrase (expected "${SUPPORTED_NETWORK_PASSPHRASE}")`,
      );
    if (networkResult.protocolVersion !== SUPPORTED_PROTOCOL_VERSION)
      throw new RpcCompatibilityError(
        `RPC is healthy but incompatible: unsupported protocol ${networkResult.protocolVersion} (only protocol ${SUPPORTED_PROTOCOL_VERSION} is supported)`,
      );
    core.info(`RPC healthy — network: ${networkResult.passphrase}`);
  } catch (err: any) {
    const diagnostic =
      err instanceof RpcCompatibilityError
        ? err.message
        : `Soroban RPC at ${sanitizeEndpoint(rpcUrl)} is not reachable: ${redactEndpointSecrets(String(err?.message ?? err), rpcUrl)}\n` +
          `Start the network before invoking this action (e.g. via stellar/quickstart ` +
          `or scripts/start-local-network.sh), then pass its URL as the rpc-url input.`;
    core.setFailed(diagnostic);
    throw err; // halt execution
  }
}

async function validateBaseRef(repoRoot: string, ref: string): Promise<void> {
  if (!ref.trim() || ref !== ref.trim() || ref.startsWith("-")) {
    throw new Error(
      "Invalid base-ref: provide a non-empty branch, tag, or commit SHA without surrounding whitespace or option prefixes",
    );
  }
  if (/^[0-9a-fA-F]{7,40}$/.test(ref)) return;

  const branchRef = await exec.exec(
    "git",
    ["check-ref-format", `refs/heads/${ref}`],
    { cwd: repoRoot, ignoreReturnCode: true, silent: true },
  );
  const tagRef = await exec.exec(
    "git",
    ["check-ref-format", `refs/tags/${ref}`],
    { cwd: repoRoot, ignoreReturnCode: true, silent: true },
  );
  if (branchRef !== 0 && tagRef !== 0) {
    throw new Error(
      `Invalid base-ref "${ref}": expected a valid branch, tag, or commit SHA`,
    );
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Resolve fixture inputs only when the lexical and real paths stay in a revision. */
function resolveRevisionFixturesPath(
  worktreeRoot: string,
  fixturesPathInput: string,
  revision: "HEAD" | "BASE",
): string {
  const invalidPathMessage = `fixtures-path for ${revision} must be a relative path inside the ${revision} worktree`;
  if (
    !fixturesPathInput.trim() ||
    path.isAbsolute(fixturesPathInput) ||
    path.win32.isAbsolute(fixturesPathInput) ||
    /^[A-Za-z]:/.test(fixturesPathInput)
  ) {
    throw new Error(invalidPathMessage);
  }

  const root = path.resolve(worktreeRoot);
  const resolved = path.resolve(root, fixturesPathInput);
  if (!isPathWithin(root, resolved)) throw new Error(invalidPathMessage);

  try {
    const realRoot = fs.realpathSync(root);
    let current = root;
    for (const segment of path.relative(root, resolved).split(path.sep)) {
      if (!segment) continue;
      current = path.join(current, segment);
      let currentStats: fs.Stats;
      try {
        currentStats = fs.lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      if (
        currentStats.isSymbolicLink() &&
        !isPathWithin(realRoot, fs.realpathSync(current))
      ) {
        throw new Error(invalidPathMessage);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === invalidPathMessage)
      throw error;
    throw new Error(`${invalidPathMessage}: could not verify symlink targets`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadPolicy(
  repoDir: string,
  configPathRel: string,
  trustedRef: string,
  trustedPath: string,
): Promise<{ config: ReturnType<typeof loadConfig>; origin: PolicyOrigin }> {
  if (!trustedRef && !trustedPath) {
    const configPath = path.resolve(repoDir, configPathRel || "weighin.toml");
    const content = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8")
      : "";
    return {
      config: content ? loadConfigContent(content, configPath) : null,
      origin: {
        mode: "head",
        path: path.relative(repoDir, configPath),
        revision: await getHeadSha(repoDir),
        content_sha256: policyContentSha256(content),
      },
    };
  }
  if (!trustedRef || !trustedPath)
    throw new Error(
      "trusted-policy-ref and trusted-policy-path must be supplied together",
    );
  const fetched = await capture(
    "git",
    ["fetch", "--depth=1", "origin", trustedRef],
    repoDir,
  );
  void fetched;
  const revision = await capture("git", ["rev-parse", "FETCH_HEAD"], repoDir);
  const content = await captureRaw(
    "git",
    ["show", `${revision}:${trustedPath}`],
    repoDir,
  );
  if (!content.trim())
    throw new Error(
      `Trusted policy is missing or empty: ${trustedPath} at ${revision}`,
    );
  return {
    config: loadConfigContent(content, `${revision}:${trustedPath}`),
    origin: {
      mode: "trusted",
      path: trustedPath,
      revision,
      content_sha256: policyContentSha256(content),
    },
  };
}

/** Read soroban-sdk version from Cargo.lock (best-effort). */
function getSdkVersion(repoDir: string): string {
  // Try common locations: repo root Cargo.lock, or contract/Cargo.lock
  for (const rel of ["Cargo.lock", "contract/Cargo.lock"]) {
    const lockPath = path.join(repoDir, rel);
    try {
      if (fs.existsSync(lockPath)) {
        const lock = fs.readFileSync(lockPath, "utf8");
        const m = lock.match(/name = "soroban-sdk"\nversion = "([^"]+)"/);
        if (m) return m[1];
      }
    } catch {
      /* ignore */
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Two-directory checkout
// ---------------------------------------------------------------------------

/**
 * Check out a git ref into a fresh temporary directory using a bare clone
 * of the repository that is already checked out at repoRoot.
 *
 * Returns the path to the new directory and the resolved SHA.
 */
async function checkoutRef(
  repoRoot: string,
  ref: string,
  label: string,
): Promise<{ dir: string; sha: string }> {
  // Fetch the ref into the existing repo's object store, then use
  // git worktree add to get a clean directory without touching the
  // main workspace.
  await exec.exec("git", ["fetch", "--depth=1", "origin", ref], {
    cwd: repoRoot,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `weighin-${label}-`));
  core.info(`Checking out ${ref} into ${dir}`);
  try {
    await exec.exec("git", ["worktree", "add", "--detach", dir, "FETCH_HEAD"], {
      cwd: repoRoot,
    });
  } catch (error) {
    await removeWorktree(repoRoot, dir);
    throw error;
  }

  const sha = await getHeadSha(dir);
  core.info(`${label} SHA: ${sha}`);
  return { dir, sha };
}

/** Remove a worktree directory created by checkoutRef. */
async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  try {
    await exec.exec("git", ["worktree", "remove", "--force", dir], {
      cwd: repoRoot,
    });
  } catch {
    // Non-fatal; runner will clean up temp dirs anyway
    core.warning(`Could not remove git worktree at ${dir}`);
  }
}

// ---------------------------------------------------------------------------
// PR comment management
// ---------------------------------------------------------------------------

const COMMENT_MARKER = "<!-- weighin-report -->";

async function upsertPrComment(token: string, body: string): Promise<void> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const prNumber = github.context.payload.pull_request?.number;

  if (!prNumber) {
    core.warning("Not in a pull_request context; skipping PR comment.");
    return;
  }

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });

  const existing = comments.find((c: { id: number; body?: string | null }) =>
    c.body?.includes(COMMENT_MARKER),
  );

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    core.info(`Updated PR comment #${existing.id}`);
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    core.info("Created new PR comment");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  validatedDiffJson = null;
  let keyDir: string | null = null;
  let sharedKeyFile: string | null = null;

  try {
    const fixturesPathRel = core.getInput("fixtures-path", { required: true });
    const configPathRel = core.getInput("config-path");
    const trustedPolicyRef = core.getInput("trusted-policy-ref").trim();
    const trustedPolicyPath = core.getInput("trusted-policy-path").trim();
    const rpcUrl = core.getInput("rpc-url") || "http://localhost:8000/rpc";
    configuredRpcUrl = rpcUrl;
    const githubToken = core.getInput("github-token");
    const baseRefInput = core.getInput("base-ref", { trimWhitespace: false });
    const rustToolchain = core.getInput("rust-toolchain");
    const reportPathInput = core.getInput("report-path");
    const metadataPathInput = core.getInput("metadata-path");
    const buildCommand = core.getInput("build-command");
    const skipBuild = parseOptionalBooleanInput("skip-build", false);

    if (buildCommand && skipBuild) {
      throw new Error("build-command and skip-build cannot be used together");
    }

    // The runner's checkout of the PR head is at GITHUB_WORKSPACE
    const headWorkspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();

    if (baseRefInput.length > 0 && baseRefInput !== baseRefInput.trim()) {
      throw new Error(
        "Invalid base-ref: empty or surrounding whitespace is not allowed",
      );
    }
    const baseRef =
      baseRefInput.trim() ||
      github.context.payload.pull_request?.base?.ref ||
      "main";
    await validateBaseRef(headWorkspace, baseRef);

    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-key-"));
    fs.chmodSync(keyDir, 0o700);
    sharedKeyFile = path.join(keyDir, "weighin-deployer.key");

    core.info(`Base ref:   ${baseRef}`);
    core.info(`RPC URL:    ${sanitizeEndpoint(rpcUrl)}`);
    core.info(`Fixtures:   ${fixturesPathRel}`);
    core.info(`Key file:   ${sharedKeyFile}`);

    // 1. RPC health check — fail fast with a clear message
    await assertRpcHealthy(rpcUrl);

    // 2. Resolve paths from the HEAD workspace (fixtures, config live there)
    const headFixturesPath = resolveRevisionFixturesPath(
      headWorkspace,
      fixturesPathRel,
      "HEAD",
    );
    const fixtureId = path
      .relative(path.resolve(headWorkspace), headFixturesPath)
      .split(path.sep)
      .join("/");
    const policy = await loadPolicy(
      headWorkspace,
      configPathRel,
      trustedPolicyRef,
      trustedPolicyPath,
    );
    const config = policy.config;

    if (!fs.existsSync(headFixturesPath)) {
      throw new Error(`fixtures-path not found: ${headFixturesPath}`);
    }

    // 3. Measure HEAD (the PR branch — already checked out at headWorkspace)
    core.startGroup("Building + measuring HEAD");
    const headSha = await getHeadSha(headWorkspace);
    core.info(`HEAD SHA: ${headSha}`);

    // Check for uncommitted changes to ensure benchmarks reflect the reported HEAD
    const isClean = await isWorkspaceClean(headWorkspace);
    if (!isClean) {
      const modifiedFiles = await getModifiedFiles(headWorkspace);
      throw new Error(
        `HEAD workspace has uncommitted changes. Benchmark measurements must reflect the reported git HEAD revision. Modified files:\n${modifiedFiles.map((f) => `  - ${f}`).join("\n")}\n\nCommit or stash changes before running benchmarks.`,
      );
    }

    let headResults: ContractBenchmark[];
    try {
      await buildForRevision(
        headFixturesPath,
        headWorkspace,
        rustToolchain,
        buildCommand,
        skipBuild,
      );
      headResults = await runMeasurement({
        fixturesPath: headFixturesPath,
        fixtureId,
        gitCommit: headSha,
        sdkVersion: getSdkVersion(headWorkspace),
        rpcUrl,
        keyFile: sharedKeyFile,
      });
    } catch (err: any) {
      throw new Error(`HEAD measurement failed: ${err.message}`);
    } finally {
      core.endGroup();
    }

    // Log WASM hashes from HEAD for the determinism audit trail
    for (const contract of headResults) {
      for (const bench of contract.benchmarks) {
        core.info(
          `[HEAD] WASM SHA256 (${bench.function_name}): ${bench.wasm_sha256}`,
        );
      }
    }

    // 4. Check out base ref into a separate worktree — never touch headWorkspace
    core.startGroup(`Building + measuring base (${baseRef})`);
    let baseResults: ContractBenchmark[] | null = null;
    let baseDir: string | null = null;
    let baseSha = "unknown";

    try {
      const checkout = await checkoutRef(headWorkspace, baseRef, "base");
      baseDir = checkout.dir;
      baseSha = checkout.sha;

      // The fixtures file in the base worktree — same relative path
      const baseFixturesPath = resolveRevisionFixturesPath(
        baseDir,
        fixturesPathRel,
        "BASE",
      );
      if (!fs.existsSync(baseFixturesPath)) {
        throw new Error("fixtures-path not found in base ref");
      } else {
        await buildForRevision(
          baseFixturesPath,
          baseDir,
          rustToolchain,
          buildCommand,
          skipBuild,
        );
        baseResults = await runMeasurement({
          fixturesPath: baseFixturesPath,
          fixtureId,
          gitCommit: baseSha,
          sdkVersion: getSdkVersion(baseDir),
          rpcUrl,
          keyFile: sharedKeyFile,
        });

        // Log WASM hashes from base
        for (const contract of baseResults) {
          for (const bench of contract.benchmarks) {
            core.info(
              `[BASE] WASM SHA256 (${bench.function_name}): ${bench.wasm_sha256}`,
            );
          }
        }
      }
    } catch (err: any) {
      throw new Error(
        `Required BASE comparison failed: ${err.message}. Policies were not evaluated.`,
      );
    } finally {
      if (baseDir) await removeWorktree(headWorkspace, baseDir);
      core.endGroup();
    }

    if (!baseResults)
      throw new Error(
        "Required BASE comparison unavailable. Policies were not evaluated.",
      );

    // 6. Diff
    core.startGroup("Computing diff");
    const diff: DiffResult = diffBenchmarks(baseResults, headResults);
    if (!diff.contracts.some((contract) => contract.functions.length > 0)) {
      throw new Error(
        "No matched BASE/HEAD benchmarks; comparison and policies were not evaluated.",
      );
    }
    core.info(`Any regression: ${diff.hasRegression}`);
    core.endGroup();

    // 7. Threshold enforcement
    core.startGroup("Enforcing thresholds");
    if (config) {
      core.info("weighin.toml loaded");
    } else {
      core.info("No weighin.toml found — no thresholds enforced");
    }
    const violations: Violation[] = enforceThresholds(diff, config);
    validatedDiffJson = JSON.stringify(diff);
    core.info(`Violations: ${violations.length}`);
    for (const v of violations) {
      if (v.aggregate_id) {
        core.error(`[aggregate: ${v.aggregate_id}] ${v.message}`);
      } else {
        core.error(
          `[${contractLabel(v as any)} / ${v.function_name} / ${v.case_id}] ${v.message}`,
        );
      }
    }
    core.endGroup();

    // 8. Outputs
    const result = violations.length > 0 ? "fail" : "pass";
    core.setOutput("result", result);
    core.setOutput("diff-json", validatedDiffJson);

    // Report is available in the job summary even without permission to post a PR comment.
    const effectivePolicy = resolveEffectivePolicy(diff, config, policy.origin);
    const body = renderComment(
      diff,
      violations,
      baseRef,
      headSha,
      effectivePolicy,
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      await core.summary.addRaw(body).write();
    if (reportPathInput) writeReportFile(reportPathInput, headWorkspace, body);
    if (metadataPathInput) {
      const prNumber = github.context.payload.pull_request?.number;
      if (prNumber) {
        const destination = path.resolve(headWorkspace, metadataPathInput);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const { owner, repo } = github.context.repo;
        const metadata = buildPrMetadata(`${owner}/${repo}`, prNumber, headSha);
        fs.writeFileSync(
          destination,
          JSON.stringify(metadata, null, 2),
          "utf8",
        );
      }
    }

    // 9. PR comment
    if (githubToken) {
      core.startGroup("Posting PR comment");
      try {
        await upsertPrComment(githubToken, body);
      } catch (err: any) {
        core.warning(`Failed to post PR comment: ${err.message}`);
      }
      core.endGroup();
    }

    // 10. Exit status
    if (violations.length > 0) {
      core.setFailed(`${violations.length} threshold violation(s) detected`);
    }
  } finally {
    if (keyDir) {
      try {
        fs.rmSync(keyDir, { recursive: true, force: true });
        core.info(`Removed owned deployer key directory: ${keyDir}`);
      } catch (err: any) {
        core.warning(
          `Could not remove deployer key directory ${keyDir}: ${err.message}`,
        );
      }
    }
  }
}

run().catch(async (error: Error) => {
  const message = redactEndpointSecrets(
    String(error?.message ?? error),
    configuredRpcUrl,
  );
  core.setOutput("result", "fail");
  core.setOutput("diff-json", validatedDiffJson ?? "{}");
  core.setFailed(message);

  const reportPathInput = core.getInput("report-path");
  const headWorkspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
  if (reportPathInput) {
    try {
      const failureReport = generateFailureReport(message);
      writeReportFile(reportPathInput, headWorkspace, failureReport);
    } catch (writeErr: any) {
      core.warning(
        `Failed to write unsuccessful-comparison report: ${writeErr.message}`,
      );
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addRaw(
        `## WeighIn comparison failed\n\n${message}\n\nNo passing comparison or policy result was established.\n`,
      )
      .write();
  }
});
