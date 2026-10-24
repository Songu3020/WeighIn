// Explicit clean-checkout/package proof. No publication or repository modification.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..'),destination=path.resolve(process.argv[2]||'/tmp/weighin-clean-delivery-proof');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'weighin-clean-install-'));
const checkout=path.join(temporary,'checkout'),consumer=path.join(temporary,'consumer');
fs.mkdirSync(destination,{recursive:true});fs.mkdirSync(consumer);
const write=(name,data)=>fs.writeFileSync(path.join(destination,name),JSON.stringify(data,null,2)+'\n');
const hash=b=>createHash('sha256').update(b).digest('hex');
const env={...process.env,CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0'};
for(const key of ['WEIGHIN_HELPER_PATH','CARGO_TARGET_DIR','WEIGHIN_EXPERIMENT_CARGO_TARGET_DIR','RUSTFLAGS','CARGO_BUILD_RUSTFLAGS','NODE_OPTIONS'])delete env[key];
const records=[];
async function command(label,file,args,cwd=checkout,extra={},input){
  const result=await new Promise((resolve,reject)=>{const p=cp.spawn(file,args,{cwd,env:{...env,...extra}});let stdout='',stderr='';
    const heartbeat=setInterval(()=>console.log(`${label}: clean delivery command in progress`),30000);
    p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',e=>{clearInterval(heartbeat);reject(e);});
    p.on('close',status=>{clearInterval(heartbeat);resolve({status,stdout,stderr});});p.stdin.end(input);});
  write(label+'.json',result);records.push({label,file,args,status:result.status});write('commands.json',records);
  console.log(label,'exit',result.status);return result;
}
async function checked(...args){const r=await command(...args);assert.equal(r.status,0,r.stdout+r.stderr);return r;}
async function main(){
  write('locations.json',{temporary,checkout,consumer});
  await checked('clone','git',['clone','--no-hardlinks',root,checkout],temporary);
  const sha=(await checked('checkout-sha','git',['rev-parse','HEAD'])).stdout.trim();
  for(const f of ['node_modules','dist','native/simulation/target','contract/target'])assert.equal(fs.existsSync(path.join(checkout,f)),false,f+' must be absent');
  write('initial-state.json',{sha,dist:false,node_modules:false,native_target:false,contract_target:false,helper_override:false,shared_registry_cache:true});
  for(const [label,args] of [['ci',['ci']],['test',['test']],['native-tests',['run','test:native']],['build',['run','build']],['bundle',['run','bundle']]])await checked(label,'npm',args);
  await checked('bundle-consistency','git',['diff','--exit-code','--','bundled/index.js']);
  const packed=await checked('pack','npm',['pack','--json']);
  const metadata=JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')))[0];write('package-files.json',metadata);
  const names=metadata.files.map(f=>f.path);
  const required=['dist/cli.js','dist/measurement.js','dist/simulation.js','dist/account.js','bundled/index.js','action.yml',
    'native/simulation/Cargo.toml','native/simulation/Cargo.lock','native/simulation/src/main.rs'];
  for(const name of required)assert.ok(names.includes(name),'missing '+name);
  assert.ok(!names.some(f=>f.includes('/target/')||f.startsWith('tests/')||f.includes('.key')||f.includes('scratch')||f.includes('WEIGHIN_')));
  const tar=path.join(checkout,metadata.filename);fs.copyFileSync(tar,path.join(destination,metadata.filename));
  fs.writeFileSync(path.join(consumer,'package.json'),JSON.stringify({name:'weighin-local-install-proof',version:'0.0.0',private:true}));
  await checked('install-production','npm',['install','--omit=dev',tar],consumer);
  const pkg=path.join(consumer,'node_modules/weighin');assert.equal(fs.existsSync(path.join(pkg,'native/simulation/target')),false);
  assert.equal(fs.existsSync(path.join(consumer,'node_modules/typescript')),false);
  await checked('module-entry',process.execPath,['-e',"const assert=require('node:assert/strict'); assert.equal(typeof require('weighin').runMeasurement,'function'); console.log('Installed measurement API loads');"],consumer);
  const bin=path.join(consumer,'node_modules/.bin/weighin');
  const missing=await command('cli-missing-fixture',bin,[path.join(consumer,'missing.json'),'--output',path.join(consumer,'absent.json')],consumer);
  assert.equal(missing.status,1);assert.match(missing.stderr,/ENOENT/);assert.equal(fs.existsSync(path.join(consumer,'absent.json')),false);
  await checked('installed-helper-provision',process.execPath,['-e',"require('weighin/dist/simulation').resolveSimulationHelper().then(p=>console.log(p)).catch(e=>{console.error(e);process.exitCode=1})"],consumer);
  const helper=path.join(pkg,'native/simulation/target/x86_64-unknown-linux-gnu/release/weighin-simulation');assert.ok(fs.existsSync(helper));
  const frozen=JSON.parse(fs.readFileSync(path.join(checkout,'docs/experiments/network-readiness/live/run-1/action/native.json')))[0];
  const replay=await checked('installed-helper-replay',helper,[],consumer,{},JSON.stringify(frozen.input));assert.deepEqual(JSON.parse(replay.stdout),frozen.output);
  await checked('contract-build',process.execPath,['-e',"require('./dist/build').buildContracts('weighin-fixtures.json','.','1.95.0').catch(e=>{console.error(e);process.exitCode=1})"]);
  const present=await checked('existing-sidecar','docker',['ps','-a','-q','-f','name=^/stellar-quickstart$']);assert.equal(present.stdout.trim(),'','Refusing to replace existing sidecar');
  try{
    await checked('startup','bash',['scripts/start-local-network.sh']);
    const inspect=await checked('container-inspect','docker',['inspect','stellar-quickstart']);write('container.json',JSON.parse(inspect.stdout));
    const capture=path.join(destination,'installed-cli');fs.mkdirSync(capture);
    await checked('installed-cli-live',bin,['weighin-fixtures.json','--rpc-url','http://localhost:8000/rpc','--output',path.join(capture,'results.json')],checkout,
      {NODE_OPTIONS:'--require='+path.join(root,'tests/support/record-clean-delivery-io.cjs'),WEIGHIN_CLEAN_CAPTURE:capture});
    const results=JSON.parse(fs.readFileSync(path.join(capture,'results.json'))),native=JSON.parse(fs.readFileSync(path.join(capture,'native.json')));
    assert.equal(results.length,2);assert.equal(native.length,2);assert.ok(native.every(r=>r.file===helper));
    for(const c of results){assert.equal(c.schema_version,5);assert.equal(c.benchmarks[0].metrics.cpu_instructions.consumed,266842);}
    const migration=path.join(destination,'historical-migration');
    await checked('historical-migration',process.execPath,['tests/experiments/verify-fixture-migration.cjs',migration],checkout,
      {WEIGHIN_EXPERIMENT_RPC_URL:'http://localhost:8000/rpc',WEIGHIN_EXPERIMENT_CARGO_TARGET_DIR:path.join(checkout,'contract/target')});
    const proof=JSON.parse(fs.readFileSync(path.join(migration,'verification.json')));assert.equal(proof.historical_sha,'59db63a7b895dcc5ca763e3c668990fec40850fb');
    assert.equal(proof.status,'HISTORICAL_IDENTITY_MIGRATION_PASS');
  }finally{
    await command('network-logs','docker',['logs','--tail','100','stellar-quickstart']);await checked('network-stop','docker',['stop','stellar-quickstart']);
  }
  await checked('final-checkout-status','git',['status','--short']);
  write('verification.json',{status:'CLEAN_CHECKOUT_PACKAGE_PASS',source_sha:sha,checkout_gates:true,actual_tarball_install:true,
    production_dependencies_only:true,copied_native_binary:false,installed_helper_built_from_source:true,frozen_replay_matches:true,
    installed_cli_live:true,historical_four_scenarios:true,historical_sha:'59db63a7b895dcc5ca763e3c668990fec40850fb',
    tarball_sha256:hash(fs.readFileSync(tar)),bundle_sha256:hash(fs.readFileSync(path.join(checkout,'bundled/index.js'))),
    installed_helper_sha256:hash(fs.readFileSync(helper)),registry_cache_reused:true,clean_machine_claim:false,public_ci_proven:false});
}
main().catch(error=>{write('failure.json',{message:error.message,stack:error.stack});console.error(error.message);process.exitCode=1;});
