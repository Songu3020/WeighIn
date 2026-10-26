const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { xdr, StrKey } = require('@stellar/stellar-sdk');
const { simulateSnapshot } = require('../../dist/simulation');
const helper = path.resolve(__dirname, '../../native/simulation/target/x86_64-unknown-linux-gnu/release/weighin-simulation');
const replays = require('../../docs/experiments/nested-invocation/native-replays.json');
const records = require('../../docs/experiments/nested-invocation/measurements.json');
const proof = require('../../docs/experiments/nested-invocation/verification.json');
const hash = data => createHash('sha256').update(data).digest('hex');

const withOutput = replays.filter(replay => replay.output);

test('nested-invocation snapshots reproduce metered compute, IO and ordered events independently of instruction leeway', async () => {
  assert.ok(withOutput.length >= 6, 'base, control and head snapshots retained');
  for (const captured of withOutput) {
    const output = await simulateSnapshot(captured.input, helper);
    assert.deepEqual(output, captured.output);
    const leeway = await simulateSnapshot({ ...captured.input, instruction_leeway: 5000000 }, helper);
    for (const key of ['cpu_instructions_consumed', 'memory_bytes_consumed', 'disk_read_bytes', 'write_bytes', 'read_only_keys', 'read_write_keys', 'contract_events_xdr', 'retval_xdr']) {
      assert.deepEqual(leeway[key], output[key], key);
    }
    assert.ok(leeway.instruction_budget > output.instruction_budget);
  }
});

test('every reported nested benchmark provenance links to a committed native replay', () => {
  for (const record of records.base.concat(records.control, records.head)) {
    for (const benchmark of record.benchmarks) {
      assert.ok(replays.some(replay => replay.output && hash(JSON.stringify(replay.input)) === benchmark.provenance.input_sha256), benchmark.case_id);
    }
  }
});

test('the nested snapshot footprint is the callee footprint plus the caller code, instance and storage key', () => {
  const nested = records.base.find(r => r.logical_id === 'id:caller').benchmarks.find(b => b.case_id === 'id:nested-work');
  const calleeAlone = records.base.find(r => r.logical_id === 'id:callee').benchmarks.find(b => b.case_id === 'id:work-once');
  const nestedReplay = replays.find(r => r.output && hash(JSON.stringify(r.input)) === nested.provenance.input_sha256);
  const calleeReplay = replays.find(r => r.output && hash(JSON.stringify(r.input)) === calleeAlone.provenance.input_sha256);
  const combined = new Set([...nestedReplay.output.read_only_keys, ...nestedReplay.output.read_write_keys]);
  const callee = new Set([...calleeReplay.output.read_only_keys, ...calleeReplay.output.read_write_keys]);
  for (const key of callee) assert.ok(combined.has(key));
  assert.equal(combined.size - callee.size, 3);
  assert.equal(nestedReplay.output.contract_events_xdr.length, 2);
  assert.equal(nestedReplay.output.contract_events_xdr[0], calleeReplay.output.contract_events_xdr[0]);
  const events = nestedReplay.output.contract_events_xdr.map(value => xdr.ContractEvent.fromXDR(value, 'base64'));
  assert.equal(events[0].body().v0().topics()[0].sym().toString(), 'work');
  assert.equal(events[1].body().v0().topics()[0].sym().toString(), 'caller');
  assert.ok(nested.metrics.cpu_instructions.consumed > calleeAlone.metrics.cpu_instructions.consumed);
});

test('the native helper rejects an expired captured ledger entry instead of inventing a measurement', () => {
  const nested = records.base.find(r => r.logical_id === 'id:caller').benchmarks.find(b => b.case_id === 'id:nested-work');
  const captured = replays.find(r => r.output && hash(JSON.stringify(r.input)) === nested.provenance.input_sha256);
  const input = structuredClone(captured.input);
  const headerLedger = xdr.LedgerHeader.fromXDR(input.header_xdr, 'base64').ledgerSeq();
  const expired = input.entries.find(row => {
    const key = xdr.LedgerKey.fromXDR(row.key, 'base64');
    return key.switch().name === 'contractData'
      && key.contractData().contract().switch().name === 'scAddressTypeContract'
      && StrKey.encodeContract(key.contractData().contract().contractId()) === proof.runtime_contract_ids.base_callee
      && key.contractData().key().switch().name === 'scvLedgerKeyContractInstance';
  });
  assert.ok(expired);
  expired.live_until = headerLedger - 1;
  const run = spawnSync(helper, [], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /archived ledger state is unsupported/);
  assert.equal(proof.archive_control.rejected, true);
});
