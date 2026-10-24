// Stage 4: five genuinely empty-target reference builds and live measurements.
// No RPC/build/helper responses are substituted. Raw IO observers only forward.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {rpc,Asset,Operation,Keypair,TransactionBuilder,Address,xdr}=require('@stellar/stellar-sdk');
const repository=path.resolve(__dirname,'../..');
const destination=path.resolve(process.argv[2]||'/tmp/weighin-repeatability-proof');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'weighin-repeatability-'));
const endpoint=process.env.WEIGHIN_EXPERIMENT_RPC_URL||'http://localhost:18000/rpc';
const helper=path.join(repository,'native/simulation/target/x86_64-unknown-linux-gnu/release/weighin-simulation');
const passphrase='Standalone Network ; February 2017';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(destination,{recursive:true});
const write=(name,value)=>fs.writeFileSync(path.join(destination,name),JSON.stringify(value,null,2)+'\n');
const inputNames=['contract/Cargo.toml','contract/Cargo.lock','contract/src/lib.rs','rust-toolchain.toml','weighin-fixtures.json'];
const inputs=Object.fromEntries(inputNames.map(file=>[file,fs.readFileSync(path.join(repository,file))]));
const sourceHashes=Object.fromEntries(inputNames.map(file=>[file,hash(inputs[file])]));
const sourceHash=hash(JSON.stringify(sourceHashes));
let label='setup',captures=[],replays=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async(...args)=>{
  const response=await originalFetch(...args);
  if(args[1]?.method==='POST'){
    captures.push({request:JSON.parse(args[1].body),raw:await response.clone().json()});
    write(`${label}-rpc.json`,captures);
  }
  return response;
};
const originalExec=cp.execFile;
cp.execFile=function(file,args,options,callback){
  if(file!==helper)return originalExec.apply(this,arguments);
  let input;
  const child=originalExec(file,args,options,(error,stdout,stderr)=>{
    replays.push({input,output:error?null:JSON.parse(stdout),error:error?stderr:null});
    write(`${label}-native.json`,replays);callback(error,stdout,stderr);
  });
  const end=child.stdin.end.bind(child.stdin);
  child.stdin.end=function(data,...rest){input=JSON.parse(data);return end(data,...rest);};return child;
};
const {buildContracts}=require('../../dist/build');
const {runMeasurement}=require('../../dist/measurement');
const {enforceThresholds}=require('../../dist/threshold');
const {renderComment}=require('../../dist/comment');
const {analyzeRepeatability}=require('./repeatability-analysis.cjs');
async function call(method){
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method})});
  const body=await response.json();if(body.error||!body.result)throw new Error(`RPC ${method} failed`);return body.result;
}
function version(tool,args){return cp.execFileSync(tool,args,{cwd:repository,encoding:'utf8'}).trim();}
function policy(records){return {thresholds:{global:{fail_on_any_regression:true},functions:Object.fromEntries(
  [...new Set(records.flatMap(c=>c.benchmarks.map(b=>b.function_name)))].map(name=>[name,
    {historical_data_read_bytes:'ignore',contract_data_hard_limit:'ignore',tx_size_bytes:'ignore'}]))}};}
