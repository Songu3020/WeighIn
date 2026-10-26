const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { xdr, StrKey } = require('@stellar/stellar-sdk');
const { parseFixtures } = require('../dist/identity');
const { diffBenchmarks } = require('../dist/diff');
const { validateConfig } = require('../dist/threshold');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'docs/experiments/nested-invocation');
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const fixtureTemplate = name => fs.readFileSync(path.join(root, 'tests/fixtures/nested-invocation', name), 'utf8');

function classifyFootprint(output) {
  const keys = [...output.read_only_keys, ...output.read_write_keys].map(value => xdr.LedgerKey.fromXDR(value, 'base64'));
  const readOnly = new Set(output.read_only_keys);
  const storage = [], instances = new Set(), codeHashes = new Set();
  for (const key of keys) {
    if (key.switch().name === 'contractCode') codeHashes.add(key.contractCode().hash().toString('hex'));
    else if (key.switch().name === 'contractData') {
      const data = key.contractData();
      const contract = data.contract().switch().name === 'scAddressTypeContract'
        ? StrKey.encodeContract(data.contract().contractId())
        : null;
      if (data.key().switch().name === 'scvLedgerKeyContractInstance') instances.add(contract);
      else storage.push({ contract, key_name: data.key().sym().toString(), read_write: !readOnly.has(key.toXDR('base64')) });
    }
  }
  return { keys: keys.map(key => key.toXDR('base64')), storage, instances, codeHashes };
}

test('retained nested-invocation evidence has intact sources, wasm hashes and a pinned live environment', () => {
  for (const [file, expected] of Object.entries(read('sha256.json'))) {
    assert.equal(hash(fs.readFileSync(path.join(directory, file))), expected, file);
  }
  const proof = read('verification.json'), environment = read('environment.json');
  assert.equal(proof.status, 'LIVE_NESTED_INVOCATION_PROOF_PASS');
  assert.equal(proof.real_build_deployment_rpc_and_native, true);
  assert.equal(proof.nested_host_call, true);
  assert.equal(proof.independent_invocation_substitute, false);
  assert.equal(proof.state_mutations_are_simulated_only, true);
  assert.equal(proof.measurement_schema, 4);
  assert.equal(hash(fs.readFileSync(path.join(directory, 'nested-callee.wasm'))), proof.wasm_sha256.callee);
  assert.equal(hash(fs.readFileSync(path.join(directory, 'nested-caller.wasm'))), proof.wasm_sha256.caller);
  assert.equal(hash(fs.readFileSync(path.join(directory, 'nested-callee-regression.wasm'))), proof.wasm_sha256.callee_regression);
  assert.notEqual(proof.wasm_sha256.callee, proof.wasm_sha256.callee_regression);
  assert.match(environment.quickstart_image, /stellar\/quickstart@sha256:4c8bad1ef7341205b898f83d9489321da80c7bd74183100fc8e2a39a5938c7d5/);
  assert.equal(environment.network_passphrase, 'Standalone Network ; February 2017');
  assert.equal(environment.protocol_version, 28);
  assert.equal(environment.contract_sdk, '28.0.0');
  assert.match(environment.stellar_cli, /stellar-xdr 28\./);
  assert.ok(fs.existsSync(path.join(directory, 'callee.rs')) && fs.existsSync(path.join(directory, 'caller.rs')));
  assert.ok(fs.existsSync(path.join(directory, 'Cargo.toml')) && fs.existsSync(path.join(directory, 'Cargo.lock')));
});

test('fixture templates declare explicit identities and the caller binds the callee address token', () => {
  const callee = parseFixtures(fixtureTemplate('callee-fixtures.json'), 'callee-fixtures.json');
  const caller = parseFixtures(fixtureTemplate('caller-fixtures.json'), 'caller-fixtures.json');
  const failure = parseFixtures(fixtureTemplate('caller-failure-fixtures.json'), 'caller-failure-fixtures.json');
  assert.equal(callee.contracts[0].logical_id, 'id:callee');
  assert.equal(callee.contracts[0].invocations[0].case_id, 'id:work-once');
  assert.equal(callee.contracts[0].invocations[0].function_name, 'work');
  assert.equal(caller.contracts[0].logical_id, 'id:caller');
  assert.equal(caller.contracts[0].invocations[0].case_id, 'id:nested-work');
  assert.equal(caller.contracts[0].invocations[0].function_name, 'run');
  assert.equal(caller.contracts[0].invocations[0].args[0].type, 'address');
  assert.equal(caller.contracts[0].invocations[0].args[0].value, '{{NESTED_CALLEE_ADDRESS}}');
  assert.equal(failure.contracts[0].invocations[0].function_name, 'run_failing');
  assert.equal(failure.contracts[0].invocations[0].args[0].value, '{{NESTED_CALLEE_ADDRESS}}');
  for (const spec of [fixtureTemplate('callee-fixtures.json'), fixtureTemplate('caller-fixtures.json'), fixtureTemplate('caller-failure-fixtures.json')]) {
    assert.doesNotThrow(() => validateConfig({ thresholds: { functions: Object.fromEntries(JSON.parse(spec).contracts[0].invocations.map(invocation => [invocation.function_name, { cpu_instructions: 'strict_zero_tolerance' }])) } }));
  }
});

