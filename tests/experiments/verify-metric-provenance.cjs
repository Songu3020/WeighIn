// Explicit live Stage 3 proof, excluded from npm test. All build, deployment,
// simulation and RPC work is real. Observers record bytes without substituting IO.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { rpc, Asset, Operation, Keypair, TransactionBuilder, xdr } = require('@stellar/stellar-sdk');
const repository = path.resolve(__dirname, '../..');
const destination = path.resolve(process.argv[2] || '/tmp/weighin-metric-proof');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-metrics-'));
const endpoint = process.env.WEIGHIN_EXPERIMENT_RPC_URL || 'http://localhost:18000/rpc';
const passphrase = 'Standalone Network ; February 2017';
const helper = path.join(repository, 'native/simulation/target/x86_64-unknown-linux-gnu/release/weighin-simulation');
fs.mkdirSync(destination, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(destination, name), JSON.stringify(data, null, 2) + '\n');
const captures = [], replays = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await fetchOriginal(...args);
  if (args[1]?.method === 'POST') {
    captures.push({ request: JSON.parse(args[1].body), raw: await response.clone().json() });
    write('rpc-captures.json', captures);
  }
  return response;
};
const execOriginal = cp.execFile;
cp.execFile = function(file, args, options, callback) {
  if (file !== helper) return execOriginal.apply(this, arguments);
  let input;
  const child = execOriginal(file, args, options, (error, stdout, stderr) => {
    replays.push({ input, output: error ? null : JSON.parse(stdout), error: error ? stderr : null });
    write('native-replays.json', replays);
    callback(error, stdout, stderr);
  });
  const end = child.stdin.end.bind(child.stdin);
  child.stdin.end = function(data, ...args) { input = JSON.parse(data); return end(data, ...args); };
  return child;
};
const { runMeasurement } = require('../../dist/measurement');
const { diffBenchmarks } = require('../../dist/diff');
const { enforceThresholds } = require('../../dist/threshold');
const { renderComment } = require('../../dist/comment');
async function command(file, args) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(file, args, { cwd: temporary, env: process.env }); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
  });
}
async function main() {
  const server = new rpc.Server(endpoint, { allowHttp: true });
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await server.getHealth()).status === 'healthy') break; } catch {}
    if (attempt === 59) throw new Error('RPC not healthy');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  fs.mkdirSync(path.join(temporary, 'src'));
  for (const [source, target] of [['contract/Cargo.toml','Cargo.toml'], ['contract/Cargo.lock','Cargo.lock'], ['rust-toolchain.toml','rust-toolchain.toml']]) {
    fs.copyFileSync(path.join(repository, source), path.join(temporary, target));
  }
  const source = `#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, vec, token, Address, Env, String, Vec};
#[contract] pub struct Audit;
#[contractimpl] impl Audit {
  pub fn __constructor(env: Env) { env.storage().persistent().set(&symbol_short!("bench"), &7u32); }
  pub fn bench(env: Env, mode: i32, token: String, owner: String) -> Vec<u32> {
    let key = symbol_short!("bench");
    match mode {
      0 => {
        assert_eq!(env.storage().persistent().get::<_,u32>(&key), Some(7));
        assert_eq!(env.storage().persistent().get::<_,u32>(&key), Some(7));
        assert!(!env.storage().persistent().has(&symbol_short!("missing")));
      },
      1 => env.storage().persistent().set(&key, &7u32),
      2 => env.storage().persistent().remove(&key),
      3 => { env.events().publish((symbol_short!("audit"),), 7u32); },
      4 => { assert!(token::Client::new(&env, &Address::from_string(&token)).balance(&Address::from_string(&owner)) > 0); },
      5 => { let mut out = Vec::new(&env); for i in 0..80 { out.push_back(i); } return out; },
      _ => panic!("unknown mode"),
    }
    vec![&env,7]
  }
}
`;
  fs.writeFileSync(path.join(temporary, 'src/lib.rs'), source);
  fs.writeFileSync(path.join(destination, 'contract.rs'), source);
  for (const file of ['Cargo.toml','Cargo.lock','rust-toolchain.toml']) fs.copyFileSync(path.join(temporary,file), path.join(destination,file));
  const build = await command('stellar', ['contract','build','--manifest-path',path.join(temporary,'Cargo.toml'),
    '--package','contract_test','--locked','--optimize=true','--out-dir',path.join(temporary,'wasm')]);
  write('build-process.json', build); assert.equal(build.status, 0, build.stderr);
  const wasm = path.join(temporary, 'wasm/contract_test.wasm'); fs.copyFileSync(wasm, path.join(destination,'contract.wasm'));
  // Genuine SAC deployment provides a positive classic Account disk-read case.
  // The account secret is used only inside the private temporary directory.
  const deployer = Keypair.random(), keyFile = path.join(temporary,'deployer.key');
  fs.writeFileSync(keyFile, deployer.secret(), { mode: 0o600 });
  assert.ok((await fetch(`${endpoint.replace(/\/rpc$/, '')}/friendbot?addr=${deployer.publicKey()}`)).ok);
  const account = await server.getAccount(deployer.publicKey());
  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: passphrase })
    .addOperation(Operation.createStellarAssetContract({ asset: Asset.native() })).setTimeout(30).build();
  const prepared = await server.prepareTransaction(tx); prepared.sign(deployer);
  const sent = await server.sendTransaction(prepared);
  for (let i = 0; i < 30; i++) {
    const status = await server.getTransaction(sent.hash);
    if (status.status !== 'NOT_FOUND') { assert.equal(status.status, 'SUCCESS', JSON.stringify(status)); break; }
    if (i === 29) throw new Error('SAC deployment timed out');
    await new Promise(resolve => setTimeout(resolve,1000));
  }
  const token = Asset.native().contractId(passphrase);
  const labels = ['read-missing-repeat', 'noop-write', 'delete', 'event', 'classic-read', 'large-return'];
  const fixture = { id: 'metric-audit', contracts: [{ id: 'audit', wasm_path: wasm,
    invocations: labels.map((id, mode) => ({ id, function_name: 'bench', args: [
      { type:'I32',value:mode }, { type:'String',value:token }, { type:'String',value:deployer.publicKey() },
    ] })) }] };
  const fixturesPath = path.join(temporary,'fixtures.json'); fs.writeFileSync(fixturesPath,JSON.stringify(fixture));
  // Persist a portable evidence fixture, without a temporary absolute WASM path.
  write('fixtures.json', { ...fixture, contracts: fixture.contracts.map(c => ({ ...c, wasm_path:'contract.wasm' })) });
  const base = await runMeasurement({ fixturesPath, keyFile, rpcUrl:endpoint, helperPath:helper, gitCommit:'isolated-audit-source',sdkVersion:'28.0.0' });
  write('measurements.json',base); assert.equal(base[0].schema_version,5);
  const benchmarks = Object.fromEntries(base[0].benchmarks.map(b => [b.case_id.replace(/^id:/,''), b]));
  // Raw-RPC check using the exact parity-accepted transaction and ledger.
  for (const benchmark of base[0].benchmarks) {
    const replay = replays.find(item => item.output && createHash('sha256').update(JSON.stringify(item.input)).digest('hex') === benchmark.provenance.input_sha256);
    assert.ok(replay, benchmark.case_id);
    const raw = captures.find(item => item.request.method === 'simulateTransaction'
      && item.raw.result?.latestLedger === benchmark.provenance.ledger
      && item.raw.result?.transactionData === replay.output.transaction_data_xdr
      && xdr.TransactionEnvelope.fromXDR(item.request.params.transaction,'base64').v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().toXDR('base64') === replay.input.host_function_xdr).raw.result;
    const resources = xdr.SorobanTransactionData.fromXDR(raw.transactionData,'base64').resources();
    const metrics = benchmark.metrics;
    assert.equal(metrics.ledger_read_entries.consumed,resources.footprint().readOnly().length + resources.footprint().readWrite().length);
    assert.equal(metrics.ledger_read_bytes.consumed,resources.diskReadBytes());
    assert.equal(metrics.ledger_write_entries.consumed,resources.footprint().readWrite().length);
    assert.equal(metrics.ledger_write_bytes.consumed,resources.writeBytes());
    const events = raw.events.map(e => xdr.DiagnosticEvent.fromXDR(e,'base64'))
      .filter(e => e.inSuccessfulContractCall() && e.event().type().name !== 'diagnostic');
    assert.equal(metrics.events_count.consumed,events.length);
    assert.equal(metrics.event_data_bytes.consumed,events.reduce((sum,e) => sum+e.event().toXDR().length,0)
      + xdr.ScVal.fromXDR(raw.results[0].xdr,'base64').toXDR().length);
  }
  const metric = (label,key) => benchmarks[label].metrics[key].consumed;
  assert.equal(metric('read-missing-repeat','ledger_read_bytes'),0);
  assert.equal(metric('read-missing-repeat','ledger_read_entries'),4); // code, instance, present key, absent key
  assert.equal(metric('noop-write','ledger_write_entries'),1);
  assert.ok(metric('noop-write','ledger_write_bytes')>0);
  assert.equal(metric('delete','ledger_write_entries'),1);
  assert.equal(metric('delete','ledger_write_bytes'),0);
  assert.ok(metric('classic-read','ledger_read_bytes')>0);
  assert.equal(metric('event','events_count'),1);
  assert.equal(metric('read-missing-repeat','events_count'),0);
  assert.ok(metric('large-return','event_data_bytes')>metric('read-missing-repeat','event_data_bytes'));
  const report = renderComment(diffBenchmarks(base,base),[], 'same-snapshot','same-snapshot');
  fs.writeFileSync(path.join(destination,'report.md'),report);
  write('verification.json',{ status:'LIVE_METRIC_PROVENANCE_PASS',real_build_rpc_deployment_native:true,
    observers_only_no_substituted_io:true, source_sdk:'28.0.0', measurement_schema:4,
    wasm_sha256:createHash('sha256').update(fs.readFileSync(wasm)).digest('hex'),
    raw_rpc_verified:['ledger_read_entries','ledger_read_bytes','ledger_write_entries','ledger_write_bytes','events_count','event_data_bytes'],
    cpu_memory_direct_rpc_consumption_available:false, limits_source:'same-ledger captured config entries',
    cases:Object.fromEntries(labels.map(label=>[label,Object.fromEntries(Object.entries(benchmarks[label].metrics).map(([k,m])=>[k,m.consumed]))])),
    state_mutations_are_simulated_only:true, public_github_ci_proven:false });
  console.log(fs.readFileSync(path.join(destination,'verification.json'),'utf8'));
}
main().catch(error=>{ console.error(error); process.exitCode=1; });
