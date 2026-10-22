const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { Transaction, xdr } = require('@stellar/stellar-sdk');

const { measureInvocation } = require('../dist/simulation');
const { metricsFromSimulation } = require('../dist/measurement');
const { diffBenchmarks } = require('../dist/diff');
const { enforceThresholds } = require('../dist/threshold');
const { verifyLedgerVariation } = require('./experiments/ledger-variation-analysis.cjs');

const archiveDir = path.resolve(__dirname, '../docs/experiments/ledger-variation');
const fixtureDir = path.resolve(__dirname, 'fixtures/ledger-variation');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));

function loadBundle() {
  return {
    contractSource: fs.readFileSync(path.join(archiveDir, 'source/contract/src/lib.rs'), 'utf8'),
    environment: readJson('environment.json'),
    progression: readJson('ledger-progression.json'),
    runs: readJson('runs.json'),
    rpcCalls: readJson('rpc.json'),
    nativeReplays: readJson('native.json'),
    analysis: readJson('analysis.json'),
    controlDiff: readJson('control-diff.json'),
    variationDiff: readJson('variation-diff.json'),
    policy: readJson('policy.json'),
    violations: readJson('violations.json'),
    summary: fs.readFileSync(path.join(archiveDir, 'summary.md'), 'utf8'),
    verification: readJson('verification.json'),
  };
}

test('retained ledger-variation archive matches all SHA256 checksums and satisfies all acceptance criteria', () => {
  const checksums = readJson('sha256.json');
  for (const [file, expectedHash] of Object.entries(checksums)) {
    const actualHash = sha256(fs.readFileSync(path.join(archiveDir, file)));
    assert.equal(actualHash, expectedHash, `Checksum mismatch for ${file}`);
  }

  const bundle = loadBundle();
  for (const [rel, expectedHash] of Object.entries(bundle.environment.source_files_sha256)) {
    assert.equal(
      sha256(fs.readFileSync(path.join(fixtureDir, rel))),
      expectedHash,
      `Fixture file ${rel} must match archived source copy`,
    );
    assert.equal(
      sha256(fs.readFileSync(path.join(archiveDir, 'source', rel))),
      expectedHash,
      `Archived source file ${rel} must match recorded hash`,
    );
  }

  assert.ok(verifyLedgerVariation(bundle));
});

test('all five controlled ledger-progression samples replay through public measureInvocation and metricsFromSimulation with exact parity', async (t) => {
  const { runs, rpcCalls, nativeReplays } = loadBundle();
  const helperPath = path.join(archiveDir, 'contract.wasm');

  for (const run of runs) {
    const runRpc = rpcCalls.filter((c) => c.run === run.run);
    const runNative = nativeReplays.find((r) => r.run === run.run);
    assert.ok(runNative, `Missing native replay for run ${run.run}`);
    const simCall = runRpc.find((c) => c.request.method === 'simulateTransaction');
    assert.ok(simCall, `Missing simulateTransaction RPC record for run ${run.run}`);

    t.mock.method(globalThis, 'fetch', async (_url, fetchOptions) => {
      const req = JSON.parse(fetchOptions.body);
      const matched = runRpc.find((c) => c.request.method === req.method);
      assert.ok(matched, `Unexpected RPC method ${req.method} during run ${run.run} replay`);
      const response = structuredClone(matched.raw);
      if (req.method === 'getLedgers') {
        // These archived replay records predate header-hash verification and carry a
        // run-number placeholder. Keep the checked-in evidence untouched; for this
        // synthetic RPC replay, derive the protocol-required hash from the captured
        // header bytes before passing the response through the current validator.
        response.result.ledgers = response.result.ledgers.map((ledger) => {
          const history = xdr.LedgerHeaderHistoryEntry.fromXDR(ledger.headerXdr, 'base64');
          const computedHash = createHash('sha256').update(history.header().toXDR()).digest();
          assert.ok(
            Buffer.from(history.hash()).equals(Buffer.alloc(32, Number(run.run))) ||
              Buffer.from(history.hash()).equals(computedHash),
            'only the historical run-number placeholder may be repaired in the test response',
          );
          history.hash(computedHash);
          return { ...ledger, headerXdr: history.toXDR('base64') };
        });
      }
      return new Response(JSON.stringify({ ...response, jsonrpc: '2.0', id: req.id }));
    });

    t.mock.method(cp, 'execFile', (file, _args, _options, callback) => {
      assert.equal(file, helperPath);
      const stdin = new EventEmitter();
      stdin.on = () => stdin;
      stdin.end = (data) => {
        assert.equal(
          sha256(data),
          run.reference_measurements[0].benchmarks[0].provenance.input_sha256,
        );
        setImmediate(() => callback(null, JSON.stringify(runNative.output), ''));
      };
      return { stdin };
    });

    const tx = new Transaction(
      simCall.request.params.transaction,
      runNative.input.network_passphrase,
    );
    const replayed = await measureInvocation('http://localhost:18000/rpc', tx, helperPath);
    const replayedMetrics = metricsFromSimulation(replayed.output, replayed.limits);
    const savedBenchmark = run.reference_measurements[0].benchmarks[0];

    // The retained archive predates the optional `source_account` provenance field, so the
    // replay is compared on every archived provenance field and the recorded source account
    // is asserted separately against the invoking account of the archived transaction.
    const { source_account: replayedSourceAccount, ...replayedProvenance } = replayed.provenance;
    const { source_account: savedSourceAccount, ...savedProvenance } = savedBenchmark.provenance;
    assert.deepEqual(replayedProvenance, savedProvenance);
    assert.equal(savedSourceAccount, undefined);
    assert.equal(replayedSourceAccount, tx.source);
    assert.deepEqual(replayedMetrics, savedBenchmark.metrics);
  }
});

