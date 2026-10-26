// Controlled source-account effect experiment harness (#201).
// Measures one contract case under several valid source accounts through the
// public WeighIn measurement path (RPC snapshot capture, native helper replay
// and the audited metric mapping) while code, arguments, protocol, calibration
// and resource limits stay fixed. Retains the raw RPC and native evidence, the
// repeatability control and the fail-closed evidence for invalid accounts.
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { createHash } = require("node:crypto");
const { Keypair } = require("@stellar/stellar-sdk");

const { measureSourceAccountEffects } = require("../../dist/source-account");
const { ensureAccountReady } = require("../../dist/account");
const { verifySourceAccountEffects } = require("./source-account-analysis.cjs");

const root = path.resolve(__dirname, "../..");
const fixtureRoot = path.resolve(root, "tests/fixtures/source-account");
const defaultDestination = path.resolve(
  root,
  "docs/experiments/source-account-effects",
);
const RPC_URL =
  process.env.WEIGHIN_EXPERIMENT_RPC_URL || "http://localhost:8000/rpc";
const QUICKSTART_IMAGE =
  "stellar/quickstart@sha256:4c8bad1ef7341205b898f83d9489321da80c7bd74183100fc8e2a39a5938c7d5";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function writeJsonLf(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    targetPath,
    JSON.stringify(value, null, 2).replace(/\r\n/g, "\n") + "\n",
    "utf8",
  );
}

function writeTextLf(targetPath, text) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, text.replace(/\r\n/g, "\n"), "utf8");
}

