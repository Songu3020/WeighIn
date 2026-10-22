#!/usr/bin/env node
import * as fs from "fs";
import { execSync } from "child_process";
import { runMeasurement } from "./measurement";
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

  // Best-effort: read soroban-sdk version from contract/Cargo.lock if present
  let sdkVersion = "unknown";
  try {
    const lock = fs.readFileSync("contract/Cargo.lock", "utf8");
    const m = lock.match(/name = "soroban-sdk"\nversion = "([^"]+)"/);
    if (m) sdkVersion = m[1];
  } catch {
    /* ignore */
  }

  // When stdout mode is requested, route diagnostic and progress logs to stderr
  const originalLog = console.log;
  const originalInfo = console.info;
  if (jsonStdout) {
    console.log = (...args: any[]) => console.error(...args);
    console.info = (...args: any[]) => console.error(...args);
  }

  try {
    console.log(`Starting Weighin Benchmarking...`);
    console.log(`Fixtures: ${fixturesPath}`);
    console.log(`Output:   ${jsonStdout ? "stdout" : outputPath}`);
    console.log(`RPC URL:  ${sanitizeEndpoint(rpcUrl)}`);
    console.log(`Commit:   ${gitCommit}`);
    console.log(`SDK:      ${sdkVersion}`);

    const results = await runMeasurement({
      fixturesPath,
      gitCommit,
      sdkVersion,
      rpcUrl,
      allowCrossTargetSubstitution: options.allowCrossTargetSubstitution,
    });

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
