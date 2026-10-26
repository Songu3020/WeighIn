const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {analyzeRepeatability}=require('./experiments/repeatability-analysis.cjs');
const directory=path.resolve(__dirname,'../docs/experiments/repeatability/completed');
const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('saved live evidence contains five separate empty-target builds of the exact saved source',()=>{
  const runs=read('runs.json'),environment=read('environment.json');
  assert.equal(runs.length,5);
  assert.equal(new Set(runs.map(r=>r.reference_build.cargo_target_dir)).size,5);
  for(const [name,expected] of Object.entries(environment.source_files_sha256)){
    assert.equal(hash(fs.readFileSync(path.join(directory,'source',name))),expected);
  }
  for(const run of runs){
    assert.equal(run.source_snapshot_sha256,environment.source_snapshot_sha256);
    assert.equal(hash(fs.readFileSync(path.join(directory,`run-${run.run}-reference.wasm`))),run.reference_build.wasm_sha256);
    assert.equal(run.reference_build.compiled_cache_initial_entries,0);
    assert.ok(run.reference_build.compiled_cache_entries_after_build.includes('wasm32v1-none'));
  }
  assert.deepEqual(analyzeRepeatability(runs),read('analysis.json'));
  assert.equal(read('verification.json').completed_clean_reference_builds,5);
});

test('all 35 saved measurements link to real native inputs and matching raw RPC simulation values',()=>{
  let count=0;
  for(const run of read('runs.json')){
    const native=read(`run-${run.run}-native.json`),calls=read(`run-${run.run}-rpc.json`);
    for(const contract of [...run.reference_measurements,...run.audit_measurements]) for(const benchmark of contract.benchmarks){
      count++;
      const replay=native.find(row=>hash(JSON.stringify(row.input))===benchmark.provenance.input_sha256);
      assert.ok(replay?.output,'measurement must identify its captured native invocation');
      const output=replay.output;
      assert.ok(calls.some(call=>call.request.method==='simulateTransaction'
        &&call.raw.result?.transactionData===output.transaction_data_xdr
        &&call.raw.result?.results?.[0]?.xdr===output.retval_xdr),'native output must match a real RPC result');
      const expected={cpu_instructions:output.cpu_instructions_consumed,memory_bytes:output.memory_bytes_consumed,
        ledger_read_entries:output.read_only_keys.length+output.read_write_keys.length,
        ledger_read_bytes:output.disk_read_bytes,ledger_write_entries:output.read_write_keys.length,
        ledger_write_bytes:output.write_bytes,events_count:output.contract_events_xdr.length,
        event_data_bytes:[...output.contract_events_xdr,output.retval_xdr].reduce((sum,value)=>sum+Buffer.from(value,'base64').length,0)};
      for(const [metric,value] of Object.entries(expected)) assert.equal(benchmark.metrics[metric].consumed,value,metric);
      for(const metric of ['historical_data_read_bytes','contract_data_hard_limit','tx_size_bytes']){
        assert.equal(benchmark.metrics[metric].consumed,null);
      }
    }
  }
  assert.equal(count,35);
});

test('controlled ledger-variation evidence demonstrates REPEATABILITY_VARIATION_FOUND with fixed WASM and preserved policy enforcement',()=>{
  const ledgerDir=path.resolve(__dirname,'../docs/experiments/ledger-variation');
  const readLedger=name=>JSON.parse(fs.readFileSync(path.join(ledgerDir,name),'utf8'));
  const runs=readLedger('runs.json'),analysis=readLedger('analysis.json'),policy=readLedger('policy.json');
  const {enforceThresholds}=require('../dist/threshold');
  assert.deepEqual(analyzeRepeatability(runs),analysis);
  assert.equal(analysis.status,'REPEATABILITY_VARIATION_FOUND');
  assert.equal(analysis.reference.wasm_stable,true);
  assert.equal(analysis.reference.metrics_stable,false);
  assert.equal(analysis.arbitrary_live_state_determinism_proven,false);
  assert.deepEqual(enforceThresholds(analysis.reference.diffs[1],policy),[]);
  assert.deepEqual(enforceThresholds(analysis.reference.diffs[4],policy),readLedger('violations.json'));
});