async function main(){
  for(let attempt=0;attempt<60;attempt++){
    try{if((await call('getHealth')).status==='healthy')break;}catch{}
    if(attempt===59)throw new Error('RPC not healthy');await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const network=await call('getNetwork'),rpcVersion=await call('getVersionInfo');
  assert.equal(network.protocolVersion,28);assert.equal(network.passphrase,passphrase);
  const repositorySha=version('git',['rev-parse','HEAD']);
  const sourceDir=path.join(destination,'source');fs.mkdirSync(sourceDir,{recursive:true});
  for(const [file,bytes]of Object.entries(inputs)){
    const target=path.join(sourceDir,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
  }
  const explicitEnvironment={RUSTUP_TOOLCHAIN:'1.95.0',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_NET_OFFLINE:'true',
    RUSTC_WRAPPER:'',RUSTC_WORKSPACE_WRAPPER:'',CARGO_BUILD_RUSTC_WRAPPER:'',CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER:'',
    CARGO_BUILD_RUSTFLAGS:''};
  // Presence of RUSTFLAGS, even empty, disables Stellar CLI dependency remapping.
  delete process.env.RUSTFLAGS;delete process.env.CARGO_ENCODED_RUSTFLAGS;
  Object.assign(process.env,explicitEnvironment);
  const auditSource=path.join(repository,'docs/experiments/metric-provenance');
  const auditDir=path.join(temporary,'audit');fs.mkdirSync(auditDir);
  fs.copyFileSync(path.join(auditSource,'contract.wasm'),path.join(auditDir,'contract.wasm'));
  const auditWasmHash=hash(fs.readFileSync(path.join(auditDir,'contract.wasm')));
  assert.equal(auditWasmHash,JSON.parse(fs.readFileSync(path.join(auditSource,'verification.json'))).wasm_sha256);
  const environment={repository_sha:repositorySha,branch:version('git',['branch','--show-current']),
    initial_git_status:version('git',['status','--short']),source_files_sha256:sourceHashes,source_snapshot_sha256:sourceHash,
    source_is_uncommitted_worktree_snapshot:true,node:process.version,npm:version('npm',['--version']),
    rust:version('rustc',['--version']),stellar:version('stellar',['--version']),
    sdk:'28.0.0',js_sdk:JSON.parse(fs.readFileSync(path.join(repository,'node_modules/@stellar/stellar-sdk/package.json'))).version,
    helper_sha256:hash(fs.readFileSync(helper)),
    helper_source_version:'28.0.1',network,rpc_version:rpcVersion,explicit_build_environment:explicitEnvironment,
    unset_build_environment:['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS'],
    downloaded_dependency_sources_cached:true,compiled_reference_artifacts_reused:false,
    native_helper_built_once_and_reused:true,audit_wasm_prebuilt:true,audit_wasm_sha256:auditWasmHash,
    actual_network_reset_between_runs:false,invocation_writes_submitted:false,
    io_observers_only_no_substitution:true,public_ci_proven:false};
  write('environment.json',environment);
  // Fund one source/owner account and create the native SAC once; all runs reuse
  // its public identity. Its private seed stays in the temporary directory.
  const deployer=Keypair.random(),keyFile=path.join(temporary,'deployer.key');
  fs.writeFileSync(keyFile,deployer.secret(),{mode:0o600});
  const fundingAttempts=[];
  for(let attempt=0;attempt<10;attempt++){
    const response=await fetch(`${endpoint.replace(/\/rpc$/,'')}/friendbot?addr=${deployer.publicKey()}`,
      {signal:AbortSignal.timeout(15000)});
    fundingAttempts.push({attempt:attempt+1,status:response.status,body:await response.text()});
    write('funding-attempts.json',fundingAttempts);
    if(response.ok)break;
    if(![429,500,502,503,504].includes(response.status)||attempt===9)throw new Error(`Friendbot funding failed: HTTP ${response.status}`);
    console.log(`Friendbot not ready (HTTP ${response.status}); waiting before any benchmark samples`);
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const server=new rpc.Server(endpoint,{allowHttp:true});
  const assetId=Asset.native().contractId(passphrase);
  const instance=xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract:Address.fromString(assetId).toScAddress(),key:xdr.ScVal.scvLedgerKeyContractInstance(),
    durability:xdr.ContractDataDurability.persistent()}));
  const existing=(await server.getLedgerEntries(instance)).entries.length>0;
  environment.stellar_asset_contract_preexisting=existing;write('environment.json',environment);
  if(!existing){
  const account=await server.getAccount(deployer.publicKey());
  const tx=new TransactionBuilder(account,{fee:'1000000',networkPassphrase:passphrase})
    .addOperation(Operation.createStellarAssetContract({asset:Asset.native()})).setTimeout(30).build();
  const prepared=await server.prepareTransaction(tx);prepared.sign(deployer);
  const sent=await server.sendTransaction(prepared);
  for(let i=0;i<30;i++){
    const result=await server.getTransaction(sent.hash);
    if(result.status!=='NOT_FOUND'){assert.equal(result.status,'SUCCESS',JSON.stringify(result));break;}
    if(i===29)throw new Error('SAC deployment timed out');await new Promise(resolve=>setTimeout(resolve,1000));
  }
  }
  const auditFixture=JSON.parse(fs.readFileSync(path.join(auditSource,'fixtures.json')));
  for(const invocation of auditFixture.contracts[0].invocations){
    invocation.args[1].value=Asset.native().contractId(passphrase);invocation.args[2].value=deployer.publicKey();
  }
  fs.writeFileSync(path.join(auditDir,'fixtures.json'),JSON.stringify(auditFixture,null,2)+'\n');
  write('audit-fixtures.json',auditFixture);fs.copyFileSync(path.join(auditDir,'contract.wasm'),path.join(destination,'audit.wasm'));
  const measure=(fixturesPath)=>runMeasurement({fixturesPath,fixtureId:path.basename(fixturesPath),keyFile,rpcUrl:endpoint,
    helperPath:helper,gitCommit:repositorySha,sdkVersion:'28.0.0'});
  // Warm-up/deployment is recorded separately and excluded from all five samples.
  await measure(path.join(auditDir,'fixtures.json'));
  const runs=[];
  for(let run=1;run<=5;run++){
    label=`run-${run}`;captures=[];replays=[];
    const runDir=path.join(temporary,label);fs.mkdirSync(runDir);
    for(const [file,bytes]of Object.entries(inputs)){
      const target=path.join(runDir,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
      assert.equal(hash(fs.readFileSync(target)),sourceHashes[file]);
    }
    const cargoTarget=path.join(runDir,'cold-cargo-target');fs.mkdirSync(cargoTarget);
    assert.deepEqual(fs.readdirSync(cargoTarget),[]);
    process.env.CARGO_TARGET_DIR=cargoTarget;
    const start=Date.now();console.log(`Run ${run}/5: clean reference build; empty Cargo target ${cargoTarget}`);
    const heartbeat=setInterval(()=>console.log(`Run ${run}/5: clean build in progress (${Math.round((Date.now()-start)/1000)} seconds)`),30000);
    let build;
    try{[build]=await buildContracts(path.join(runDir,'weighin-fixtures.json'),runDir,'1.95.0');}finally{clearInterval(heartbeat);}
    const buildDuration=Date.now()-start;
    const reference=await measure(path.join(runDir,'weighin-fixtures.json'));
    const audit=await measure(path.join(auditDir,'fixtures.json'));
    const captured={run,source_snapshot_sha256:sourceHash,reference_build:{...build,
      compiled_cache_initial_entries:0,target_directory_existed_at_start:true,cargo_target_dir:cargoTarget,
      build_duration_ms:buildDuration,compiled_cache_entries_after_build:fs.readdirSync(cargoTarget)},
      reference_measurements:reference,audit_measurements:audit};
    runs.push(captured);write('runs.json',runs);
    fs.copyFileSync(build.wasm_path,path.join(destination,`${label}-reference.wasm`));
    const caseCount=[...reference,...audit].reduce((count,contract)=>count+contract.benchmarks.length,0);
    console.log(`Run ${run}/5 complete: WASM ${build.wasm_sha256}; CPU ${reference[0].benchmarks[0].metrics.cpu_instructions.consumed}; ${caseCount} live cases captured`);
    // Remove only this experiment's compiled cache to bound /tmp usage. Source,
    // WASM, RPC and native evidence are preserved independently above.
    fs.rmSync(cargoTarget,{recursive:true,force:true});
  }
  for(const [file,bytes]of Object.entries(inputs))assert.equal(hash(fs.readFileSync(path.join(repository,file))),hash(bytes),'Repository input changed during experiment');
  const analysis=analyzeRepeatability(runs);write('analysis.json',analysis);
  const policies={reference:policy(runs[0].reference_measurements),audit:policy(runs[0].audit_measurements)};
  write('policies.json',policies);
  const violations={reference:analysis.reference.diffs.map(d=>enforceThresholds(d,policies.reference)),
    audit:analysis.audit.diffs.map(d=>enforceThresholds(d,policies.audit))};write('violations.json',violations);
  const csv=['run,group,case,wasm_sha256,ledger,cpu,memory,footprint_entries,disk_read_bytes,write_entries,write_bytes,events,events_and_return_bytes'];
  const keys=['cpu_instructions','memory_bytes','ledger_read_entries','ledger_read_bytes','ledger_write_entries','ledger_write_bytes','events_count','event_data_bytes'];
  const csvField=value=>{const text=String(value);return /[,"\n\r]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;};
  for(const run of runs)for(const [group,records]of [['reference',run.reference_measurements],['audit',run.audit_measurements]])
    for(const contract of records)for(const benchmark of contract.benchmarks)csv.push([run.run,group,benchmark.case_id,benchmark.wasm_sha256,
      benchmark.provenance.ledger,...keys.map(k=>benchmark.metrics[k].consumed)].map(csvField).join(','));
  fs.writeFileSync(path.join(destination,'metrics.csv'),csv.join('\n')+'\n');
  fs.writeFileSync(path.join(destination,'reference-report.md'),renderComment(analysis.reference.diffs.at(-1),violations.reference.at(-1),'live-run-1','live-run-5'));
  fs.writeFileSync(path.join(destination,'audit-report.md'),renderComment(analysis.audit.diffs.at(-1),violations.audit.at(-1),'live-run-1','live-run-5'));
  write('verification.json',{status:analysis.status,completed_clean_reference_builds:5,live_samples_per_case:5,
    cases_per_sample:[...runs[0].reference_measurements,...runs[0].audit_measurements].reduce((count,contract)=>count+contract.benchmarks.length,0),
    source_snapshot_sha256:sourceHash,clean_targets_verified_empty:true,
    compiled_reference_cache_reused:false,audit_wasm_reused:true,reference_wasm_stable:analysis.reference.wasm_stable,
    reference_metrics_stable:analysis.reference.metrics_stable,audit_metrics_stable:analysis.audit.metrics_stable,
    supported_metric_policy_violations:Object.values(violations).flat(2).length,
    unsupported_metrics_ignored_explicitly:['historical_data_read_bytes','contract_data_hard_limit','tx_size_bytes'],
    real_builds_network_deployment_and_native_simulation:true,public_ci_proven:false,cross_machine_determinism_proven:false});
  console.log(JSON.stringify({status:analysis.status,runs:5,reference_metrics_stable:analysis.reference.metrics_stable,
    audit_metrics_stable:analysis.audit.metrics_stable},null,2));
  if(analysis.status!=='SCOPED_REPEATABILITY_PASS')process.exitCode=1;
}
main().catch(error=>{write('failure.json',{message:error.message,stack:error.stack});console.error(error);process.exitCode=1;});
