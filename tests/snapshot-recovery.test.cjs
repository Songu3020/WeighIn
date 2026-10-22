// Controlled transport tests using real saved schema-4 RPC/native records.
// Injected failures and altered ledgers are not live network evidence.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const cp=require('node:child_process');
const {Transaction,Keypair,xdr}=require('@stellar/stellar-sdk');
const {measureInvocation,captureHelperIdentity}=require('../dist/simulation');
const calls=require('../docs/experiments/repeatability/completed/run-1-rpc.json');
const replay=require('../docs/experiments/repeatability/completed/run-1-native.json')[0];
const saved=calls.find(c=>c.request.method==='simulateTransaction'
  &&c.raw.result?.transactionData===replay.output.transaction_data_xdr);
const transient={code:-32603,message:'could not query captive core: http request failed with non-200 status code (404)'};

function scenario(t,options={}){
  const state={simulations:0,reads:0,helpers:[],methods:[],delays:[],warnings:[]};
  const output=structuredClone(replay.output),simulation=structuredClone(saved.raw.result);
  if(options.multibatch){
    const data=xdr.SorobanTransactionData.fromXDR(simulation.transactionData,'base64');
    const extra=Array.from({length:205},(_,i)=>{
      const seed=Buffer.alloc(32);seed.writeUInt32BE(i+1,28);
      return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({accountId:Keypair.fromRawEd25519Seed(seed).xdrPublicKey()}));
    });
    data.resources().footprint().readOnly([...data.resources().footprint().readOnly(),...extra]);
    simulation.transactionData=data.toXDR('base64');output.transaction_data_xdr=simulation.transactionData;
    output.read_only_keys=data.resources().footprint().readOnly().map(k=>k.toXDR('base64'));
  }
  const txNetworkPassphrase = options.txNetworkPassphrase ?? replay.input.network_passphrase;
  const transaction=new Transaction(saved.request.params.transaction,txNetworkPassphrase);
  const baseLedger=saved.raw.result.latestLedger;
  let entries=replay.input.entries.filter(row=>row.xdr);
  if(options.omitConfigs){
    entries = entries.filter(row => {
      try {
        const k = xdr.LedgerKey.fromXDR(row.key, 'base64');
        if (k.switch().name === 'configSetting') {
          return !options.omitConfigs.includes(k.configSetting().configSettingId().name);
        }
      } catch {}
      return true;
    });
  }
  t.mock.method(console,'warn',message=>state.warnings.push(message));
  t.mock.method(globalThis,'setTimeout',(callback,delay)=>{state.delays.push(delay);return setImmediate(callback);});
  t.mock.method(globalThis,'fetch',async(url,fetchOptions)=>{
    const request=JSON.parse(fetchOptions.body);state.methods.push(request.method);
    let result;
    if(request.method==='getNetwork')result={passphrase:replay.input.network_passphrase,protocolVersion:28};
    if(request.method==='simulateTransaction'){
      state.simulations++;
      const events = options.extraRpcEvents ? [...simulation.events, ...options.extraRpcEvents] : simulation.events;
      result={...simulation,events,latestLedger:baseLedger+state.simulations-1};
    }
    if(request.method==='getLedgerEntries'){
      state.reads++;
      const ledger=baseLedger+state.simulations-1;
      result={latestLedger:ledger,entries:entries.filter(row=>request.params.keys.includes(row.key)).map(row=>({
        key:row.key,xdr:row.xdr,extXdr:row.extension_xdr,lastModifiedLedgerSeq:ledger,
        ...(row.live_until===null?{}:{liveUntilLedgerSeq:row.live_until})}))};
      if(options.driftFirst&&state.reads===1)result.latestLedger++;
      if(options.driftReads?.includes(state.reads))result.latestLedger++;
      if(options.malformed)result.entries=[{key:'invalid'}];
    }
    if(request.method==='getLedgers'){
      const header=xdr.LedgerHeader.fromXDR(replay.input.header_xdr,'base64');
      header.ledgerSeq(baseLedger+state.simulations-1+(options.headerMismatch?1:0));
      const historyHash=crypto.createHash('sha256').update(header.toXDR()).digest();
      const history=new xdr.LedgerHeaderHistoryEntry({hash:historyHash,header,ext:new xdr.LedgerHeaderHistoryEntryExt(0)});
      const seq = baseLedger+state.simulations-1;
      const headerXdr = options.malformedHeaderXdr ? 'invalid-header-xdr' : history.toXDR('base64');
      if (options.duplicateHeaders) {
        result={ledgers:[{sequence:seq,headerXdr},{sequence:seq,headerXdr}]};
      } else if (options.extraPageHeaders) {
        result={ledgers:[
          {sequence:seq - 1, headerXdr},
          {sequence:seq, headerXdr},
          {sequence:seq + 1, headerXdr},
        ]};
      } else {
        result={ledgers:[{sequence:seq,headerXdr}]};
      }
    }
    const error=options.error?.(request.method,state);
    let envelope=error?{jsonrpc:'2.0',id:request.id,error}:{jsonrpc:'2.0',id:request.id,result};
    if(options.badEnvelope==='wrong-id'&&request.method==='getNetwork')envelope={...envelope,id:request.id+1};
    if(options.badEnvelope==='both'&&request.method==='getNetwork')envelope={...envelope,error:{code:-32603,message:'conflicting response'}};
    if(options.badEnvelope==='wrong-version'&&request.method==='getNetwork')envelope={...envelope,jsonrpc:'1.0'};
    return new Response(JSON.stringify(envelope),{status:options.httpFailure?404:200});
  });
  const helperFile = options.helperPath ?? __filename;
  t.mock.method(cp,'execFile',(file,args,childOptions,callback)=>{
    assert.equal(file, helperFile);
    const stdin=new EventEmitter();stdin.end=data=>{
      state.helpers.push(JSON.parse(data));
      if(options.mutateHelperDuringExecution){
        fs.appendFileSync(helperFile, ' // mutated during execution');
      }
      if(options.helperFailure)return setImmediate(()=>callback(new Error(options.helperFailure)));
      if(options.uncapturedKeys){
        if(options.mutateHelperAcrossAttempts){
          fs.appendFileSync(helperFile, ' // mutated across attempts');
        }
        const seed=Buffer.alloc(32);seed.writeUInt32BE(state.helpers.length+1000,28);
        const k=xdr.LedgerKey.account(new xdr.LedgerKeyAccount({accountId:Keypair.fromRawEd25519Seed(seed).xdrPublicKey()})).toXDR('base64');
        return setImmediate(()=>callback(new Error(`Simulation failed: UNCAPTURED_KEY:${k}`)));
      }
      const actual=structuredClone(output);
      if(options.parityMismatch||options.retvalMismatch)actual.retval_xdr=xdr.ScVal.scvU32(999).toXDR('base64');
      if(options.txDataMismatch){
        const td=xdr.SorobanTransactionData.fromXDR(actual.transaction_data_xdr,'base64');
        td.resources().instructions(td.resources().instructions()+1);
        actual.transaction_data_xdr=td.toXDR('base64');
        actual.instruction_budget+=1;
      }
      if(options.eventsMismatch){
        const ev=new xdr.ContractEvent({
          ext:new xdr.ExtensionPoint(0),
          contractId:null,
          type:xdr.ContractEventType.contract(),
          body:new xdr.ContractEventBody(0,new xdr.ContractEventV0({
            topics:[xdr.ScVal.scvSymbol('test')],
            data:xdr.ScVal.scvVoid(),
          })),
        });
        actual.contract_events_xdr=[ev.toXDR('base64')];
      }
      setImmediate(()=>callback(null,JSON.stringify(actual),''));
    };return {stdin};
  });
  return {state,run:()=>measureInvocation('http://controlled.invalid/rpc',transaction,helperFile),baseLedger};
}

