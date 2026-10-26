const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseFixtures } = require('../dist/identity');
const { diffBenchmarks } = require('../dist/diff');
const { enforceThresholds } = require('../dist/threshold');

const archiveDir = path.resolve(__dirname, '../docs/experiments/distinct-contracts-control');
const fixturePath = path.resolve(__dirname, 'fixtures/distinct-contracts/distinct-fixtures.json');

const hash = (data) => createHash('sha256').update(data).digest('hex');

function verifyDistinctControl(proof, diff, expectedIdentities) {
  assert.equal(proof.status, 'VERIFIED');
  assert.equal(proof.scenario, 'control');
  assert.equal(proof.action_exit, 0);
  assert.equal(proof.action_outcome, 'success');
  assert.equal(proof.result, 'pass');

  // Verify two distinct contracts with explicit logical identities
  assert.equal(diff.contracts.length, 2, 'Exactly two contracts must be compared');
  assert.deepEqual(diff.newContracts, []);
  assert.deepEqual(diff.removedContracts, []);
  assert.equal(diff.hasRegression, false);

  const contractIdentities = diff.contracts.map((c) => [c.fixture_id, c.logical_id]).sort();
  assert.deepEqual(contractIdentities, expectedIdentities.slice().sort(), 'Expected contract identities must match exactly');

  // Distinct WASMs (build hashes must differ between contracts)
  assert.notEqual(
    proof.distinct_wasm_hashes['id:contract-alpha'],
    proof.distinct_wasm_hashes['id:contract-beta'],
    'Contracts must have genuinely distinct WASM hashes',
  );
  assert.notEqual(
    proof.runtime_contract_ids['id:contract-alpha'],
    proof.runtime_contract_ids['id:contract-beta'],
    'Contracts must have distinct runtime deployment addresses',
  );

  for (const c of diff.contracts) {
    // Assert each contract pairs only with its own base/head
    assert.equal(c.base_contract_id, c.head_contract_id, 'Control must have matching runtime addresses');
    assert.equal(c.base_commit, proof.base_sha);
    assert.equal(c.head_commit, proof.head_sha);

    // Overlapping function and case labels
    assert.equal(c.functions.length, 1);
    assert.equal(c.functions[0].function_name, 'hello', 'Function label hello must overlap');
    assert.equal(c.functions[0].case_id, 'id:world', 'Case label id:world must overlap');
    assert.deepEqual(c.newBenchmarks, []);
    assert.deepEqual(c.removedBenchmarks, []);
    assert.deepEqual(c.newFunctions, []);
    assert.deepEqual(c.removedFunctions, []);

    // Verify all 8 comparable metrics are measured and deltas are exactly zero in control
    const measuredMetrics = c.functions[0].metrics.filter((m) => m.availability === 'comparable');
    assert.equal(measuredMetrics.length, 8, 'Must measure exactly 8 comparable metrics');
    for (const m of measuredMetrics) {
      assert.equal(m.delta, 0, `Nonzero control delta for ${c.logical_id} metric ${m.key}`);
      assert.equal(m.regression, false);
      assert.equal(m.base.availability, 'measured');
      assert.equal(m.head.availability, 'measured');
    }
  }

  // Must remain distinct from future stateful caller/callee proofs
  assert.equal(proof.inter_contract_stateful_call, false, 'Must be independent-contract proof, not caller/callee stateful invocation');
  return true;
}

test('retained distinct-contracts control evidence matches checksums and satisfies all criteria', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const sha256 = read('sha256.json');
  for (const [file, expectedHash] of Object.entries(sha256)) {
    assert.equal(hash(fs.readFileSync(path.join(archiveDir, file))), expectedHash, `Checksum mismatch for ${file}`);
  }

  const proof = read('verification.json');
  const diff = read('diff.json');
  const expectedIdentities = [
    ['id:distinct-contracts-suite', 'id:contract-alpha'],
    ['id:distinct-contracts-suite', 'id:contract-beta'],
  ];

  assert.ok(verifyDistinctControl(proof, diff, expectedIdentities));
});