test('nested host invocation attributes the combined footprint, ordered events and return to the measured caller case', () => {
  const records = read('measurements.json'), replays = read('native-replays.json'), captures = read('rpc-captures.json');
  const callerRecord = records.base.find(r => r.logical_id === 'id:caller');
  const calleeRecord = records.base.find(r => r.logical_id === 'id:callee');
  const nested = callerRecord.benchmarks.find(b => b.case_id === 'id:nested-work');
  const calleeAlone = calleeRecord.benchmarks.find(b => b.case_id === 'id:work-once');
  const nestedReplay = replays.find(r => r.output && hash(JSON.stringify(r.input)) === nested.provenance.input_sha256);
  const calleeReplay = replays.find(r => r.output && hash(JSON.stringify(r.input)) === calleeAlone.provenance.input_sha256);
  assert.ok(nestedReplay && calleeReplay);
  const nestedRaw = captures.find(c => c.request.method === 'simulateTransaction' && c.raw.result?.latestLedger === nested.provenance.ledger
    && c.raw.result?.transactionData === nestedReplay.output.transaction_data_xdr
    && c.raw.result?.results?.[0]?.xdr === nestedReplay.output.retval_xdr);
  assert.ok(nestedRaw, 'parity-accepted raw RPC response for the nested invocation');
  const proof = read('verification.json');
  const resources = xdr.SorobanTransactionData.fromXDR(nestedRaw.raw.result.transactionData, 'base64').resources();
  const events = nestedRaw.raw.result.events.map(value => xdr.DiagnosticEvent.fromXDR(value, 'base64'))
    .filter(event => event.inSuccessfulContractCall() && event.event().type().name !== 'diagnostic')
    .map(event => event.event());
  assert.equal(nested.metrics.events_count.consumed, 2);
  assert.equal(nested.metrics.events_count.limit, null);
  assert.match(nested.metrics.events_count.limit_reason, /no independent/);
  assert.deepEqual(events.map(event => event.toXDR('base64')), nestedReplay.output.contract_events_xdr);
  const contractAddress = event => StrKey.encodeContract(event.contractId());
  assert.equal(contractAddress(events[0]), proof.runtime_contract_ids.base_callee);
  assert.equal(contractAddress(events[1]), proof.runtime_contract_ids.base_caller);
  assert.equal(nestedReplay.output.contract_events_xdr[0], calleeReplay.output.contract_events_xdr[0], 'callee event preserved inside the nested transaction');
  assert.equal(nested.metrics.events_count.consumed, events.length);
  assert.equal(nested.metrics.event_data_bytes.consumed,
    nestedReplay.output.contract_events_xdr.reduce((sum, value) => sum + Buffer.from(value, 'base64').length, 0)
    + Buffer.from(nestedReplay.output.retval_xdr, 'base64').length);
  assert.equal(nested.metrics.ledger_read_entries.consumed, resources.footprint().readOnly().length + resources.footprint().readWrite().length);
  assert.equal(nested.metrics.ledger_read_bytes.consumed, resources.diskReadBytes());
  assert.equal(nested.metrics.ledger_read_bytes.consumed, 0);
  assert.equal(nested.metrics.ledger_write_entries.consumed, resources.footprint().readWrite().length);
  assert.equal(nested.metrics.ledger_write_bytes.consumed, resources.writeBytes());
  for (const key of ['historical_data_read_bytes', 'contract_data_hard_limit', 'tx_size_bytes']) {
    assert.equal(nested.metrics[key].availability, 'unavailable');
    assert.equal(nested.metrics[key].consumed, null);
    assert.ok(nested.metrics[key].reason);
  }
  const nestedFootprint = classifyFootprint(nestedReplay.output);
  const calleeFootprint = classifyFootprint(calleeReplay.output);
  assert.ok(nestedFootprint.codeHashes.has(proof.wasm_sha256.callee));
  assert.ok(nestedFootprint.codeHashes.has(proof.wasm_sha256.caller));
  assert.ok(nestedFootprint.instances.has(proof.runtime_contract_ids.base_callee));
  assert.ok(nestedFootprint.instances.has(proof.runtime_contract_ids.base_caller));
  for (const key of calleeFootprint.keys) assert.ok(nestedFootprint.keys.includes(key));
  assert.equal(nestedFootprint.keys.filter(key => !calleeFootprint.keys.includes(key)).length, 3, 'caller contributes exactly code, instance and one storage key');
  const extraStorage = nestedFootprint.storage.filter(entry => entry.read_write
    && !calleeFootprint.storage.some(callee => callee.contract === entry.contract && callee.key_name === entry.key_name));
  assert.equal(extraStorage.length, 1);
  assert.equal(extraStorage[0].contract, proof.runtime_contract_ids.base_caller);
  assert.equal(extraStorage[0].key_name, 'last');
  assert.ok(nested.metrics.cpu_instructions.consumed > calleeAlone.metrics.cpu_instructions.consumed);
  assert.ok(nested.metrics.ledger_read_entries.consumed > calleeAlone.metrics.ledger_read_entries.consumed);
  assert.equal(nested.metrics.ledger_write_entries.consumed, calleeAlone.metrics.ledger_write_entries.consumed + 1);
  assert.ok(nested.metrics.event_data_bytes.consumed > calleeAlone.metrics.event_data_bytes.consumed);
});