test('observed ledger-read failure recovers by re-simulating and returning only the new snapshot',async t=>{
  const {state,run,baseLedger}=scenario(t,{error:(method,s)=>method==='getLedgerEntries'&&s.reads===1?transient:null});
  const result=await run();assert.equal(result.output.cpu_instructions_consumed,replay.output.cpu_instructions_consumed);
  assert.equal(result.provenance.ledger,baseLedger+1);assert.equal(state.simulations,2);
  assert.equal(state.helpers.length,1);assert.deepEqual(state.delays,[250]);assert.equal(state.warnings.length,1);
});

test('malformed JSON-RPC responses stop measurement before any native helper call', async t=>{
  for(const badEnvelope of ['wrong-id','both','wrong-version']){
    const {state,run}=scenario(t,{badEnvelope});
    await assert.rejects(run(),/RPC getNetwork invalid response.*(?:ID does not match|exactly one|jsonrpc version)/);
    assert.equal(state.helpers.length,0);
    t.mock.restoreAll();
  }
});
test('three transient read failures recover on the fourth complete capture with bounded delays',async t=>{
  const {state,run}=scenario(t,{error:(method,s)=>method==='getLedgerEntries'&&s.reads<=3?transient:null});
  await run();assert.equal(state.simulations,4);assert.deepEqual(state.delays,[250,500,1000]);
  assert.equal(state.helpers.length,1);
});
test('persistent observed errors exhaust retries and return no successful or zero-valued measurement',async t=>{
  const {state,run}=scenario(t,{error:method=>method==='getLedgerEntries'?transient:null});
  await assert.rejects(run(),/retry limit exhausted.*RPC getLedgerEntries failed/);
  assert.equal(state.reads,4);assert.equal(state.simulations,4);assert.equal(state.helpers.length,0);
  assert.deepEqual(state.delays,[250,500,1000]);
});
test('a failure after a successful first batch discards its rows before the next full capture',async t=>{
  const {state,run,baseLedger}=scenario(t,{multibatch:true,error:(method,s)=>method==='getLedgerEntries'&&s.reads===2?transient:null});
  const result=await run();assert.equal(result.provenance.ledger,baseLedger+1);
  assert.equal(state.simulations,2);assert.equal(state.reads,4);assert.equal(state.helpers.length,1);
  assert.ok(state.helpers[0].entries.length>200);
  for(const entry of state.helpers[0].entries.filter(row=>row.xdr))assert.equal(entry.last_modified,baseLedger+1);
});
test('unrelated RPC codes/messages and HTTP 404 fail immediately without recovery',async t=>{
  for(const options of [
    {error:method=>method==='getLedgerEntries'?{...transient,code:-32602}:null},
    {error:method=>method==='getLedgerEntries'?{...transient,message:'another server failure (404)'}:null},
    {httpFailure:true},
  ]){
    const {state,run}=scenario(t,options);await assert.rejects(run(),/RPC/);
    assert.equal(state.delays.length,0);assert.equal(state.helpers.length,0);t.mock.restoreAll();
  }
});
test('the same error from simulation or ledger-header RPC is not treated as a snapshot-read failure',async t=>{
  for(const method of ['simulateTransaction','getLedgers']){
    const {state,run}=scenario(t,{error:requestMethod=>requestMethod===method?transient:null});
    await assert.rejects(run(),new RegExp(`RPC ${method} failed`));
    assert.equal(state.simulations,1);assert.equal(state.delays.length,0);assert.equal(state.helpers.length,0);t.mock.restoreAll();
  }
});
test('malformed ledger rows, header disagreement and native parity disagreement still fail closed',async t=>{
  for(const options of [{malformed:true},{headerMismatch:true},{parityMismatch:true}]){
    const {state,run}=scenario(t,options);await assert.rejects(run());
    assert.equal(state.simulations,1);assert.equal(state.delays.length,0);t.mock.restoreAll();
  }
});
test('ledger drift still recaptures, and transient failures do not bypass the fresh-ledger guard',async t=>{
  const {state,run,baseLedger}=scenario(t,{driftFirst:true,error:(method,s)=>method==='getLedgerEntries'&&s.reads===2?transient:null});
  const result=await run();assert.equal(result.provenance.ledger,baseLedger+2);
  assert.equal(state.simulations,3);assert.equal(state.helpers.length,1);
});
test('transient errors cannot extend the existing 30-capture budget',async t=>{
  const {state,run}=scenario(t,{driftReads:Array.from({length:29},(_,i)=>i+1),
    error:(method,s)=>method==='getLedgerEntries'&&s.reads===30?transient:null});
  await assert.rejects(run(),/retry limit exhausted/);assert.equal(state.simulations,30);
  assert.equal(state.helpers.length,0);assert.equal(state.delays.length,0);
});
test('recovery does not permit a subsequent native/RPC parity disagreement',async t=>{
  const {state,run}=scenario(t,{parityMismatch:true,
    error:(method,s)=>method==='getLedgerEntries'&&s.reads===1?transient:null});
  await assert.rejects(run(),/Local simulation disagrees with RPC/);
  assert.equal(state.simulations,2);assert.equal(state.helpers.length,1);
});

