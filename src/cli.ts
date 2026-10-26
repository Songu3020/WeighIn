#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { runMeasurement } from "./measurement";
import { parseFixtures } from "./identity";
import { discoverSdkAssociations, formatSdkVersions } from "./sdk-version";
import { redactEndpointSecrets, sanitizeEndpoint } from "./endpoint";

function getGitCommit(): string {
  try {
    return execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return "unknown_commit";
  }
}

export interface CliOptions {
  fixturesPath: string;
  outputPath: string | null;
  rpcUrl: string;
  jsonStdout: boolean;
  allowCrossTargetSubstitution: boolean;
}

export function parseArgs(
  rawArgs: string[] = process.argv.slice(2),
): CliOptions {
  let fixturesPath: string | null = null;
  let explicitOutputFile: string | null = null;
  let jsonStdout = false;
  let rpcUrl = "http://localhost:8000/rpc";
  let allowCrossTargetSubstitution = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--rpc-url" && rawArgs[i + 1]) {
      rpcUrl = rawArgs[++i];
    } else if (arg === "--output" && rawArgs[i + 1]) {
      const target = rawArgs[++i];
      if (target === "-") {
        jsonStdout = true;
      } else {
        explicitOutputFile = target;
      }
    } else if (arg === "--stdout" || arg === "--json-stdout") {
      jsonStdout = true;
    } else if (arg === "--allow-cross-target-substitution") {
      allowCrossTargetSubstitution = true;
    } else if (!arg.startsWith("--")) {
      // Positional argument
      if (fixturesPath === null) {
        fixturesPath = arg;
      } else if (explicitOutputFile === null) {
        if (arg === "-") {
          jsonStdout = true;
        } else {
          explicitOutputFile = arg;
        }
      } else {
        throw new Error(`Unexpected argument: ${arg}`);
      }
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  // Reject ambiguous combinations before network side effects
  if (jsonStdout && explicitOutputFile !== null) {
    throw new Error(
      "Ambiguous output configuration: cannot specify both JSON stdout mode and an output file path",
    );
  }

  return {
    fixturesPath: fixturesPath || "weighin-fixtures.json",
    outputPath: jsonStdout
      ? null
      : explicitOutputFile || "weighin-results.json",
    rpcUrl,
    jsonStdout,
    allowCrossTargetSubstitution,
  };
}

export function writeResultsFile(outputPath: string, results: unknown): void {
  const targetDir = path.dirname(outputPath);
  if (targetDir && targetDir !== ".") {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const tempPath = path.join(
    targetDir,
    `.weighin-results-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );

  try {
    fs.writeFileSync(tempPath, JSON.stringify(results, null, 2), "utf8");
    fs.renameSync(tempPath, outputPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true, recursive: true });
    } catch {
      /* ignore own temporary cleanup failure */
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Output write failed for ${outputPath}: ${message}`);
  }
}

async function main() {
  let options: CliOptions;
  try {
    options = parseArgs();
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }

  const { fixturesPath, outputPath, rpcUrl, jsonStdout } = options;
  const gitCommit = getGitCommit();

  // When stdout mode is requested, route diagnostic and progress logs to stderr.
  // This is installed before any discovery output is produced so stdout carries
  // the JSON payload and nothing else.
  const originalLog = console.log;
  const originalInfo = console.info;
  if (jsonStdout) {
    console.log = (...args: any[]) => console.error(...args);
    console.info = (...args: any[]) => console.error(...args);
  }

  // Best-effort: resolve each fixture artifact to its owning Cargo
  // workspace/lock and report the `soroban-sdk` version declared there.
  // Filesystem only — no RPC — and reported per contract: multiple declared
  // versions are listed and unresolved associations say "unknown".
  let sdkSummary = "unknown";
  try {
    const fixturesRaw = fs.readFileSync(fixturesPath, "utf8");
    const fixturesSpec = parseFixtures(
      fixturesRaw,
      path.relative(process.cwd(), path.resolve(fixturesPath)),
    );
    const fixturesDir = path.dirname(path.resolve(fixturesPath));
    const wasmPaths = fixturesSpec.contracts.map((contract) =>
      path.resolve(fixturesDir, contract.wasm_path),
    );
    const associations = discoverSdkAssociations(wasmPaths);
    const versions = [
      ...new Set(associations.flatMap((assoc) => assoc.versions)),
    ];
    sdkSummary = formatSdkVersions(versions);
    for (const assoc of associations) {
      const relative = path.relative(process.cwd(), assoc.wasmPath);
      const lockHint = assoc.lockPath
        ? ` (lock: ${path.relative(process.cwd(), assoc.lockPath)})`
        : " (no lock found)";
      console.log(
        `SDK ${relative}: ${formatSdkVersions(assoc.versions)}${lockHint}`,
      );
    }
  } catch {
    /* ignore — SDK discovery is best-effort */
  }

  try {
    console.log(`Starting Weighin Benchmarking...`);
    console.log(`Fixtures: ${fixturesPath}`);
    console.log(`Output:   ${jsonStdout ? "stdout" : outputPath}`);
    console.log(`RPC URL:  ${sanitizeEndpoint(rpcUrl)}`);
    console.log(`Commit:   ${gitCommit}`);
    console.log(`SDK:      ${sdkSummary}`);

    const results = await runMeasurement({
      fixturesPath,
      gitCommit,
      rpcUrl,
      allowCrossTargetSubstitution: options.allowCrossTargetSubstitution,
    });
    writeResultsFile(outputPath, results);
    console.log(`Done. Results written to ${outputPath}`);
  } catch (error: any) {
    if (error instanceof Error && /Output write failed/.test(error.message)) {
      console.error(error.message);
      process.exit(1);
    }
    console.error(`Benchmarking failed:`, error);

    if (jsonStdout) {
      process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    } else if (outputPath) {
      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf8");
      console.log(`Done. Results written to ${outputPath}`);
    }
  } catch (error: any) {
    const detail = String(error?.stack ?? error?.message ?? error);
    console.error(
      `Benchmarking failed: ${redactEndpointSecrets(detail, rpcUrl)}`,
    );
    process.exit(1);
  } finally {
    if (jsonStdout) {
      console.log = originalLog;
      console.info = originalInfo;
    }
  }
}

// Only run main when executed as a script
if (require.main === module) {
  main();
}
