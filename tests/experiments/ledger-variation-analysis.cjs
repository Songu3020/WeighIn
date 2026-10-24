// Analysis and verification for the controlled ledger-dependent benchmark variation experiment (#77).
// Uses the existing public diff/threshold/report APIs without altering production semantics.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { xdr } = require('@stellar/stellar-sdk');
const { diffBenchmarks, METRIC_KEYS } = require('../../dist/diff');
const { enforceThresholds } = require('../../dist/threshold');
const { renderComment } = require('../../dist/comment');
const { analyzeRepeatability } = require('./repeatability-analysis.cjs');

const MEASURED_KEYS = [
  'cpu_instructions',
  'memory_bytes',
  'ledger_read_entries',
  'ledger_read_bytes',
  'ledger_write_entries',
  'ledger_write_bytes',
  'events_count',
  'event_data_bytes',
];

const UNAVAILABLE_KEYS = [
  'historical_data_read_bytes',
  'contract_data_hard_limit',
  'tx_size_bytes',
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// The archived summary.md is retained historical evidence rendered by the
// report renderer of the experiment revision. That renderer later moved its
// provenance block into a <details> section and expanded it, so the archived
// file is compared on the facts it reports - metric rows, violations,
// unavailable reasons and metric sources - instead of on byte equality. The
// archived file and its recorded SHA256 stay untouched.
function reportFacts(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|") || line.startsWith("- **"))
    .map((line) => line.trimEnd());
}

function decodeSymbolVec(retvalXdr) {
  const scVal = xdr.ScVal.fromXDR(retvalXdr, 'base64');
  assert.equal(scVal.switch().name, 'scvVec', 'Expected Vec<Symbol> return value');
  return scVal.vec().map((item) => {
    assert.equal(item.switch().name, 'scvSymbol', 'Expected Symbol element in return vector');
    return item.sym().toString('utf8');
  });
}

function decodeHeaderLedgerAndTimestamp(headerXdr) {
  const header = xdr.LedgerHeader.fromXDR(headerXdr, 'base64');
  return {
    protocol: header.ledgerVersion(),
    ledger: header.ledgerSeq(),
    timestamp: Number(header.scpValue().closeTime().toString()),
  };
}

function verifyLedgerVariation({
  contractSource,
  environment,
  progression,
  runs,
  rpcCalls,
  nativeReplays,
  analysis,
  controlDiff,
  variationDiff,
  policy,
  violations,
  summary,
  verification,
}) {
  assert.equal(verification.status, 'VERIFIED');
  assert.equal(verification.scenario, 'ledger_dependent_variation');
  assert.equal(verification.repeatability_status, 'REPEATABILITY_VARIATION_FOUND');
  assert.equal(verification.unchanged_wasm_artifact, true);
  assert.equal(verification.unchanged_runtime_contract_id, true);
  assert.equal(verification.fixed_invocation_interface, true);
  assert.equal(verification.controlled_ledger_progression, true);
  assert.equal(verification.random_behavior_used, false);
  assert.equal(verification.policy_violation_suppressed_for_unchanged_artifact, false);
  assert.equal(verification.unavailable_metrics_explicit_null, true);
  assert.equal(verification.bounded_repeatability_implies_state_time_independence, false);

  // 1. Contract source explicitly depends on ledger sequence and timestamp, keeping hello(Env, Symbol) -> Vec<Symbol> fixed
  assert.match(
    contractSource,
    /pub fn hello\(env:\s*Env,\s*to:\s*Symbol\)\s*->\s*Vec<Symbol>/,
    'Proof contract must keep the fixed hello(Env, Symbol) -> Vec<Symbol> invocation interface',
  );
  assert.ok(
    contractSource.includes('env.ledger().sequence()'),
    'Proof contract must explicitly depend on env.ledger().sequence()',
  );
  assert.ok(
    contractSource.includes('env.ledger().timestamp()'),
    'Proof contract must explicitly depend on env.ledger().timestamp()',
  );
  assert.ok(
    !contractSource.includes('prng'),
    'Proof contract must not use random/PRNG behavior',
  );

  // 2. Five controlled runs with fixed source, fixed WASM, and monotonic ledger sequence/time progression
  assert.equal(runs.length, 5, 'Experiment must include 5 controlled ledger progression runs');
  assert.equal(progression.length, 5, 'Ledger progression record must have 5 entries');

  const wasmHashes = new Set();
  const contractIds = new Set();
  const computeConfigHashes = new Set();
  const resourceLimitHashes = new Set();

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const step = progression[i];
    assert.equal(run.run, i + 1);
    assert.equal(step.run, i + 1);
    assert.equal(run.source_snapshot_sha256, environment.source_snapshot_sha256);
    assert.equal(run.reference_build.wasm_sha256, environment.proof_wasm_sha256);

    const contract = run.reference_measurements[0];
    assert.equal(contract.schema_version, 4);
    assert.equal(contract.fixture_id, 'id:ledger-variation-suite');
    assert.equal(contract.logical_id, 'id:reference-contract');
    contractIds.add(contract.contract_id);

    assert.equal(contract.benchmarks.length, 1);
    const benchmark = contract.benchmarks[0];
    assert.equal(benchmark.function_name, 'hello');
    assert.equal(benchmark.case_id, 'id:world');
    assert.equal(benchmark.wasm_sha256, environment.proof_wasm_sha256);
    wasmHashes.add(benchmark.wasm_sha256);

    const prov = benchmark.provenance;
    assert.ok(prov, 'Schema 4 provenance is required');
    assert.equal(prov.protocol, 28);
    assert.equal(prov.auth_mode, 'recording(true,true)');
    assert.deepEqual(prov.host_features, ['recording_mode', 'testutils']);
    assert.deepEqual(prov.seed, Array(32).fill(0), 'Seed must remain fixed 32 zero bytes');
    assert.equal(prov.ledger, step.ledger, 'Provenance ledger must match controlled progression');
    computeConfigHashes.add(prov.compute_config_sha256);
    resourceLimitHashes.add(prov.resource_limits_sha256);

    if (i > 0) {
      assert.ok(
        step.ledger > progression[i - 1].ledger,
        'Controlled ledger sequence must strictly advance between runs',
      );
      assert.ok(
        step.timestamp > progression[i - 1].timestamp,
        'Controlled ledger timestamp must strictly advance between runs',
      );
    }

    // Link to native replay and raw RPC simulation
    const replay = nativeReplays.find(
      (row) => row.output && sha256(JSON.stringify(row.input)) === prov.input_sha256,
    );
    assert.ok(replay, `Run ${run.run} must link to its exact native simulation input/output`);
    assert.equal(sha256(replay.input.header_xdr), prov.header_sha256);
    assert.equal(sha256(JSON.stringify(replay.input.entries)), prov.snapshot_sha256);

    const headerInfo = decodeHeaderLedgerAndTimestamp(replay.input.header_xdr);
    assert.equal(headerInfo.protocol, 28);
    assert.equal(headerInfo.ledger, step.ledger);
    assert.equal(headerInfo.timestamp, step.timestamp);

    const rpcSim = rpcCalls.find(
      (call) =>
        call.request.method === 'simulateTransaction' &&
        call.raw.result?.latestLedger === prov.ledger &&
        call.raw.result?.transactionData === replay.output.transaction_data_xdr &&
        call.raw.result?.results?.[0]?.xdr === replay.output.retval_xdr,
    );
    assert.ok(rpcSim, `Run ${run.run} must have a parity-matched raw RPC simulateTransaction record`);

    const decodedReturn = decodeSymbolVec(replay.output.retval_xdr);
    assert.equal(replay.output.retval_xdr, step.retval_xdr);
    assert.deepEqual(decodedReturn, step.return_symbols);

    // Check all 8 measured metrics and 3 unavailable metrics
    const txResources = xdr.SorobanTransactionData.fromXDR(
      replay.output.transaction_data_xdr,
      'base64',
    ).resources();
    const expectedMetrics = {
      cpu_instructions: replay.output.cpu_instructions_consumed,
      memory_bytes: replay.output.memory_bytes_consumed,
      ledger_read_entries:
         txResources.footprint().readOnly().length + txResources.footprint().readWrite().length,
      ledger_read_bytes: txResources.diskReadBytes(),
      ledger_write_entries: txResources.footprint().readWrite().length,
      ledger_write_bytes: txResources.writeBytes(),
      events_count: replay.output.contract_events_xdr.length,
      event_data_bytes: [
        ...replay.output.contract_events_xdr,
        replay.output.retval_xdr,
      ].reduce((sum, val) => sum + Buffer.from(val, 'base64').length, 0),
    };
    for (const [key, expectedValue] of Object.entries(expectedMetrics)) {
      assert.equal(benchmark.metrics[key].availability, 'measured');
      assert.equal(benchmark.metrics[key].consumed, expectedValue, `Run ${run.run} metric ${key}`);
    }
    for (const key of UNAVAILABLE_KEYS) {
      assert.equal(benchmark.metrics[key].availability, 'unavailable');
      assert.equal(
        benchmark.metrics[key].consumed,
        null,
        `Unavailable metric ${key} must remain null rather than measured zero`,
      );
      assert.equal(benchmark.metrics[key].limit, null);
      assert.ok(benchmark.metrics[key].reason, `Unavailable metric ${key} must retain its reason`);
    }
  }

  assert.equal(wasmHashes.size, 1, 'Proof WASM hash must remain fixed across all runs');
  assert.equal(contractIds.size, 1, 'Runtime contract ID must remain fixed across all runs');
  assert.equal(computeConfigHashes.size, 1, 'Compute calibration hash must remain constant');
  assert.equal(resourceLimitHashes.size, 1, 'Resource limits hash must remain constant');

  // 3. Repeatability analysis must detect actual metric variation while WASM is stable
  const computedAnalysis = analyzeRepeatability(runs);
  assert.deepEqual(computedAnalysis, analysis, 'Saved analysis.json must match analyzeRepeatability(runs)');
  assert.equal(analysis.status, 'REPEATABILITY_VARIATION_FOUND');
  assert.equal(analysis.reference.wasm_stable, true);
  assert.equal(analysis.reference.metrics_stable, false);

  const seriesMetrics = analysis.reference.series[0].metrics;
  assert.ok(seriesMetrics.cpu_instructions.range > 0, 'CPU instructions must show actual ledger-driven variation');
  assert.ok(seriesMetrics.memory_bytes.range > 0, 'Memory bytes must show actual ledger-driven variation');
  assert.ok(seriesMetrics.ledger_write_bytes.range > 0, 'Write bytes must show actual ledger-driven variation');
  assert.ok(seriesMetrics.event_data_bytes.range > 0, 'Event+return bytes must show actual ledger-driven variation');

  // 4. Control diff (Run 1 vs Run 2, both before the ledger threshold) must show 0 deltas and 0 violations
  const recomputedControlDiff = diffBenchmarks(
    runs[0].reference_measurements,
    runs[1].reference_measurements,
  );
  assert.deepEqual(recomputedControlDiff, controlDiff);
  assert.equal(controlDiff.hasRegression, false);
  for (const m of controlDiff.contracts[0].functions[0].metrics) {
    if (m.availability === 'comparable') {
      assert.equal(m.delta, 0, `Pre-threshold control metric ${m.key} must have zero delta`);
      assert.equal(m.regression, false);
    }
  }
  assert.deepEqual(enforceThresholds(controlDiff, policy), []);

  // 5. Variation diff (Run 1 vs Run 5, across ledger threshold) must preserve normal diff/policy behavior
  //    and NEVER suppress configured violations merely because the WASM/artifact is unchanged.
  const recomputedVariationDiff = diffBenchmarks(
    runs[0].reference_measurements,
    runs[4].reference_measurements,
  );
  assert.deepEqual(recomputedVariationDiff, variationDiff);
  assert.equal(variationDiff.hasRegression, true, 'Ledger-induced resource increase must be flagged as a regression');
  assert.equal(
    variationDiff.contracts[0].base_contract_id,
    variationDiff.contracts[0].head_contract_id,
    'BASE and HEAD share the unchanged deployed contract ID',
  );

  const recomputedViolations = enforceThresholds(variationDiff, policy);
  assert.deepEqual(recomputedViolations, violations);
  assert.ok(
    violations.length > 0,
    'Configured policy violations must not be suppressed when the artifact is unchanged',
  );
  assert.ok(
    violations.some(
      (v) => v.metric === 'cpu_instructions' && v.rule === 'strict_zero_tolerance' && v.delta > 0,
    ),
    'Strict CPU policy violation must be enforced on unchanged artifact when ledger progression increases CPU',
  );

  const rendered = renderComment(variationDiff, violations, 'ledger-900', 'ledger-1000');
  assert.deepEqual(
    reportFacts(rendered),
    reportFacts(summary),
    'Archived summary must report the same metrics, violations and sources as the current renderer',
  );

  // The archived report must still state the archived provenance facts.
  const archivedFunction = variationDiff.contracts[0].functions[0];
  const archivedBase = archivedFunction.base_provenance;
  const archivedHead = archivedFunction.head_provenance;
  assert.ok(
    summary.includes(`Snapshot ledgers: BASE ${archivedBase.ledger} → HEAD ${archivedHead.ledger}`),
    'Archived summary must record the archived ledger endpoints',
  );
  for (const digest of [
    archivedBase.compute_config_sha256,
    archivedHead.compute_config_sha256,
    archivedBase.config_sha256,
    archivedHead.config_sha256,
    archivedHead.resource_limits_sha256,
  ]) {
    assert.ok(summary.includes(digest), `Archived summary must record ${digest}`);
  }

  assert.match(summary, /threshold violation/);
  assert.match(summary, /cpu_instructions increased by .*strict zero tolerance/);

  return true;
}

module.exports = {
  MEASURED_KEYS,
  UNAVAILABLE_KEYS,
  decodeSymbolVec,
  decodeHeaderLedgerAndTimestamp,
  verifyLedgerVariation,
};