test('repeated ledger drift exhausts attempt budget and reports drift counters and last cause', async t => {
  const { state, run } = scenario(t, { driftReads: Array.from({ length: 30 }, (_, i) => i + 1) });
  await assert.rejects(run(), (err) => {
    assert.match(err.message, /Unable to capture a complete consistent snapshot after 30 attempts/);
    assert.match(err.message, /last cause: ledger_drift/);
    assert.match(err.message, /ledger_drift: 30/);
    assert.equal(err.diagnostics?.lastCause, 'ledger_drift');
    assert.equal(err.diagnostics?.causes.ledger_drift, 30);
    return true;
  });
  assert.equal(state.simulations, 30);
  assert.equal(state.helpers.length, 0);
});

test('batch ledger disagreement tracks batch mismatch and reports on exhaustion', async t => {
  const { state, run } = scenario(t, { multibatch: true, driftReads: Array.from({ length: 30 }, (_, i) => (i + 1) * 2) });
  await assert.rejects(run(), (err) => {
    assert.match(err.message, /Unable to capture a complete consistent snapshot after 30 attempts/);
    assert.match(err.message, /last cause: batch_ledger_disagreement/);
    assert.equal(err.diagnostics?.lastCause, 'batch_ledger_disagreement');
    assert.equal(err.diagnostics?.causes.batch_ledger_disagreement, 30);
    return true;
  });
  assert.equal(state.simulations, 30);
});