function buildContract() {
  const manifest = path.join(fixtureRoot, "contract/Cargo.toml");
  const wasmPath = path.join(
    fixtureRoot,
    "contract/target/wasm32v1-none/release/contract_source_account.wasm",
  );
  // The optimizer cannot read its own input directory, so the optimized
  // artifact is produced in a separate output directory and copied into the
  // declared fixture path.
  const outDir = path.join(fixtureRoot, "contract/target/optimized");
  const cli = process.env.WEIGHIN_STELLAR_CLI || "stellar";
  const result = cp.spawnSync(
    cli,
    [
      "contract",
      "build",
      "--manifest-path",
      manifest,
      "--locked",
      "--optimize=true",
      "--out-dir",
      outDir,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Contract build failed: ${cli} contract build exited with ${result.status}`,
    );
  }
  const optimized = path.join(outDir, "contract_source_account.wasm");
  if (!fs.existsSync(optimized)) {
    throw new Error(`Contract build produced no artifact at ${optimized}`);
  }
  fs.mkdirSync(path.dirname(wasmPath), { recursive: true });
  fs.copyFileSync(optimized, wasmPath);
  return wasmPath;
}

/** Capture the JSON-RPC traffic of the measurement path and the native helper
 *  input and output of every replay. */
function installCapture() {
  const rpcCalls = [];
  const nativeCalls = [];
  const originalFetch = globalThis.fetch;
  const originalExecFile = cp.execFile;

  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    const body = typeof options?.body === "string" ? options.body : "";
    if (body.includes('"jsonrpc"')) {
      let request = null;
      try {
        request = JSON.parse(body);
      } catch {
        request = null;
      }
      if (request && typeof request.method === "string") {
        const text = await response.clone().text();
        let raw = null;
        try {
          raw = JSON.parse(text);
        } catch {
          raw = text;
        }
        rpcCalls.push({ request, raw });
      }
    }
    return response;
  };

  cp.execFile = (file, args, options, callback) => {
    const child = originalExecFile(
      file,
      args,
      options,
      (error, stdout, stderr) => {
        if (typeof stdout === "string" && stdout.trim().length > 0) {
          let output = null;
          try {
            output = JSON.parse(stdout);
          } catch {
            output = null;
          }
          nativeCalls.push({
            file,
            args,
            input_sha256: nativeCalls.pendingInputSha256 ?? null,
            output,
          });
          nativeCalls.pendingInputSha256 = null;
        }
        callback(error, stdout, stderr);
      },
    );
    if (child.stdin) {
      const originalEnd = child.stdin.end.bind(child.stdin);
      child.stdin.end = (data) => {
        if (typeof data === "string" && data.length > 0) {
          nativeCalls.pendingInputSha256 = sha256(data);
        }
        return originalEnd(data);
      };
    }
    return child;
  };

  return {
    rpcCalls,
    nativeCalls,
    restore() {
      globalThis.fetch = originalFetch;
      cp.execFile = originalExecFile;
    },
  };
}

async function prepareSourceAccounts(count) {
  const accounts = [];
  for (let index = 0; index < count; index++) {
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();
    await ensureAccountReady(RPC_URL, publicKey);
    accounts.push({
      label: `source-${index + 1}`,
      public_key: publicKey,
      sequence: null,
    });
  }
  return accounts;
}

async function readAccountSequences(accounts) {
  const { rpc } = require("@stellar/stellar-sdk");
  const server = new rpc.Server(RPC_URL, { allowHttp: true });
  for (const account of accounts) {
    const loaded = await server.getAccount(account.public_key);
    account.sequence = String(loaded.sequenceNumber);
  }
  return accounts;
}

async function runSourceAccountEffectsExperiment(
  destination = defaultDestination,
) {
  fs.mkdirSync(destination, { recursive: true });
  const wasmPath = buildContract();
  const fixturesPath = path.join(fixtureRoot, "source-account-fixtures.json");

  const inputRelativeFiles = [
    "contract/Cargo.toml",
    "contract/Cargo.lock",
    "contract/src/lib.rs",
    "source-account-fixtures.json",
  ];
  const sourceFilesSha256 = {};
  for (const relative of inputRelativeFiles) {
    const content = fs
      .readFileSync(path.join(fixtureRoot, relative), "utf8")
      .replace(/\r\n/g, "\n");
    writeTextLf(path.join(fixtureRoot, relative), content);
    writeTextLf(path.join(destination, "source", relative), content);
    sourceFilesSha256[relative] = sha256(Buffer.from(content, "utf8"));
  }

  const accounts = await readAccountSequences(await prepareSourceAccounts(3));
  const sourceAccounts = accounts.map(({ label, public_key }) => ({
    label,
    public_key,
  }));
  const capture = installCapture();
  let report;
  let control;
  let invalid;
  try {
    report = await measureSourceAccountEffects({
      fixturesPath,
      fixtureId: "tests/fixtures/source-account/source-account-fixtures.json",
      rpcUrl: RPC_URL,
      keyFile: path.join(fixtureRoot, ".weighin-temp-key"),
      sourceAccounts,
    });
    control = await measureSourceAccountEffects({
      fixturesPath,
      fixtureId: "tests/fixtures/source-account/source-account-fixtures.json",
      rpcUrl: RPC_URL,
      keyFile: path.join(fixtureRoot, ".weighin-temp-key"),
      sourceAccounts,
    });

    const invalidCallsBefore = capture.rpcCalls.length;
    const malformed = await measureSourceAccountEffects({
      fixturesPath,
      fixtureId: "tests/fixtures/source-account/source-account-fixtures.json",
      rpcUrl: RPC_URL,
      keyFile: path.join(fixtureRoot, ".weighin-temp-key"),
      sourceAccounts: [
        { label: "malformed", public_key: "not-an-account-key" },
        { label: "unused", public_key: accounts[1].public_key },
      ],
    }).then(
      () => null,
      (error) => error,
    );
    const malformedRpcCalls = capture.rpcCalls.length - invalidCallsBefore;
    const missing = await measureSourceAccountEffects({
      fixturesPath,
      fixtureId: "tests/fixtures/source-account/source-account-fixtures.json",
      rpcUrl: RPC_URL,
      keyFile: path.join(fixtureRoot, ".weighin-temp-key"),
      sourceAccounts: [
        {
          label: "missing",
          public_key: Keypair.random().publicKey(),
        },
        { label: "unused", public_key: accounts[1].public_key },
      ],
    }).then(
      () => null,
      (error) => error,
    );
    invalid = {
      malformed_key_rejected: Boolean(malformed),
      malformed_key_message: malformed ? malformed.message : null,
      malformed_key_rpc_calls: malformedRpcCalls,
      missing_account_rejected: Boolean(missing),
      missing_account_message: missing ? missing.message : null,
      malformed_result: malformed,
      missing_result: missing,
    };
  } finally {
    capture.restore();
  }

  const environment = {
    scenario: "source_account_effects",
    issue: 201,
    node_version: process.version,
    stellar_sdk_version: JSON.parse(
      fs.readFileSync(
        path.join(root, "node_modules/@stellar/stellar-sdk/package.json"),
        "utf8",
      ),
    ).version,
    native_helper_source_version: "28.0.1",
    protocol: report.baseline.protocol,
    network_passphrase: "Public Global Stellar Network ; September 2015",
    rpc_url: RPC_URL,
    quickstart_image: QUICKSTART_IMAGE,
    source_files_sha256: sourceFilesSha256,
    wasm_sha256: sha256(fs.readFileSync(wasmPath)),
  };

  writeJsonLf(path.join(destination, "environment.json"), environment);
  writeJsonLf(path.join(destination, "accounts.json"), {
    accounts,
    note: "Disposable local-network accounts; public keys only, no key material retained.",
  });
  writeJsonLf(path.join(destination, "rpc.json"), capture.rpcCalls);
  writeJsonLf(path.join(destination, "native.json"), capture.nativeCalls);
  writeJsonLf(path.join(destination, "report.json"), report);
  writeJsonLf(path.join(destination, "control.json"), control);
  writeJsonLf(
    path.join(destination, "invalid.json"),
    Object.fromEntries(
      Object.entries(invalid).filter(([key]) => !key.endsWith("_result")),
    ),
  );
  fs.copyFileSync(wasmPath, path.join(destination, "contract.wasm"));

  const bundle = {
    environment,
    accounts: { accounts },
    report,
    control,
    invalid: Object.fromEntries(
      Object.entries(invalid).filter(([key]) => !key.endsWith("_result")),
    ),
    native: capture.nativeCalls,
    rpc: capture.rpcCalls,
  };
  const verification = verifySourceAccountEffects(bundle);
  writeJsonLf(path.join(destination, "verification.json"), verification);

  const summary = [
    "# Source-account effects",
    "",
    `Scenario: source_account_effects (issue #201), protocol ${environment.protocol}.`,
    "",
    `- Contract case: \`${report.function_name}\` (${report.case_id}) of \`${report.logical_id}\`.`,
    `- Contract ID: \`${report.contract_id}\`.`,
    `- Source accounts compared: ${report.variants.length + 1}.`,
    `- Metrics changed by the source account: ${
      report.comparison.changed_metrics.length > 0
        ? report.comparison.changed_metrics.join(", ")
        : "none"
    }.`,
    `- Cross-run comparison valid across source accounts: ${report.comparison.cross_run_comparison_valid}.`,
    `- Repeatability control deltas: ${
      control.effects.flatMap((effect) => effect.changed_metrics).length
    }.`,
    `- Invalid source accounts rejected before measurement: ${
      invalid.malformed_key_rejected && invalid.missing_account_rejected
    }.`,
    "",
    "## Reason",
    "",
    report.comparison.reason,
    "",
  ].join("\n");
  writeTextLf(path.join(destination, "summary.md"), summary);

  const checksums = {};
  for (const file of fs.readdirSync(destination).sort()) {
    if (file === "sha256.json") continue;
    const full = path.join(destination, file);
    if (!fs.statSync(full).isFile()) continue;
    checksums[file] = sha256(fs.readFileSync(full));
  }
  writeJsonLf(path.join(destination, "sha256.json"), checksums);

  return { destination, verification, report, control, invalid };
}

if (require.main === module) {
  runSourceAccountEffectsExperiment()
    .then(({ verification }) => {
      console.log(JSON.stringify(verification, null, 2));
      if (verification.status !== "VERIFIED") process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { runSourceAccountEffectsExperiment };
