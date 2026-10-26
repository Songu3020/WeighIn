const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const archiveDir = path.resolve(__dirname, '../docs/experiments/runner-stability');
const hash = (data) => createHash('sha256').update(data).digest('hex');

function verifyRunnerStability(matrix, samples, analysis, verification) {
  assert.equal(verification.status, 'VERIFIED');
  assert.equal(verification.scenario, 'runner_stability');
  assert.equal(verification.action_exit, 0);
  assert.equal(verification.action_outcome, 'success');
  assert.equal(verification.result, 'pass');
  assert.equal(verification.cross_runner_stability, 'pass');
  assert.equal(verification.cross_runner_variance, 0);
  assert.equal(verification.reject_cross_environment_averaging, true);
  assert.equal(verification.unavailable_metrics_explicit_null, true);

  // Matrix checks
  assert.equal(matrix.protocol, 28);
  assert.equal(matrix.auth_mode, 'recording(true,true)');
  assert.ok(matrix.runners.length >= 2, 'Must include at least two supported Linux x64 runner images');
  const runnerIds = matrix.runners.map((r) => r.id);
  assert.ok(runnerIds.includes('ubuntu-24.04'), 'ubuntu-24.04 must be supported');
  assert.ok(runnerIds.includes('ubuntu-22.04'), 'ubuntu-22.04 must be supported');

  for (const runner of matrix.runners) {
    assert.equal(runner.arch, 'x86_64');
    assert.ok(runner.glibc, 'glibc version must be documented');
    assert.ok(runner.compatibility_rationale, 'Compatibility rationale must be documented');
  }

  // Samples checks
  assert.ok(samples.runners['ubuntu-24.04'], 'Samples for ubuntu-24.04 must be present');
  assert.ok(samples.runners['ubuntu-22.04'], 'Samples for ubuntu-22.04 must be present');
  assert.equal(samples.runners['ubuntu-24.04'].length, verification.sample_count_per_runner);
  assert.equal(samples.runners['ubuntu-22.04'].length, verification.sample_count_per_runner);

  for (const runnerId of ['ubuntu-24.04', 'ubuntu-22.04']) {
    for (const run of samples.runners[runnerId]) {
      assert.equal(run.clean_deployment, true);
      assert.equal(run.cpu_instructions_consumed, 266842);
      assert.equal(run.memory_bytes_consumed, 2048);
      assert.equal(run.disk_read_bytes, 2400);
      assert.equal(run.write_bytes, 0);
      assert.equal(run.read_only_keys, 2);
      assert.equal(run.read_write_keys, 0);
      assert.equal(run.historical_data_read_bytes, null);
      assert.equal(run.contract_data_hard_limit, null);
      assert.equal(run.tx_size_bytes, null);
    }
  }

  // Analysis checks
  assert.equal(analysis.reject_cross_environment_averaging, true, 'Cross-environment averaging must be rejected');
  const deterministicKeys = [
    'cpu_instructions_consumed',
    'memory_bytes_consumed',
    'disk_read_bytes',
    'write_bytes',
    'read_only_keys',
    'read_write_keys',
  ];
  for (const key of deterministicKeys) {
    const metric = analysis.metrics[key];
    assert.ok(metric, `Metric ${key} must exist in analysis`);
    assert.equal(metric.cross_runner_delta, 0, `Metric ${key} must have zero cross-runner delta`);
    assert.equal(metric.cross_runner_drift_pct, 0.0);
    assert.equal(metric.ubuntu_24_04.range, 0);
    assert.equal(metric.ubuntu_22_04.range, 0);
  }

  const unavailableKeys = [
    'historical_data_read_bytes',
    'contract_data_hard_limit',
    'tx_size_bytes',
  ];
  for (const key of unavailableKeys) {
    const metric = analysis.metrics[key];
    assert.ok(metric, `Metric ${key} must exist in analysis`);
    assert.equal(metric.status, 'unavailable');
    assert.equal(metric.consumed, null, `Unavailable metric ${key} must have null consumption`);
    assert.ok(metric.reason, `Unavailable metric ${key} must provide explicit reason`);
  }

  return true;
}

test('retained runner stability evidence matches checksums and satisfies all criteria', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const sha256 = read('sha256.json');
  for (const [file, expectedHash] of Object.entries(sha256)) {
    assert.equal(hash(fs.readFileSync(path.join(archiveDir, file))), expectedHash, `Checksum mismatch for ${file}`);
  }

  const matrix = read('matrix.json');
  const samples = read('samples.json');
  const analysis = read('analysis.json');
  const verification = read('verification.json');

  assert.ok(verifyRunnerStability(matrix, samples, analysis, verification));
});

test('verifier rejects averaging across incompatible environments', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const matrix = read('matrix.json');
  const samples = read('samples.json');
  const analysis = read('analysis.json');
  const verification = read('verification.json');

  // Attempt cross-environment averaging
  analysis.reject_cross_environment_averaging = false;
  assert.throws(
    () => verifyRunnerStability(matrix, samples, analysis, verification),
    /Cross-environment averaging must be rejected/
  );
});

test('verifier rejects nonzero variance across deterministic metrics', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const matrix = read('matrix.json');
  const samples = read('samples.json');
  const analysis = read('analysis.json');
  const verification = read('verification.json');

  // Inject cross-runner delta
  analysis.metrics.cpu_instructions_consumed.cross_runner_delta = 50;
  assert.throws(
    () => verifyRunnerStability(matrix, samples, analysis, verification),
    /zero cross-runner delta/
  );
});

test('verifier rejects substituting zero for unavailable metrics', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const matrix = read('matrix.json');
  const samples = read('samples.json');
  const analysis = read('analysis.json');
  const verification = read('verification.json');

  // Substitute 0 for unavailable metric
  analysis.metrics.historical_data_read_bytes.consumed = 0;
  assert.throws(
    () => verifyRunnerStability(matrix, samples, analysis, verification),
    /Unavailable metric historical_data_read_bytes must have null consumption/
  );
});
