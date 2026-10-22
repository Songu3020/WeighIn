// Explicit live proof for issue #233: cross-contract resource attribution on a
// real nested caller/callee host invocation. Excluded from npm test. Builds the
// deterministic fixture workspace with the official Stellar CLI, deploys callee
// and caller through the production measurement path, measures one nested
// invocation (caller -> callee inside a single host function), and verifies the
// combined footprint, event and return attribution against the parity-accepted
// raw RPC response and the native helper replay. Also records an archive
// control, a callee-only regression, an address-swapped control, and
// application/invalid-input/infrastructure failure probes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { rpc, StrKey, xdr } = require('@stellar/stellar-sdk');

const repository = path.resolve(__dirname, '../..');
const destination = path.resolve(process.argv[2] || '/tmp/weighin-nested-proof');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-nested-'));
const endpoint = process.env.WEIGHIN_EXPERIMENT_RPC_URL || 'http://localhost:8000/rpc';
const passphrase = 'Standalone Network ; February 2017';
const helper = path.join(repository, 'native/simulation/target/x86_64-unknown-linux-gnu/release/weighin-simulation');
const fixtureTemplate = path.join(repository, 'tests/fixtures/nested-invocation');
fs.mkdirSync(destination, { recursive: true });
// Every command below runs with cwd=temporary, so the pinned toolchain file
// must be discoverable there: rustup resolves rust-toolchain.toml from the
// working directory upward, and a silent default-toolchain fallback would
// change the compiled WASM bytes and break identity stability.
fs.copyFileSync(path.join(repository, 'rust-toolchain.toml'), path.join(temporary, 'rust-toolchain.toml'));

const write = (name, data) => fs.writeFileSync(path.join(destination, name), JSON.stringify(data, null, 2) + '\n');
const sha256 = value => createHash('sha256').update(value).digest('hex');

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