test('repeated uncaptured keys exhaust attempt budget and report newly discovered keys', async t => {
  const { state, run } = scenario(t, { uncapturedKeys: true });
  await assert.rejects(run(), (err) => {
    assert.match(err.message, /Unable to capture a complete consistent snapshot after 30 attempts/);
    assert.match(err.message, /last cause: newly_discovered_keys/);
    assert.equal(err.diagnostics?.lastCause, 'newly_discovered_keys');
    assert.equal(err.diagnostics?.causes.newly_discovered_keys, 30);
    assert.ok(err.diagnostics?.discoveredKeysCount >= 30);
    return true;
  });
  assert.equal(state.simulations, 30);
  assert.equal(state.helpers.length, 30);
});

test('fatal helper failure fails immediately and does not retry 30 times', async t => {
  const { state, run } = scenario(t, { helperFailure: 'Fatal helper panic: unexpected assertion' });
  await assert.rejects(run(), /Fatal helper panic/);
  assert.equal(state.simulations, 1);
  assert.equal(state.helpers.length, 1);
});

test('parity error distinguishes isolated transaction-data disagreement', async t => {
  const { run } = scenario(t, { txDataMismatch: true });
  await assert.rejects(run(), (err) => {
    assert.match(err.message, /Local simulation disagrees with RPC/);
    assert.match(err.message, /transaction-data disagreement/);
    assert.doesNotMatch(err.message, /return-value disagreement/);
    assert.doesNotMatch(err.message, /ordered charged-event disagreement/);
    assert.equal(err.parityDetails?.transactionData, true);
    assert.equal(err.parityDetails?.returnValue, false);
    assert.equal(err.parityDetails?.contractEvents, false);
    return true;
  });
});