test('diffBenchmarks and enforceThresholds preserve normal regression and policy enforcement when the WASM artifact is unchanged', () => {
  const { runs, policy } = loadBundle();

  // Pre-threshold control (ledger 900 -> 925): zero deltas and zero violations
  const preThresholdDiff = diffBenchmarks(
    runs[0].reference_measurements,
    runs[1].reference_measurements,
  );
  assert.equal(preThresholdDiff.hasRegression, false);
  assert.deepEqual(enforceThresholds(preThresholdDiff, policy), []);

  // Each post-threshold step (ledgers 950, 975, 1000) compared against ledger 900
  // must flag regressions and trigger policy violations despite identical WASM and contract_id
  for (const idx of [2, 3, 4]) {
    const diff = diffBenchmarks(
      runs[0].reference_measurements,
      runs[idx].reference_measurements,
    );
    assert.equal(diff.hasRegression, true, `Run ${idx + 1} must report a regression vs Run 1`);
    assert.equal(
      diff.contracts[0].base_contract_id,
      diff.contracts[0].head_contract_id,
      'Runtime contract ID remains unchanged',
    );
    const violations = enforceThresholds(diff, policy);
    assert.equal(violations.length, 6, `Run ${idx + 1} must produce 6 policy violations`);
    assert.ok(
      violations.some((v) => v.metric === 'cpu_instructions' && v.rule === 'strict_zero_tolerance'),
    );
  }
});

test('verifier rejects contracts missing explicit ledger sequence/time dependency, using PRNG, or suppressing violations on unchanged artifacts', () => {
  // 1. Missing env.ledger().sequence()
  {
    const b = loadBundle();
    b.contractSource = b.contractSource.replace('env.ledger().sequence()', '950u32');
    assert.throws(() => verifyLedgerVariation(b), /env\.ledger\(\)\.sequence\(\)/);
  }

  // 2. Using PRNG randomness
  {
    const b = loadBundle();
    b.contractSource += '\n// env.prng()';
    assert.throws(() => verifyLedgerVariation(b), /must not use random\/PRNG behavior/);
  }

  // 3. Non-monotonic ledger sequence progression
  {
    const b = loadBundle();
    b.progression[2].ledger = b.progression[1].ledger;
    b.runs[2].reference_measurements[0].benchmarks[0].provenance.ledger = b.progression[1].ledger;
    assert.throws(() => verifyLedgerVariation(b), /strictly advance|Provenance ledger/);
  }

  // 4. Suppressing configured policy violations when the artifact is unchanged
  {
    const b = loadBundle();
    b.violations = [];
    assert.throws(() => verifyLedgerVariation(b));
  }

  // 5. Coercing unavailable metric to measured zero
  {
    const b = loadBundle();
    b.runs[0].reference_measurements[0].benchmarks[0].metrics.tx_size_bytes.consumed = 0;
    assert.throws(
      () => verifyLedgerVariation(b),
      /Unavailable metric tx_size_bytes must remain null/,
    );
  }
});
