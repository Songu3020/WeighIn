const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const { TransactionBuilder } = require("@stellar/stellar-sdk");

const { measureInvocation } = require("../dist/simulation");
const { metricsFromSimulation } = require("../dist/measurement");
const {
  assertHeldFixed,
  computeSourceAccountEffects,
  measureSourceAccountEffects,
} = require("../dist/source-account");
const { SUPPORTED_NETWORK_PASSPHRASE } = require("../dist/network");
const {
  verifySourceAccountEffects,
} = require("./experiments/source-account-analysis.cjs");

const archiveDir = path.resolve(
  __dirname,
  "../docs/experiments/source-account-effects",
);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const readJson = (file) =>
  JSON.parse(fs.readFileSync(path.join(archiveDir, file), "utf8"));

function loadBundle() {
  return {
    environment: readJson("environment.json"),
    accounts: readJson("accounts.json"),
    report: readJson("report.json"),
    control: readJson("control.json"),
    invalid: readJson("invalid.json"),
    native: readJson("native.json"),
    rpc: readJson("rpc.json"),
    verification: readJson("verification.json"),
  };
}

test("retained source-account archive matches all SHA256 checksums and satisfies every acceptance criterion", () => {
  const checksums = readJson("sha256.json");
  for (const [file, expectedHash] of Object.entries(checksums)) {
    const actualHash = sha256(fs.readFileSync(path.join(archiveDir, file)));
    assert.equal(actualHash, expectedHash, `Checksum mismatch for ${file}`);
  }

  const bundle = loadBundle();
  assert.equal(bundle.verification.status, "VERIFIED");
  assert.equal(bundle.verification.scenario, "source_account_effects");
  assert.ok(verifySourceAccountEffects(bundle));
});

test("every archived source-account run replays through the public measurement path with exact parity", async (t) => {
  const bundle = loadBundle();
  const runs = [bundle.report.baseline, ...bundle.report.variants];
  const helperPath = path.join(archiveDir, "contract.wasm");
  const nativeByInput = new Map(
    bundle.native.map((entry) => [entry.input_sha256, entry.output]),
  );
  const used = new Set();
  const simulations = bundle.rpc.filter(
    (call) => call.request.method === "simulateTransaction",
  );
  const simulationFor = (run) => {
    const match = simulations.find(
      (call) =>
        TransactionBuilder.fromXDR(
          call.request.params.transaction,
          SUPPORTED_NETWORK_PASSPHRASE,
        ).source === run.source_account,
    );
    assert.ok(
      match,
      `The archive must retain the simulated transaction of ${run.label}`,
    );
    return match;
  };

  const rpcFor = (method, params) => {
    const key = JSON.stringify(params);
    const match = bundle.rpc.find(
      (call) =>
        call.request.method === method &&
        JSON.stringify(call.request.params) === key &&
        !used.has(call),
    );
    assert.ok(
      match,
      `Missing recorded RPC response for ${method} ${key.slice(0, 80)}`,
    );
    used.add(match);
    return match;
  };

  t.mock.method(globalThis, "fetch", async (url, fetchOptions) => {
    const request = JSON.parse(fetchOptions.body);
    const match = rpcFor(request.method, request.params);
    return new Response(
      JSON.stringify({ ...match.raw, jsonrpc: "2.0", id: request.id }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  t.mock.method(cp, "execFile", (file, _args, _options, callback) => {
    assert.equal(file, helperPath);
    const stdin = new EventEmitter();
    stdin.on = () => stdin;
    stdin.end = (data) => {
      const inputHash = sha256(data);
      const output = nativeByInput.get(inputHash);
      assert.ok(
        output,
        "The replayed helper input must match a recorded native execution",
      );
      setImmediate(() => callback(null, JSON.stringify(output), ""));
    };
    return { stdin, on: () => {}, kill: () => {} };
  });

  for (const run of runs) {
    const transaction = TransactionBuilder.fromXDR(
      simulationFor(run).request.params.transaction,
      SUPPORTED_NETWORK_PASSPHRASE,
    );
    const { output, provenance, limits } = await measureInvocation(
      "http://localhost:8000/rpc",
      transaction,
      helperPath,
      {},
    );
    assert.equal(
      provenance.input_sha256,
      run.provenance.input_sha256,
      `Replayed input hash must match the archived run ${run.label}`,
    );
    assert.equal(
      provenance.source_account,
      run.source_account,
      `Replayed provenance must record the source account of ${run.label}`,
    );
    assert.deepStrictEqual(
      metricsFromSimulation(output, limits),
      run.metrics,
      `Replayed metrics must match the archived run ${run.label}`,
    );
  }
});

/** Locate the recorded simulation request of one measured run. */

test("the archived effect and comparability verdict are reproduced from the archived measurements", () => {
  const bundle = loadBundle();
  const runs = [bundle.report.baseline, ...bundle.report.variants];

  for (let index = 1; index < runs.length; index++) {
    assertHeldFixed(bundle.report.baseline, runs[index]);
    const effect = computeSourceAccountEffects(
      bundle.report.baseline,
      runs[index],
    );
    const archived = bundle.report.effects.find(
      (candidate) => candidate.label === effect.label,
    );
    assert.ok(
      archived,
      `The archive must retain the effect of ${effect.label}`,
    );
    assert.deepStrictEqual(effect, archived);
  }

  const changed = new Set(
    bundle.report.effects.flatMap((effect) => effect.changed_metrics),
  );
  assert.equal(bundle.report.comparison.metrics_changed, changed.size > 0);
  assert.equal(
    bundle.report.comparison.cross_run_comparison_valid,
    changed.size === 0,
  );
});

test("an invalid source account is rejected before any measurement starts", async () => {
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("The network must not be contacted for an invalid account");
  };
  try {
    await assert.rejects(
      measureSourceAccountEffects({
        fixturesPath: path.resolve(
          __dirname,
          "fixtures/source-account/source-account-fixtures.json",
        ),
        rpcUrl: "http://localhost:8000/rpc",
        sourceAccounts: [
          { label: "malformed", public_key: "not-an-account-key" },
          { label: "unused", public_key: "G".padEnd(56, "A") },
        ],
      }),
      /public_key must be an Ed25519 account public key/,
    );
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