test('parity error distinguishes isolated return-value disagreement', async t => {
  const { run } = scenario(t, { retvalMismatch: true });
  await assert.rejects(run(), (err) => {
    assert.match(err.message, /Local simulation disagrees with RPC/);
    assert.match(err.message, /return-value disagreement/);
    assert.doesNotMatch(err.message, /transaction-data disagreement/);
    assert.doesNotMatch(err.message, /ordered charged-event disagreement/);
    assert.equal(err.parityDetails?.returnValue, true);
    assert.equal(err.parityDetails?.transactionData, false);
    assert.equal(err.parityDetails?.contractEvents, false);
    return true;
  });
});

test('parity error distinguishes isolated ordered charged-event disagreement', async t => {
  const { run } = scenario(t, { eventsMismatch: true });
  await assert.rejects(run(), (err) => {
    assert.match(err.message, /Local simulation disagrees with RPC/);
    assert.match(err.message, /ordered charged-event disagreement/);
    assert.doesNotMatch(err.message, /transaction-data disagreement/);
    assert.doesNotMatch(err.message, /return-value disagreement/);
    assert.equal(err.parityDetails?.contractEvents, true);
    assert.equal(err.parityDetails?.transactionData, false);
    assert.equal(err.parityDetails?.returnValue, false);
    return true;
  });
});

test('parity error distinguishes combined disagreement with all three components', async t => {
  const { run } = scenario(t, { txDataMismatch: true, retvalMismatch: true, eventsMismatch: true });
  await assert.rejects(run(), (err) => {
    assert.match(err.message, /Local simulation disagrees with RPC/);
    assert.match(err.message, /transaction-data disagreement/);
    assert.match(err.message, /return-value disagreement/);
    assert.match(err.message, /ordered charged-event disagreement/);
    assert.equal(err.parityDetails?.transactionData, true);
    assert.equal(err.parityDetails?.returnValue, true);
    assert.equal(err.parityDetails?.contractEvents, true);
    return true;
  });
});

test('diagnostic events and failed-call events are excluded from charged event parity checks', async t => {
  const diagEvent = new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
        topics: [xdr.ScVal.scvSymbol('diag')],
        data: xdr.ScVal.scvVoid(),
      })),
    }),
  });
  const failedCallEvent = new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
        topics: [xdr.ScVal.scvSymbol('failed')],
        data: xdr.ScVal.scvVoid(),
      })),
    }),
  });
  const { run } = scenario(t, {
    extraRpcEvents: [diagEvent.toXDR('base64'), failedCallEvent.toXDR('base64')],
  });
  const result = await run();
  assert.ok(result);
  assert.equal(result.provenance.protocol, 28);
});

// Issue #123: Missing required configuration entries
test('missing single required configuration setting fails fast with setting name before helper execution', async t => {
  const { state, run } = scenario(t, { omitConfigs: ['configSettingStateArchival'] });
  await assert.rejects(
    run(),
    /Missing required configuration entries: \[configSettingStateArchival\]/,
  );
  assert.equal(state.helpers.length, 0);
  assert.equal(state.delays.length, 0);
  assert.equal(state.simulations, 1);
});

test('multiple missing required configuration settings report all missing names and do not retry as drift', async t => {
  const { state, run } = scenario(t, {
    omitConfigs: ['configSettingStateArchival', 'configSettingContractComputeV0'],
  });
  await assert.rejects(
    run(),
    /Missing required configuration entries: \[configSettingContractComputeV0, configSettingStateArchival\]/,
  );
  assert.equal(state.helpers.length, 0);
  assert.equal(state.delays.length, 0);
  assert.equal(state.simulations, 1);
});

// Issue #124: Reject ambiguous duplicate ledger headers
test('ambiguous duplicate ledger headers for the captured sequence are rejected before helper execution', async t => {
  const { state, run } = scenario(t, { duplicateHeaders: true });
  await assert.rejects(
    run(),
    /Ambiguous duplicate ledger headers returned for sequence/,
  );
  assert.equal(state.helpers.length, 0);
});