function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(file, args, { cwd: temporary, env: process.env, ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

const regressionCalleeSource = `#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env};

#[contract]
pub struct NestedCallee;

/// Callee-only regression for the nested proof: identical interface and event,
/// one additional persistent audit write per round.
#[contractimpl]
impl NestedCallee {
    pub fn work(env: Env, rounds: u32) -> u32 {
        let key = symbol_short!("counter");
        let audit = symbol_short!("audit");
        let mut value: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        for _ in 0..rounds {
            value += 1;
            env.storage().persistent().set(&key, &value);
            env.storage().persistent().set(&audit, &value);
        }
        env.events().publish((symbol_short!("work"),), value);
        value
    }

    pub fn boom(_env: Env) -> u32 {
        panic!("nested callee failure")
    }
}
`;

function materializeFixture(templateName, substitutions, outName) {
  const raw = fs.readFileSync(path.join(fixtureTemplate, templateName), 'utf8');
  let materialized = raw;
  for (const [token, value] of Object.entries(substitutions)) {
    assert.ok(materialized.includes(token), token);
    materialized = materialized.split(token).join(value);
  }
  const outPath = path.join(temporary, outName);
  fs.writeFileSync(outPath, materialized);
  return { path: outPath, spec: JSON.parse(materialized) };
}

async function buildWorkspace(label, overrideCalleeSource) {
  const dir = path.join(temporary, `build-${label}`);
  copyTree(fixtureTemplate, dir);
  fs.rmSync(path.join(dir, 'callee-fixtures.json'));
  fs.rmSync(path.join(dir, 'caller-fixtures.json'));
  fs.rmSync(path.join(dir, 'caller-failure-fixtures.json'));
  fs.copyFileSync(path.join(repository, 'rust-toolchain.toml'), path.join(dir, 'rust-toolchain.toml'));
  if (overrideCalleeSource) fs.writeFileSync(path.join(dir, 'callee/src/lib.rs'), overrideCalleeSource);
  const build = await command('stellar', ['contract', 'build', '--manifest-path', path.join(dir, 'Cargo.toml'),
    '--locked', '--optimize=true', '--out-dir', path.join(dir, 'wasm')]);
  write(`build-${label}-process.json`, build);
  assert.equal(build.status, 0, build.stderr);
  const calleeWasm = path.join(dir, 'wasm/nested_callee.wasm');
  const callerWasm = path.join(dir, 'wasm/nested_caller.wasm');
  assert.ok(fs.existsSync(calleeWasm) && fs.existsSync(callerWasm), 'workspace wasm outputs');
  return {
    dir,
    calleeWasm,
    callerWasm,
    calleeSha256: sha256(fs.readFileSync(calleeWasm)),
    callerSha256: sha256(fs.readFileSync(callerWasm)),
    calleeSource: fs.readFileSync(path.join(dir, 'callee/src/lib.rs'), 'utf8'),
    callerSource: fs.readFileSync(path.join(dir, 'caller/src/lib.rs'), 'utf8'),
  };
}

function contractAddressOf(scAddress) {
  if (scAddress.switch().name !== 'scAddressTypeContract') throw new Error(`unexpected ScAddress ${scAddress.switch().name}`);
  return StrKey.encodeContract(scAddress.contractId());
}

function classifyFootprint(output) {
  const keys = [...output.read_only_keys, ...output.read_write_keys].map(base64 => xdr.LedgerKey.fromXDR(base64, 'base64'));
  const readOnly = new Set(output.read_only_keys);
  const codeHashes = new Set(), instances = new Set(), storage = [];
  for (const key of keys) {
    if (key.switch().name === 'contractCode') {
      codeHashes.add(key.contractCode().hash().toString('hex'));
    } else if (key.switch().name === 'contractData') {
      const data = key.contractData();
      const contract = contractAddressOf(data.contract());
      if (data.key().switch().name === 'scvLedgerKeyContractInstance') instances.add(contract);
      else storage.push({
        contract,
        key_type: data.key().switch().name,
        key_name: data.key().switch().name === 'scvSymbol' ? data.key().sym().toString() : '',
        key_xdr: data.key().toXDR('base64'),
        durability: data.durability().name,
        read_write: !readOnly.has(key.toXDR('base64')),
      });
    } else {
      throw new Error(`unexpected footprint key ${key.switch().name}`);
    }
  }
  return { keys: keys.map(key => key.toXDR('base64')), codeHashes, instances, storage };
}

function chargedEvents(output) {
  return output.contract_events_xdr.map(base64 => xdr.ContractEvent.fromXDR(base64, 'base64'));
}

async function measure(label, build, keyFile, calleeAddress) {
  const buildDir = path.basename(build.dir);
  const callee = materializeFixture('callee-fixtures.json', { '{{NESTED_BUILD_DIR}}': buildDir }, `callee-${label}.json`);
  const calleeRecords = await runMeasurement({
    fixturesPath: callee.path, keyFile, rpcUrl: endpoint, helperPath: helper,
    gitCommit: `nested-${label}`, sdkVersion: '28.0.0',
  });
  const address = calleeAddress || calleeRecords[0].contract_id;
  const caller = materializeFixture('caller-fixtures.json', { '{{NESTED_BUILD_DIR}}': buildDir, '{{NESTED_CALLEE_ADDRESS}}': address }, `caller-${label}.json`);
  const callerRecords = await runMeasurement({
    fixturesPath: caller.path, keyFile, rpcUrl: endpoint, helperPath: helper,
    gitCommit: `nested-${label}`, sdkVersion: '28.0.0',
  });
  write(`fixtures-${label}.json`, {
    callee: callee.spec,
    caller: { ...caller.spec, contracts: caller.spec.contracts.map(contract => ({ ...contract, invocations: contract.invocations.map(invocation => ({ ...invocation, args: invocation.args.map(arg => arg.value === address ? { ...arg, resolved_from: 'deployed callee runtime address' } : arg) })) })) },
  });
  return { callee: calleeRecords, caller: callerRecords, calleeAddress: address, callerFixturesRaw: caller.spec };
}

function replayFor(benchmark) {
  const replay = replays.find(item => item.output && sha256(JSON.stringify(item.input)) === benchmark.provenance.input_sha256);
  assert.ok(replay, `native replay for ${benchmark.case_id}`);
  return replay;
}

function rawSimulationFor(benchmark, replay) {
  const capture = captures.find(item => item.request.method === 'simulateTransaction'
    && item.raw.result?.latestLedger === benchmark.provenance.ledger
    && item.raw.result?.transactionData === replay.output.transaction_data_xdr
    && xdr.TransactionEnvelope.fromXDR(item.request.params.transaction, 'base64').v1().tx().operations()[0]
      .body().invokeHostFunctionOp().hostFunction().toXDR('base64') === replay.input.host_function_xdr);
  assert.ok(capture, `raw RPC simulation for ${benchmark.case_id}`);
  return capture.raw.result;
}

function assertPromotedMetricsMatchRpc(benchmark, raw) {
  const resources = xdr.SorobanTransactionData.fromXDR(raw.transactionData, 'base64').resources();
  const m = benchmark.metrics;
  assert.equal(m.ledger_read_entries.consumed, resources.footprint().readOnly().length + resources.footprint().readWrite().length);
  assert.equal(m.ledger_read_bytes.consumed, resources.diskReadBytes());
  assert.equal(m.ledger_write_entries.consumed, resources.footprint().readWrite().length);
  assert.equal(m.ledger_write_bytes.consumed, resources.writeBytes());
  const events = raw.events.map(e => xdr.DiagnosticEvent.fromXDR(e, 'base64'))
    .filter(e => e.inSuccessfulContractCall() && e.event().type().name !== 'diagnostic');
  assert.equal(m.events_count.consumed, events.length);
  assert.equal(m.event_data_bytes.consumed, events.reduce((sum, e) => sum + e.event().toXDR().length, 0)
    + xdr.ScVal.fromXDR(raw.results[0].xdr, 'base64').toXDR().length);
}

async function main() {
  const server = new rpc.Server(endpoint, { allowHttp: true });
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await server.getHealth()).status === 'healthy') break; } catch {}
    if (attempt === 119) throw new Error('RPC not healthy');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const network = await server.getNetwork();
  assert.equal(network.passphrase, passphrase);
  assert.equal(network.protocolVersion, 28);

  // Fail fast if rustup would not resolve the pinned toolchain from this
  // script's working directory; an unpinned default toolchain recompiles
  // different WASM bytes and invalidates identity stability.
  const activeRustc = (await command('rustc', ['--version'])).stdout.trim();
  assert.match(activeRustc, /rustc 1\.95\.0/, activeRustc);

  const base = await buildWorkspace('base');
  const head = await buildWorkspace('head', regressionCalleeSource);
  fs.writeFileSync(path.join(destination, 'callee.rs'), base.calleeSource);
  fs.writeFileSync(path.join(destination, 'caller.rs'), base.callerSource);
  fs.writeFileSync(path.join(destination, 'callee-regression.rs'), head.calleeSource);
  fs.copyFileSync(base.calleeWasm, path.join(destination, 'nested-callee.wasm'));
  fs.copyFileSync(base.callerWasm, path.join(destination, 'nested-caller.wasm'));
  fs.copyFileSync(head.calleeWasm, path.join(destination, 'nested-callee-regression.wasm'));
  assert.notEqual(base.calleeSha256, head.calleeSha256, 'callee-only regression changes only the callee wasm');
  assert.equal(base.callerSha256, head.callerSha256, 'caller wasm is unchanged by the callee regression');
  for (const file of ['Cargo.toml', 'Cargo.lock', 'callee/Cargo.toml', 'callee/src/lib.rs', 'caller/Cargo.toml', 'caller/src/lib.rs']) {
    fs.mkdirSync(path.join(destination, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(base.dir, file), path.join(destination, file));
  }

  const keyA = path.join(temporary, 'deployer-a.key');
  const keyB = path.join(temporary, 'deployer-b.key');
  const control = await measure('base', base, keyA);
  const addressSwap = await measure('control', base, keyB);
  const regression = await measure('head', head, keyA, null);

  write('measurements.json', { base: control.callee.concat(control.caller), control: addressSwap.callee.concat(addressSwap.caller), head: regression.callee.concat(regression.caller) });
  const records = JSON.parse(fs.readFileSync(path.join(destination, 'measurements.json'), 'utf8'));

  const nested = records.base.find(r => r.logical_id === 'id:caller').benchmarks.find(b => b.case_id === 'id:nested-work');
  const calleeAlone = records.base.find(r => r.logical_id === 'id:callee').benchmarks.find(b => b.case_id === 'id:work-once');
  const nestedReplay = replayFor(nested), calleeReplay = replayFor(calleeAlone);
  const nestedRaw = rawSimulationFor(nested, nestedReplay), calleeRaw = rawSimulationFor(calleeAlone, calleeReplay);
  assertPromotedMetricsMatchRpc(nested, nestedRaw);
  assertPromotedMetricsMatchRpc(calleeAlone, calleeRaw);

  const nestedFootprint = classifyFootprint(nestedReplay.output);
  const calleeFootprint = classifyFootprint(calleeReplay.output);
  const callerContract = records.base.find(r => r.logical_id === 'id:caller').contract_id;
  const calleeContract = control.calleeAddress;

  // Combined footprint: the nested transaction footprint is exactly the callee
  // footprint plus the caller's code, instance and single storage key.
  assert.ok(nestedFootprint.codeHashes.has(base.calleeSha256), 'callee code in nested footprint');
  assert.ok(nestedFootprint.codeHashes.has(base.callerSha256), 'caller code in nested footprint');
  assert.ok(nestedFootprint.instances.has(calleeContract), 'callee instance in nested footprint');
  assert.ok(nestedFootprint.instances.has(callerContract), 'caller instance in nested footprint');
  for (const key of calleeFootprint.keys) assert.ok(nestedFootprint.keys.includes(key), 'callee footprint key reused in nested footprint');
  const extraKeys = nestedFootprint.keys.filter(key => !calleeFootprint.keys.includes(key));
  assert.equal(extraKeys.length, 3, 'caller contributes exactly code, instance and one storage key');
  const extraStorage = nestedFootprint.storage.filter(entry => entry.read_write && !calleeFootprint.storage.some(callee => callee.contract === entry.contract && callee.key_name === entry.key_name));
  assert.equal(extraStorage.length, 1);
  assert.equal(extraStorage[0].contract, callerContract);
  assert.equal(extraStorage[0].key_name, 'last');
  assert.ok(nestedFootprint.storage.some(entry => entry.contract === calleeContract && entry.key_name === 'counter' && entry.read_write), 'callee storage remains writable in nested footprint');

  // Event and return attribution: both charged events belong to the nested
  // transaction, in callee-then-caller order, and the callee event is the same
  // charged ContractEvent the standalone callee measurement records.
  const nestedEvents = chargedEvents(nestedReplay.output);
  const calleeEvents = chargedEvents(calleeReplay.output);
  assert.equal(nestedEvents.length, 2);
  assert.equal(nestedEvents[0].toXDR('base64'), calleeEvents[0].toXDR('base64'), 'callee event preserved inside the nested transaction');
  assert.equal(StrKey.encodeContract(nestedEvents[0].contractId()), calleeContract);
  assert.equal(StrKey.encodeContract(nestedEvents[1].contractId()), callerContract);
  assert.equal(nested.metrics.events_count.consumed, 2);
  assert.equal(nested.metrics.events_count.limit, null);
  assert.match(nested.metrics.events_count.limit_reason, /no independent/);
  assert.equal(nested.metrics.event_data_bytes.consumed,
    nestedReplay.output.contract_events_xdr.reduce((sum, event) => sum + xdr.ContractEvent.fromXDR(event, 'base64').toXDR().length, 0)
    + xdr.ScVal.fromXDR(nestedReplay.output.retval_xdr, 'base64').toXDR().length);
  assert.equal(nested.metrics.ledger_read_bytes.consumed, 0);
  assert.equal(nested.metrics.ledger_read_bytes.availability, 'measured');
  for (const key of ['historical_data_read_bytes', 'contract_data_hard_limit', 'tx_size_bytes']) {
    assert.equal(nested.metrics[key].availability, 'unavailable');
    assert.equal(nested.metrics[key].consumed, null);
    assert.ok(nested.metrics[key].reason);
  }

  // Combined accounting is strictly larger than the callee alone.
  assert.ok(nested.metrics.cpu_instructions.consumed > calleeAlone.metrics.cpu_instructions.consumed);
  assert.ok(nested.metrics.ledger_read_entries.consumed > calleeAlone.metrics.ledger_read_entries.consumed);
  assert.equal(nested.metrics.ledger_write_entries.consumed, calleeAlone.metrics.ledger_write_entries.consumed + 1);
  assert.ok(nested.metrics.event_data_bytes.consumed > calleeAlone.metrics.event_data_bytes.consumed);

  // Address-swapped control: identical logical identities and metrics, runtime
  // addresses and invocation arguments differ.
  const controlDiff = diffBenchmarks(records.base, records.control);
  assert.equal(controlDiff.hasRegression, false);
  assert.equal(controlDiff.contracts.length, 2);
  for (const contract of controlDiff.contracts) {
    assert.notEqual(contract.base_contract_id, contract.head_contract_id, 'runtime addresses differ across deployers');
    for (const fn of contract.functions) {
      const comparable = fn.metrics.filter(m => m.availability === 'comparable');
      assert.equal(comparable.length, 8);
      assert.ok(comparable.every(m => m.delta === 0));
    }
  }
  const controlCallerFixtures = JSON.parse(fs.readFileSync(path.join(temporary, 'caller-control.json'), 'utf8'));
  const baseCallerFixtures = JSON.parse(fs.readFileSync(path.join(temporary, 'caller-base.json'), 'utf8'));
  assert.notEqual(
    baseCallerFixtures.contracts[0].invocations[0].args[0].value,
    controlCallerFixtures.contracts[0].invocations[0].args[0].value,
    'materialized callee address argument differs between deployers');
  write('control-diff.json', controlDiff);

  // Callee-only regression: caller wasm and runtime address are unchanged; the
  // nested invocation attributes the callee's extra resources to the measured
  // caller case, and the callee's own direct case regresses too.
  const headCaller = records.head.find(r => r.logical_id === 'id:caller');
  const headCallee = records.head.find(r => r.logical_id === 'id:callee');
  assert.equal(headCaller.contract_id, callerContract, 'caller runtime address is stable across the callee-only regression');
  assert.notEqual(headCallee.contract_id, calleeContract, 'callee runtime address follows its changed wasm');
  assert.equal(headCaller.benchmarks[0].wasm_sha256, nested.wasm_sha256);
  assert.notEqual(headCallee.benchmarks[0].wasm_sha256, calleeAlone.wasm_sha256);
  const regressionDiff = diffBenchmarks(records.base, records.head);
  assert.equal(regressionDiff.hasRegression, true);
  write('regression-diff.json', regressionDiff);
  const nestedCase = regressionDiff.contracts.find(c => c.logical_id === 'id:caller').functions[0].metrics;
  const calleeCase = regressionDiff.contracts.find(c => c.logical_id === 'id:callee').functions[0].metrics;
  assert.ok(nestedCase.find(m => m.key === 'cpu_instructions').delta > 0);
  assert.ok(nestedCase.find(m => m.key === 'ledger_write_bytes').delta > 0);
  assert.ok(calleeCase.find(m => m.key === 'cpu_instructions').delta > 0);
  const policy = { thresholds: { functions: {
    run: { cpu_instructions: 'strict_zero_tolerance' },
    work: { cpu_instructions: 'strict_zero_tolerance' },
  } } };
  const violations = enforceThresholds(regressionDiff, policy);
  assert.equal(violations.length, 2);
  assert.ok(violations.every(v => v.delta > 0));
  write('violations.json', violations);
  fs.writeFileSync(path.join(destination, 'report.md'), renderComment(regressionDiff, violations, 'nested-base', 'nested-head'));

  // Failure probes: application failure, invalid input, infrastructure failure
  // and the archived-state control are recorded with their exact diagnostics.
  const failureSpec = materializeFixture('caller-failure-fixtures.json', { '{{NESTED_BUILD_DIR}}': 'build-base', '{{NESTED_CALLEE_ADDRESS}}': calleeContract }, 'caller-failure.json');
  let applicationFailure;
  try {
    await runMeasurement({ fixturesPath: failureSpec.path, keyFile: keyA, rpcUrl: endpoint, helperPath: helper, gitCommit: 'nested-app-failure', sdkVersion: '28.0.0' });
    throw new Error('nested application failure was not raised');
  } catch (error) {
    applicationFailure = { message: String(error.message), classification: 'application_failure', rpc_simulation_error: /Simulation failed for run_failing/.test(error.message) };
    assert.match(error.message, /^Simulation failed for run_failing/);
  }
  let invalidInput;
  const invalidSpec = materializeFixture('caller-fixtures.json', { '{{NESTED_BUILD_DIR}}': 'build-base', '{{NESTED_CALLEE_ADDRESS}}': 'CNOTAREALCONTRACTADDRESS' }, 'caller-invalid.json');
  try {
    await runMeasurement({ fixturesPath: invalidSpec.path, keyFile: keyA, rpcUrl: endpoint, helperPath: helper, gitCommit: 'nested-invalid-input', sdkVersion: '28.0.0' });
    throw new Error('invalid input was not raised');
  } catch (error) {
    invalidInput = {
      message: String(error.message),
      classification: 'invalid_input',
      detected_before_simulation: !/Simulation failed/.test(error.message),
    };
    assert.match(error.message, /Invalid value for address/);
    assert.equal(invalidInput.detected_before_simulation, true);
  }
  // Infrastructure failure must be raised after a successful RPC simulation:
  // a failing invocation never reaches native helper provisioning, so the
  // missing-helper probe uses the successful nested caller fixture.
  let infrastructureFailure;
  const infrastructureSpec = materializeFixture('caller-fixtures.json', { '{{NESTED_BUILD_DIR}}': 'build-base', '{{NESTED_CALLEE_ADDRESS}}': calleeContract }, 'caller-infrastructure.json');
  try {
    await runMeasurement({ fixturesPath: infrastructureSpec.path, keyFile: keyA, rpcUrl: endpoint, helperPath: path.join(temporary, 'missing-helper'), gitCommit: 'nested-infrastructure', sdkVersion: '28.0.0' });
    throw new Error('infrastructure failure was not raised');
  } catch (error) {
    infrastructureFailure = { message: String(error.message), classification: 'infrastructure_failure' };
    assert.match(error.message, /Simulation helper missing or not executable/);
  }

  // Archive control: expire one captured nested snapshot entry and require the
  // native helper to reject the snapshot instead of inventing a measurement.
  const archivedInput = structuredClone(nestedReplay.input);
  const headerLedger = xdr.LedgerHeader.fromXDR(archivedInput.header_xdr, 'base64').ledgerSeq();
  const expired = archivedInput.entries.find(row => {
    const key = xdr.LedgerKey.fromXDR(row.key, 'base64');
    return key.switch().name === 'contractData'
      && contractAddressOf(key.contractData().contract()) === calleeContract
      && key.contractData().key().switch().name === 'scvLedgerKeyContractInstance';
  });
  assert.ok(expired, 'nested snapshot carries the callee instance entry');
  expired.live_until = headerLedger - 1;
  const archiveRun = cp.spawnSync(helper, [], { input: JSON.stringify(archivedInput), encoding: 'utf8' });
  const archiveControl = {
    status: 'ARCHIVED_STATE_REJECTED',
    expired_entry_key: expired.key,
    header_ledger: headerLedger,
    live_until: expired.live_until,
    exit_code: archiveRun.status,
    stderr: String(archiveRun.stderr || '').trim(),
    stdout: String(archiveRun.stdout || '').trim(),
  };
  assert.equal(archiveRun.status, 1);
  assert.match(archiveControl.stderr, /archived ledger state is unsupported/);
  write('archive-control.json', archiveControl);
  write('failure-probes.json', { applicationFailure, invalidInput, infrastructureFailure });

  const environment = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    stellar_cli: (await command('stellar', ['--version'])).stdout.trim(),
    rustc: (await command('rustc', ['--version'])).stdout.trim(),
    quickstart_image: 'stellar/quickstart@sha256:4c8bad1ef7341205b898f83d9489321da80c7bd74183100fc8e2a39a5938c7d5',
    rpc_url: endpoint,
    network_passphrase: network.passphrase,
    protocol_version: network.protocolVersion,
    helper_path: helper,
    helper_sha256: sha256(fs.readFileSync(helper)),
    repository_commit: cp.execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    contract_sdk: '28.0.0',
    soroban_simulation: '28.0.1',
  };
  write('environment.json', environment);
  // The build must actually use the pinned toolchain: an unpinned default
  // toolchain silently recompiles different WASM bytes (verified by a control
  // rebuild) and would invalidate every identity assertion above.
  assert.match(environment.rustc, /rustc 1\.95\.0/, environment.rustc);

  const verification = {
    status: 'LIVE_NESTED_INVOCATION_PROOF_PASS',
    real_build_deployment_rpc_and_native: true,
    nested_host_call: true,
    independent_invocation_substitute: false,
    measurement_schema: 4,
    identities: {
      fixture_id: records.base[0].fixture_id,
      callee_logical_id: 'id:callee',
      caller_logical_id: 'id:caller',
      callee_case_id: 'id:work-once',
      caller_case_id: 'id:nested-work',
    },
    wasm_sha256: { callee: base.calleeSha256, caller: base.callerSha256, callee_regression: head.calleeSha256 },
    runtime_contract_ids: { base_callee: calleeContract, base_caller: callerContract, head_callee: headCallee.contract_id, head_caller: headCaller.contract_id },
    rpc_native_parity: {
      transaction_data: true,
      return_value: true,
      ordered_charged_events: true,
      promoted_metrics_verified_against_raw_rpc: ['ledger_read_entries', 'ledger_read_bytes', 'ledger_write_entries', 'ledger_write_bytes', 'events_count', 'event_data_bytes'],
      cpu_memory_direct_rpc_consumption_available: false,
    },
    combined_footprint: {
      callee_footprint_keys_reused: calleeFootprint.keys.length,
      caller_contributed_keys: extraKeys.length,
      nested_read_entries: nested.metrics.ledger_read_entries.consumed,
      nested_write_entries: nested.metrics.ledger_write_entries.consumed,
      callee_read_entries: calleeAlone.metrics.ledger_read_entries.consumed,
      callee_write_entries: calleeAlone.metrics.ledger_write_entries.consumed,
      measured_zero_disk_read_bytes: nested.metrics.ledger_read_bytes.consumed === 0,
    },
    event_attribution: {
      charged_events: nested.metrics.events_count.consumed,
      callee_event_matches_standalone_measurement: true,
      event_order: ['callee', 'caller'],
      event_data_bytes_includes_events_and_return: true,
      events_count_limit_is_null_not_zero: nested.metrics.events_count.limit === null,
    },
    unavailable_metrics_remain_null: ['historical_data_read_bytes', 'contract_data_hard_limit', 'tx_size_bytes'],
    identity_stability: {
      address_swapped_control_paired: true,
      address_swapped_control_zero_deltas: true,
      runtime_addresses_differ: true,
      explicit_invocation_ids_required_for_pairing: true,
    },
    callee_only_regression: {
      detected: true,
      caller_wasm_unchanged: true,
      caller_runtime_address_unchanged: true,
      nested_cpu_delta: nestedCase.find(m => m.key === 'cpu_instructions').delta,
      nested_write_bytes_delta: nestedCase.find(m => m.key === 'ledger_write_bytes').delta,
      policy_violations: violations.length,
    },
    archive_control: { rejected: archiveControl.exit_code === 1, message: archiveControl.stderr },
    failure_classification: {
      application_failure: { message: applicationFailure.message, source: 'RPC simulation error surfaced by the nested caller/callee invocation' },
      invalid_input: { message: invalidInput.message, detected_before_simulation: invalidInput.detected_before_simulation },
      infrastructure_failure: { message: infrastructureFailure.message, source: 'native helper provisioning' },
      distinct_classes: new Set([applicationFailure.classification, invalidInput.classification, infrastructureFailure.classification]).size === 3,
    },
    state_mutations_are_simulated_only: true,
    public_github_ci_proven: false,
  };
  write('verification.json', verification);

  const manifest = {};
  const collect = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(destination, full);
      if (entry.isDirectory()) collect(full);
      else if (entry.isFile() && rel !== 'sha256.json') manifest[rel.split(path.sep).join('/')] = sha256(fs.readFileSync(full));
    }
  };
  collect(destination);
  write('sha256.json', manifest);
  console.log(fs.readFileSync(path.join(destination, 'verification.json'), 'utf8'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