test('address-swapped control pairs by explicit invocation identity with zero comparable deltas', () => {
  const records = read('measurements.json');
  const controlDiff = diffBenchmarks(records.base, records.control);
  assert.equal(controlDiff.hasRegression, false);
  assert.equal(controlDiff.contracts.length, 2);
  for (const contract of controlDiff.contracts) {
    assert.notEqual(contract.base_contract_id, contract.head_contract_id, 'runtime addresses differ across deployers');
    const comparable = contract.functions.flatMap(fn => fn.metrics.filter(m => m.availability === 'comparable'));
    assert.equal(comparable.length, 8);
    assert.ok(comparable.every(m => m.delta === 0));
  }
  const proof = read('verification.json');
  assert.equal(proof.identity_stability.address_swapped_control_paired, true);
  assert.equal(proof.identity_stability.runtime_addresses_differ, true);
  assert.equal(proof.identity_stability.explicit_invocation_ids_required_for_pairing, true);
});

test('callee-only regression attributes extra nested resources to the unchanged caller case', () => {
  const proof = read('verification.json'), regression = read('regression-diff.json'), violations = read('violations.json');
  assert.equal(proof.callee_only_regression.detected, true);
  assert.equal(proof.callee_only_regression.caller_wasm_unchanged, true);
  assert.equal(proof.callee_only_regression.caller_runtime_address_unchanged, true);
  assert.equal(regression.hasRegression, true);
  assert.equal(proof.runtime_contract_ids.base_caller, proof.runtime_contract_ids.head_caller);
  assert.notEqual(proof.runtime_contract_ids.base_callee, proof.runtime_contract_ids.head_callee);
  const nestedMetrics = regression.contracts.find(c => c.logical_id === 'id:caller').functions[0].metrics;
  const calleeMetrics = regression.contracts.find(c => c.logical_id === 'id:callee').functions[0].metrics;
  assert.ok(nestedMetrics.find(m => m.key === 'cpu_instructions').delta > 0);
  assert.ok(nestedMetrics.find(m => m.key === 'ledger_write_bytes').delta > 0);
  assert.ok(calleeMetrics.find(m => m.key === 'cpu_instructions').delta > 0);
  assert.equal(violations.length, 2);
  assert.ok(violations.every(v => v.delta > 0));
  assert.ok(fs.readFileSync(path.join(directory, 'report.md'), 'utf8').length > 0);
});

test('failure classification and the archived-state control are retained with exact diagnostics', () => {
  const probes = read('failure-probes.json'), archive = read('archive-control.json'), proof = read('verification.json');
  assert.match(probes.applicationFailure.message, /^Simulation failed for run_failing/);
  assert.match(probes.invalidInput.message, /Invalid value for address/);
  assert.equal(probes.invalidInput.detected_before_simulation, true);
  assert.match(probes.infrastructureFailure.message, /Simulation helper missing or not executable/);
  assert.equal(probes.applicationFailure.classification, 'application_failure');
  assert.equal(probes.invalidInput.classification, 'invalid_input');
  assert.equal(probes.infrastructureFailure.classification, 'infrastructure_failure');
  assert.equal(proof.failure_classification.distinct_classes, true);
  assert.equal(archive.status, 'ARCHIVED_STATE_REJECTED');
  assert.equal(archive.exit_code, 1);
  assert.equal(archive.live_until, archive.header_ledger - 1);
  assert.match(archive.stderr, /archived ledger state is unsupported/);
  assert.equal(proof.archive_control.rejected, true);
});

test('nested-invocation documentation links resolve and the limitation is recorded', () => {
  const files = ['docs/nested-invocation.md', 'docs/EVIDENCE.md', 'docs/KNOWN_LIMITATIONS.md', 'README.md'];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /WEIGHIN_PROGRESS|DRIPS_APPEAL_CONTEXT|Drips|appeal preparation/);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^https?:/.test(target)) continue;
      assert.ok(fs.existsSync(path.resolve(root, path.dirname(file), target)), `${file}: ${target}`);
    }
  }
  assert.ok(fs.readFileSync(path.join(root, 'docs/nested-invocation.md'), 'utf8').includes('(experiments/nested-invocation/verification.json)'));
  assert.ok(fs.readFileSync(path.join(root, 'docs/KNOWN_LIMITATIONS.md'), 'utf8').includes('nested'));
});
