// Explicit live proof for issues #213 and #215: one fixture declares two
// different WASMs, the caller depends on the callee, and the caller's measured
// invocation receives the callee's committed create return as a typed address
// binding. Excluded from npm test. Runs the production measurement path against
// a pinned local standalone network and retains sanitized evidence: the
// submitted setup order, committed create returns, the measured nested host
// call, and live failure probes for a malformed binding path and a failed
// prerequisite. Uses the retained nested-invocation WASMs, so no build runs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { Address, StrKey, rpc, xdr } = require('@stellar/stellar-sdk');

const repository = path.resolve(__dirname, '../..');
const destination = path.resolve(process.argv[2] || path.join(repository, 'docs/experiments/setup-plan'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-setup-plan-'));
const endpoint = process.env.WEIGHIN_EXPERIMENT_RPC_URL || 'http://localhost:8000/rpc';
const passphrase = 'Standalone Network ; February 2017';
const helper = path.join(repository, 'native/simulation/target/x86_64-unknown-linux-gnu/release/weighin-simulation');
const wasmSource = path.join(repository, 'docs/experiments/nested-invocation');
fs.mkdirSync(destination, { recursive: true });

const write = (name, data) => fs.writeFileSync(path.join(destination, name), JSON.stringify(data, null, 2) + '\n');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const capture = (file, args) => cp.execFileSync(file, args, { encoding: 'utf8' }).trim();

// Every submitted setup transaction, decoded to its operation, per scenario.
let timeline = [];
let submissions = [];
const sendOriginal = rpc.Server.prototype.sendTransaction;
rpc.Server.prototype.sendTransaction = async function(transaction) {
  const response = await sendOriginal.call(this, transaction);
  const op = transaction.operations[0];
  const fn = op.func.switch().name;
  submissions.push({
    hash: response.hash,
    status: response.status,
    host_function: fn,
    ...(fn === 'hostFunctionTypeUploadContractWasm'
      ? { wasm_sha256: sha256(op.func.wasm()) }
      : {}),
    ...(fn === 'hostFunctionTypeCreateContractV2'
      ? { wasm_hash: op.func.createContractV2().executable().wasmHash().toString('hex') }
      : {}),
  });
  return response;
};
let confirmations = [];
const getOriginal = rpc.Server.prototype.getTransaction;
rpc.Server.prototype.getTransaction = async function(hash) {
  const response = await getOriginal.call(this, hash);
  if (response.status !== 'NOT_FOUND') {
    timeline.push(`confirmed:${response.status}`);
    confirmations.push({
      hash,
      status: response.status,
      ledger: response.ledger,
      return_xdr: response.returnValue ? response.returnValue.toXDR('base64') : null,
    });
  }
  return response;
};
let simulations = [];
const simulateOriginal = rpc.Server.prototype.simulateTransaction;
rpc.Server.prototype.simulateTransaction = async function(transaction) {
  // prepareTransaction also simulates upload/create; record only invocations.
  const func = transaction.operations[0].func;
  if (func.switch().name !== 'hostFunctionTypeInvokeContract') return simulateOriginal.call(this, transaction);
  const invoke = func.invokeContract();
  timeline.push('simulate');
  simulations.push({
    contract_id: Address.fromScAddress(invoke.contractAddress()).toString(),
    function_name: invoke.functionName().toString(),
    args_xdr: invoke.args().map(arg => arg.toXDR('base64')),
  });
  return simulateOriginal.call(this, transaction);
};
let replays = [];
const execOriginal = cp.execFile;
cp.execFile = function(file, args, options, callback) {
  if (file !== helper) return execOriginal.apply(this, arguments);
  let input;
  const child = execOriginal(file, args, options, (error, stdout, stderr) => {
    const output = error ? null : JSON.parse(stdout);
    const invoke = xdr.HostFunction.fromXDR(input.host_function_xdr, 'base64').invokeContract();
    replays.push({
      contract_id: Address.fromScAddress(invoke.contractAddress()).toString(),
      function_name: invoke.functionName().toString(),
      read_only_keys: output?.read_only_keys ?? null,
      read_write_keys: output?.read_write_keys ?? null,
      retval_xdr: output?.retval_xdr ?? null,
      error: error ? String(stderr).trim() : null,
    });
    callback(error, stdout, stderr);
  });
  const end = child.stdin.end.bind(child.stdin);
  child.stdin.end = function(data, ...rest) { input = JSON.parse(data); return end(data, ...rest); };
  return child;
};

const { runMeasurement } = require('../../dist/measurement');

function reset() { timeline = []; submissions = []; confirmations = []; simulations = []; replays = []; }

function scenario(name, { calleeBytes, select }) {
  const dir = path.join(temporary, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'callee.wasm'), calleeBytes);
  fs.copyFileSync(path.join(wasmSource, 'nested-caller.wasm'), path.join(dir, 'caller.wasm'));
  // The dependent caller is declared first; the plan must deploy the callee first.
  const fixture = {
    id: 'setup-plan-suite',
    contracts: [
      {
        id: 'caller',
        wasm_path: 'caller.wasm',
        depends_on: ['callee'],
        invocations: [{
          id: 'nested-work',
          function_name: 'run',
          args: [
            { type: 'address', binding: { contract: 'callee', ...(select ? { select } : {}) } },
            { type: 'u32', value: 1 },
          ],
        }],
      },
      {
        id: 'callee',
        wasm_path: 'callee.wasm',
        invocations: [{ id: 'work-once', function_name: 'work', args: [{ type: 'u32', value: 1 }] }],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'fixtures.json'), JSON.stringify(fixture, null, 2));
  return { fixture, run: () => runMeasurement({
    fixturesPath: path.join(dir, 'fixtures.json'),
    fixtureId: 'setup-plan-fixtures.json',
    // A fresh deployer per scenario: every setup is committed by this run.
    keyFile: path.join(dir, 'deployer.key'),
    rpcUrl: endpoint,
    helperPath: helper,
    gitCommit: `setup-plan-${name}`,
    sdkVersion: '28.0.0',
  }) };
}

function footprintContracts(keys) {
  const instances = new Set(), storage = [];
  for (const base64 of keys) {
    const key = xdr.LedgerKey.fromXDR(base64, 'base64');
    if (key.switch().name !== 'contractData') continue;
    const data = key.contractData();
    const contract = StrKey.encodeContract(data.contract().contractId());
    if (data.key().switch().name === 'scvLedgerKeyContractInstance') instances.add(contract);
    else storage.push({ contract, key: data.key().switch().name === 'scvSymbol' ? data.key().sym().toString() : data.key().switch().name });
  }
  return { instances: [...instances].sort(), storage };
}

(async () => {
  const server = new rpc.Server(endpoint, { allowHttp: true });
  const network = await server.getNetwork();
  assert.equal(network.passphrase, passphrase);
  const calleeBytes = fs.readFileSync(path.join(wasmSource, 'nested-callee.wasm'));
  const callerBytes = fs.readFileSync(path.join(wasmSource, 'nested-caller.wasm'));
  const wasm_sha256 = { callee: sha256(calleeBytes), caller: sha256(callerBytes) };
  assert.notEqual(wasm_sha256.callee, wasm_sha256.caller, 'two different WASMs');

  write('environment.json', {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    stellar_sdk: JSON.parse(fs.readFileSync(path.join(repository, 'package-lock.json'), 'utf8')).packages['node_modules/@stellar/stellar-sdk'].version,
    quickstart_image: capture('docker', ['inspect', '--format', '{{.Config.Image}}', 'stellar-quickstart']),
    rpc_url: endpoint,
    network_passphrase: network.passphrase,
    protocol_version: network.protocolVersion,
    helper_sha256: sha256(fs.readFileSync(helper)),
    repository_base: capture('git', ['-C', repository, 'rev-parse', 'HEAD']),
    wasm_source: 'docs/experiments/nested-invocation/{nested-callee,nested-caller}.wasm',
  });

  // 1. Success: dependency-ordered setup and a typed committed-address binding.
  reset();
  const success = scenario('success', { calleeBytes });
  const records = await success.run();
  const successTimeline = [...timeline];
  const successConfirmations = [...confirmations];
  const calleeRecord = records.find(record => record.logical_id === 'id:callee');
  const callerRecord = records.find(record => record.logical_id === 'id:caller');
  const setupOrder = submissions.map(item => ({
    host_function: item.host_function,
    artifact: item.wasm_sha256 === wasm_sha256.callee || item.wasm_hash === wasm_sha256.callee ? 'callee' : 'caller',
    hash: item.hash,
    status: item.status,
  }));
  const committedReturns = confirmations
    .filter(item => submissions.find(s => s.hash === item.hash)?.host_function === 'hostFunctionTypeCreateContractV2')
    .map(item => ({
      ...item,
      decoded_address: Address.fromScVal(xdr.ScVal.fromXDR(item.return_xdr, 'base64')).toString(),
    }));
  const callerSimulation = simulations.find(item => item.function_name === 'run');
  const boundArgument = xdr.ScVal.fromXDR(callerSimulation.args_xdr[0], 'base64');
  const callerReplay = replays.find(item => item.function_name === 'run');
  const footprint = footprintContracts([...callerReplay.read_only_keys, ...callerReplay.read_write_keys]);
  const retval = xdr.ScVal.fromXDR(callerReplay.retval_xdr, 'base64');
  write('fixtures.json', success.fixture);
  write('measurements.json', records);
  write('setup-receipts.json', { setup_order: setupOrder, committed_returns: committedReturns, confirmations });
  write('caller-invocation.json', { simulation: callerSimulation, native_footprint: footprint, retval_xdr: callerReplay.retval_xdr });

  // 2. Malformed binding path: indexing into an address return.
  reset();
  let malformedError;
  try { await scenario('malformed-path', { calleeBytes, select: [{ index: 0 }] }).run(); } catch (error) { malformedError = error.message; }
  const malformed = { error: malformedError, submissions: submissions.map(s => s.host_function), simulated: simulations.map(s => s.function_name) };

  // 3. Failed prerequisite: a callee artifact the network rejects at upload.
  reset();
  const brokenCallee = Buffer.concat([calleeBytes.subarray(0, 8), Buffer.from('not a wasm module')]);
  let prerequisiteError;
  try { await scenario('failed-prerequisite', { calleeBytes: brokenCallee }).run(); } catch (error) { prerequisiteError = error.message; }
  const prerequisite = { error: prerequisiteError, submissions: submissions.map(s => s.host_function), simulated: simulations.map(s => s.function_name) };
  write('failure-probes.json', { malformed_binding_path: malformed, failed_prerequisite: prerequisite });

  const checks = {
    two_distinct_wasms: wasm_sha256.callee !== wasm_sha256.caller,
    callee_deployed_before_caller: JSON.stringify(setupOrder.map(s => `${s.host_function}:${s.artifact}`)) === JSON.stringify([
      'hostFunctionTypeUploadContractWasm:callee', 'hostFunctionTypeCreateContractV2:callee',
      'hostFunctionTypeUploadContractWasm:caller', 'hostFunctionTypeCreateContractV2:caller',
    ]),
    each_deployment_submitted_once: setupOrder.length === 4,
    all_setup_committed: successConfirmations.length === 4 && successConfirmations.every(item => item.status === 'SUCCESS'),
    setup_committed_before_measurement: successTimeline.lastIndexOf('confirmed:SUCCESS') < successTimeline.indexOf('simulate') && successTimeline.filter(event => event === 'confirmed:SUCCESS').length === 4,
    committed_callee_return_is_callee_address: committedReturns[0]?.decoded_address === calleeRecord.contract_id,
    bound_argument_is_typed_address: boundArgument.switch().name === 'scvAddress',
    bound_argument_equals_committed_return: callerSimulation.args_xdr[0] === committedReturns[0]?.return_xdr,
    caller_invoked_at_caller_address: callerSimulation.contract_id === callerRecord.contract_id,
    nested_call_touches_callee_instance: footprint.instances.includes(calleeRecord.contract_id) && footprint.instances.includes(callerRecord.contract_id),
    nested_call_writes_callee_counter: footprint.storage.some(entry => entry.contract === calleeRecord.contract_id && entry.key === 'counter'),
    nested_call_returns_callee_result: retval.switch().name === 'scvVec' && retval.vec()[0].u32() === 1,
    malformed_path_fails_before_dependent_invocation: /Cannot resolve binding to "callee": \$ is scvAddress, not a vec/.test(malformedError ?? '') && !malformed.simulated.includes('run'),
    failed_prerequisite_aborts_dependent: /aborted dependents: id:caller/.test(prerequisiteError ?? '') && prerequisite.submissions.length === 0 && prerequisite.simulated.length === 0,
  };
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, name);
  write('verification.json', {
    status: 'LIVE_SETUP_PLAN_PROOF_PASS',
    issues: [213, 215],
    measurement_schema: callerRecord.schema_version,
    identities: {
      fixture_id: callerRecord.fixture_id,
      callee_logical_id: calleeRecord.logical_id,
      caller_logical_id: callerRecord.logical_id,
      caller_case_id: callerRecord.benchmarks[0].case_id,
    },
    wasm_sha256,
    runtime_contract_ids: { callee: calleeRecord.contract_id, caller: callerRecord.contract_id },
    checks,
  });

  const hashed = {};
  for (const name of fs.readdirSync(destination).sort()) {
    if (name !== 'sha256.json') hashed[name] = sha256(fs.readFileSync(path.join(destination, name)));
  }
  write('sha256.json', hashed);
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log('LIVE_SETUP_PLAN_PROOF_PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
