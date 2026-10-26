const { test } = require('node:test');
const assert = require('node:assert/strict');
const { xdr } = require('@stellar/stellar-sdk');
const { metricsFromSimulation } = require('../dist/measurement');
const { diffBenchmarks } = require('../dist/diff');
const { enforceThresholds } = require('../dist/threshold');
const { renderComment } = require('../dist/comment');
const records = require('../docs/experiments/metric-provenance/measurements.json');
const replays = require('../docs/experiments/metric-provenance/native-replays.json');
const captures = require('../docs/experiments/metric-provenance/rpc-captures.json');
const { createHash } = require('node:crypto');
const clone = value => structuredClone(value);
const benchmark = id => records[0].benchmarks.find(b => b.case_id === `id:${id}`);

function limits(input) {
  const settings = Object.fromEntries(input.entries.filter(row => row.xdr).map(row => xdr.LedgerEntryData.fromXDR(row.xdr,'base64'))
    .filter(data => data.switch().name === 'configSetting').map(data => [data.configSetting().switch().name,data.configSetting()]));
  const compute = settings.configSettingContractComputeV0.contractCompute();
  const io = settings.configSettingContractLedgerCostV0.contractLedgerCost();
  return { cpu_instructions:Number(compute.txMaxInstructions().toString()),memory_bytes:compute.txMemoryLimit(),
    footprint_entries:settings.configSettingContractLedgerCostExtV0.contractLedgerCostExt().txMaxFootprintEntries(),
    disk_read_bytes:io.txMaxDiskReadBytes(),write_entries:io.txMaxWriteLedgerEntries(),write_bytes:io.txMaxWriteBytes(),
    events_and_return_bytes:settings.configSettingContractEventsV0.contractEvents().txMaxContractEventsSizeBytes() };
}
function currentSchemaRecords() {
  const current = clone(records);
  for (const contract of current) contract.schema_version = 5;
  return current;
}
test('all six real cases map the native output and immutable captured caps to production metrics', () => {
  for (const measured of records[0].benchmarks) {
    const replay = replays.find(r => r.output && createHash('sha256').update(JSON.stringify(r.input)).digest('hex') === measured.provenance.input_sha256);
    assert.ok(replay,measured.case_id);
    assert.deepEqual(metricsFromSimulation(replay.output,limits(replay.input)),measured.metrics);
    for (const metric of Object.values(measured.metrics).filter(m => m.availability === 'measured')) {
      assert.ok(metric.source);
      assert.ok(metric.limit === null ? metric.limit_reason : metric.limit_source);
    }
  }
});
test('promoted consumption agrees directly with parity-accepted raw RPC fields and event XDR', () => {
  for (const measured of records[0].benchmarks) {
    const replay = replays.find(r => r.output && createHash('sha256').update(JSON.stringify(r.input)).digest('hex') === measured.provenance.input_sha256);
    const raw = captures.find(c => c.request.method === 'simulateTransaction' && c.raw.result?.latestLedger === measured.provenance.ledger
      && c.raw.result?.transactionData === replay.output.transaction_data_xdr
      && xdr.TransactionEnvelope.fromXDR(c.request.params.transaction,'base64').v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().toXDR('base64') === replay.input.host_function_xdr).raw.result;
    const resource = xdr.SorobanTransactionData.fromXDR(raw.transactionData,'base64').resources();
    const m = measured.metrics;
    assert.equal(m.ledger_read_entries.consumed,resource.footprint().readOnly().length+resource.footprint().readWrite().length);
    assert.equal(m.ledger_read_bytes.consumed,resource.diskReadBytes());
    assert.equal(m.ledger_write_entries.consumed,resource.footprint().readWrite().length);
    assert.equal(m.ledger_write_bytes.consumed,resource.writeBytes());
    const events = raw.events.map(e=>xdr.DiagnosticEvent.fromXDR(e,'base64')).filter(e=>e.inSuccessfulContractCall() && e.event().type().name !== 'diagnostic');
    assert.equal(m.events_count.consumed,events.length);
    assert.equal(m.event_data_bytes.consumed,events.reduce((sum,e)=>sum+e.event().toXDR().length,0)+xdr.ScVal.fromXDR(raw.results[0].xdr,'base64').toXDR().length);
  }
});
test('repeated reads and queried absence count distinct footprint keys; live Soroban disk bytes are measured zero', () => {
  const m = benchmark('read-missing-repeat').metrics;
  assert.equal(m.ledger_read_entries.consumed,4);
  assert.equal(m.ledger_read_bytes.availability,'measured'); assert.equal(m.ledger_read_bytes.consumed,0);
  assert.equal(benchmark('classic-read').metrics.ledger_read_bytes.consumed,144);
});
test('no-op write charges a postimage; deletion retains RW footprint but has zero postimage bytes', () => {
  const noop = benchmark('noop-write').metrics, deletion = benchmark('delete').metrics;
  assert.equal(noop.ledger_write_entries.consumed,1); assert.equal(noop.ledger_write_bytes.consumed,80);
  assert.equal(deletion.ledger_write_entries.consumed,1); assert.equal(deletion.ledger_write_bytes.consumed,0);
});
test('diagnostic events are excluded and return bytes contribute with no emitted contract event', () => {
  assert.equal(benchmark('event').metrics.events_count.consumed,1);
  assert.equal(benchmark('event').metrics.event_data_bytes.consumed,96);
  const m = benchmark('large-return').metrics;
  assert.equal(m.events_count.consumed,0); assert.equal(m.events_count.limit,null);
  assert.match(m.events_count.limit_reason,/no independent/); assert.equal(m.event_data_bytes.consumed,652);
});
test('schema 4 control compares all eight measured fields and explicitly retains three unavailable metrics', () => {
  const diff = diffBenchmarks(records,clone(records));
  assert.equal(diff.hasRegression,false);
  for (const fn of diff.contracts[0].functions) {
    assert.equal(fn.metrics.filter(m=>m.availability === 'comparable').length,8);
    assert.ok(fn.metrics.filter(m=>m.availability === 'comparable').every(m=>m.delta === 0));
    assert.equal(fn.metrics.filter(m=>m.availability === 'unavailable').length,3);
  }
  const violations = enforceThresholds(diff,{ thresholds:{ global:{fail_on_any_regression:true} } });
  assert.equal(violations.length,18); assert.ok(violations.every(v=>v.delta === null));
});
test('schema 5 accepts the approved per-metric mapping and rejects matching fabricated mappings on both sides', () => {
  const current = currentSchemaRecords();
  assert.equal(require('../dist/record-schema').inspectMeasurementRecords(current).valid, true);
  const diff = diffBenchmarks(current, clone(current));
  assert.equal(diff.hasRegression, false);

  const base = clone(current), head = clone(current);
  for (const side of [base, head]) {
    side[0].benchmarks[0].metrics.cpu_instructions.source = 'fabricated.cpu';
    side[0].benchmarks[0].metrics.cpu_instructions.limit_source = 'fabricated.cap';
  }
  assert.throws(
    () => diffBenchmarks(base, head),
    /Schema 5 metric cpu_instructions has unapproved source provenance/,
  );

  const unmatched = clone(current);
  unmatched[0].logical_id = 'id:unmatched';
  unmatched[0].benchmarks[0].metrics.cpu_instructions.source = 'fabricated.cpu';
  assert.throws(
    () => diffBenchmarks(current, unmatched),
    /Schema 5 metric cpu_instructions has unapproved source provenance/,
  );
});
test('schema 4 records remain valid without rewriting and require explicit remeasurement to compare with schema 5', () => {
  assert.equal(require('../dist/record-schema').inspectMeasurementRecords(records).valid, true);
  assert.throws(
    () => diffBenchmarks(records, currentSchemaRecords()),
    /different schema versions/,
  );
});
test('measured event count without independent network cap can fail a configured regression policy', () => {
  // Behavior-level policy test uses real measurements, selecting two fixture
  // cases as successive revisions of one explicitly named benchmark case.
  const base = clone(records), head = clone(records);
  base[0].benchmarks = [clone(benchmark('read-missing-repeat'))];
  head[0].benchmarks = [clone(benchmark('event'))];
  head[0].benchmarks[0].case_id = base[0].benchmarks[0].case_id;
  const diff = diffBenchmarks(base,head);
  assert.equal(diff.contracts[0].functions[0].metrics.find(m=>m.key==='events_count').delta,1);
  assert.equal(enforceThresholds(diff,{thresholds:{functions:{bench:{events_count:'strict_zero_tolerance'}}}}).length,1);
});
test('resource cap/source/availability changes refuse schema 4 comparison', () => {
  const changes = [
    b => { b.provenance.resource_limits_sha256='a'.repeat(64); },
    b => { b.metrics.ledger_read_bytes.source='different'; },
    b => { b.metrics.ledger_read_bytes.limit++; },
    b => { b.metrics.events_count.limit_reason='different'; },
    b => { b.metrics.ledger_read_bytes={availability:'unavailable',consumed:null,limit:null,reason:'unsupported'}; },
  ];
  for (const change of changes) {
    const head=clone(records); change(head[0].benchmarks[0]);
    assert.throws(()=>diffBenchmarks(records,head),/Incompatible measurement environment|Incompatible metric semantics/);
  }
});
test('missing cap provenance/resource hash and schema 3 migration fail explicitly, including unmatched records', () => {
  for (const change of [b=>{delete b.provenance.resource_limits_sha256;}, b=>{delete b.metrics.ledger_read_bytes.limit_source;}, b=>{delete b.metrics.events_count.limit_reason;}]) {
    const head=clone(records); head[0].logical_id='id:unmatched'; change(head[0].benchmarks[0]);
    assert.throws(()=>diffBenchmarks(records,head),/Schema 4 requires/);
  }
  const old=clone(records);old[0].schema_version=3;
  assert.throws(()=>diffBenchmarks(old,records),/different schema versions/);
});
test('schema 4 report distinguishes footprint, disk bytes, events plus return, no cap and unavailable metrics', () => {
  const report=renderComment(diffBenchmarks(records,records),[],'base','head');
  for(const label of ['Footprint Entries (RO + RW)','Disk Read Bytes','Write Footprint Entries','Events + Return XDR Bytes','No independent limit','ConfigSettingContractLedgerCostV0.txMaxWriteBytes','Resource limits SHA256','Unavailable','— (BASE 0)']) {
    assert.ok(report.includes(label),label);
  }
});