test('fixtures declare two distinct contracts with overlapping function and case labels and explicit IDs', () => {
  const fixturesRaw = fs.readFileSync(fixturePath, 'utf8');
  const fixtures = parseFixtures(fixturesRaw, 'distinct-fixtures.json');

  assert.equal(fixtures.fixture_id, 'id:distinct-contracts-suite');
  assert.equal(fixtures.contracts.length, 2);

  const alpha = fixtures.contracts.find((c) => c.logical_id === 'id:contract-alpha');
  const beta = fixtures.contracts.find((c) => c.logical_id === 'id:contract-beta');
  assert.ok(alpha, 'contract-alpha must be declared');
  assert.ok(beta, 'contract-beta must be declared');

  assert.notEqual(alpha.wasm_path, beta.wasm_path, 'Contracts must use distinct WASM paths');
  assert.equal(alpha.invocations[0].function_name, beta.invocations[0].function_name, 'Function labels must overlap');
  assert.equal(alpha.invocations[0].case_id, beta.invocations[0].case_id, 'Case labels must overlap');
});

test('verifier rejects swapped identities between distinct contracts', () => {
  const proof = JSON.parse(fs.readFileSync(path.join(archiveDir, 'verification.json'), 'utf8'));
  const diff = JSON.parse(fs.readFileSync(path.join(archiveDir, 'diff.json'), 'utf8'));
  const expectedIdentities = [
    ['id:distinct-contracts-suite', 'id:contract-alpha'],
    ['id:distinct-contracts-suite', 'id:contract-beta'],
  ];

  // Swapped logical IDs in diff
  diff.contracts[0].logical_id = 'id:contract-beta';
  diff.contracts[1].logical_id = 'id:contract-alpha';
  // With swapped logical IDs and mismatched runtime IDs
  diff.contracts[0].head_contract_id = diff.contracts[1].base_contract_id;

  assert.throws(
    () => verifyDistinctControl(proof, diff, expectedIdentities),
    /Control must have matching runtime addresses/,
  );
});

test('verifier rejects missing contracts from control diff', () => {
  const proof = JSON.parse(fs.readFileSync(path.join(archiveDir, 'verification.json'), 'utf8'));
  const diff = JSON.parse(fs.readFileSync(path.join(archiveDir, 'diff.json'), 'utf8'));
  const expectedIdentities = [
    ['id:distinct-contracts-suite', 'id:contract-alpha'],
    ['id:distinct-contracts-suite', 'id:contract-beta'],
  ];

  // Remove contract-beta
  diff.contracts = [diff.contracts[0]];

  assert.throws(
    () => verifyDistinctControl(proof, diff, expectedIdentities),
    /Exactly two contracts must be compared/,
  );
});

test('verifier rejects nonzero control deltas across any metric in distinct contracts', () => {
  const proof = JSON.parse(fs.readFileSync(path.join(archiveDir, 'verification.json'), 'utf8'));
  const diff = JSON.parse(fs.readFileSync(path.join(archiveDir, 'diff.json'), 'utf8'));
  const expectedIdentities = [
    ['id:distinct-contracts-suite', 'id:contract-alpha'],
    ['id:distinct-contracts-suite', 'id:contract-beta'],
  ];

  // Introduce a delta into contract-beta
  diff.contracts[1].functions[0].metrics[0].delta = 500;

  assert.throws(
    () => verifyDistinctControl(proof, diff, expectedIdentities),
    /Nonzero control delta for id:contract-beta metric cpu_instructions/,
  );
});

test('verifier rejects unexpected added or removed benchmark cases', () => {
  const proof = JSON.parse(fs.readFileSync(path.join(archiveDir, 'verification.json'), 'utf8'));
  const diff = JSON.parse(fs.readFileSync(path.join(archiveDir, 'diff.json'), 'utf8'));
  const expectedIdentities = [
    ['id:distinct-contracts-suite', 'id:contract-alpha'],
    ['id:distinct-contracts-suite', 'id:contract-beta'],
  ];

  // Add an unexplained new benchmark
  diff.contracts[0].newBenchmarks.push({ function_name: 'hello', case_id: 'id:unexplained' });

  assert.throws(
    () => verifyDistinctControl(proof, diff, expectedIdentities),
  );
});