test('malformed ledger header history entry XDR fails explicitly before helper execution', async t => {
  const { state, run } = scenario(t, { malformedHeaderXdr: true });
  await assert.rejects(
    run(),
    /Malformed ledger header history entry XDR/,
  );
  assert.equal(state.helpers.length, 0);
});

test('unrelated valid page rows alongside the captured ledger header are accepted', async t => {
  const { state, run } = scenario(t, { extraPageHeaders: true });
  const result = await run();
  assert.ok(result);
  assert.equal(result.provenance.protocol, 28);
  assert.equal(state.helpers.length, 1);
});

// Issue #125: Bind transaction network identity
test('transaction prepared for another network is rejected before native measurement without metrics', async t => {
  const { state, run } = scenario(t, {
    txNetworkPassphrase: 'Test SDF Future Network ; October 2022',
  });
  await assert.rejects(
    run(),
    /Transaction network passphrase "Test SDF Future Network ; October 2022" does not match RPC network passphrase/,
  );
  assert.equal(state.helpers.length, 0);
  assert.equal(state.simulations, 0);
});

// Issue #126: Bind helper provenance to executable actually used
test('captureHelperIdentity reads and hashes valid files and rejects non-files or missing paths', t => {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `weighin-helper-test-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  const content = 'mock-executable-binary-contents-12345';
  fs.writeFileSync(tmpFile, content);
  t.after(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
  const actualHash = captureHelperIdentity(tmpFile);
  assert.equal(actualHash, expectedHash);

  assert.throws(
    () => captureHelperIdentity(path.join(tmpDir, 'nonexistent-helper-file-path-xyz')),
    /Failed to capture simulation helper identity/,
  );

  assert.throws(
    () => captureHelperIdentity(tmpDir),
    /is not a regular file/,
  );
});

test('helper executable modified during execution is rejected before emitting provenance', async t => {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `weighin-helper-mutate-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(tmpFile, 'initial-helper-bytes');
  t.after(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  const { state, run } = scenario(t, {
    helperPath: tmpFile,
    mutateHelperDuringExecution: true,
  });

  await assert.rejects(
    run(),
    /Simulation helper executable was modified during execution/,
  );
  assert.equal(state.helpers.length, 1);
});

test('helper executable modified across retry attempts is rejected before re-execution', async t => {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `weighin-helper-retry-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(tmpFile, 'initial-retry-helper-bytes');
  t.after(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  let mutated = false;
  const { state, run } = scenario(t, {
    helperPath: tmpFile,
    uncapturedKeys: true,
    error: (method, s) => {
      if (s.helpers.length === 1 && !mutated) {
        mutated = true;
        fs.appendFileSync(tmpFile, ' // mutated between attempt 1 and 2');
      }
      return null;
    },
  });

  await assert.rejects(
    run(),
    /Simulation helper executable was modified across attempts/,
  );
  assert.equal(state.helpers.length, 1);
});

test('helper executable modified before emitting provenance is rejected', async t => {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `weighin-helper-prov-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(tmpFile, 'initial-prov-helper-bytes');
  t.after(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  let readCount = 0;
  const originalReadFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, opts) => {
    if (p === tmpFile) {
      readCount++;
      if (readCount === 3) {
        return Buffer.from('tampered-bytes-before-provenance');
      }
    }
    return originalReadFileSync(p, opts);
  });

  const { state, run } = scenario(t, { helperPath: tmpFile });

  await assert.rejects(
    run(),
    /Simulation helper executable was modified before emitting provenance/,
  );
  assert.equal(state.helpers.length, 1);
});

test('unchanged helper executable records verified helper_sha256 in provenance', async t => {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `weighin-helper-clean-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  const content = 'clean-verified-helper-binary';
  fs.writeFileSync(tmpFile, content);
  t.after(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
  const { run } = scenario(t, { helperPath: tmpFile });
  const result = await run();

  assert.equal(result.provenance.helper_sha256, expectedHash);
});
