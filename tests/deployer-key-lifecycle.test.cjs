const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Account, Keypair, rpc, xdr } = require('@stellar/stellar-sdk');
const { runMeasurement } = require('../dist/measurement');

const FIXTURES = {
  contracts: [{ id: 'greeting', wasm_path: 'contract.wasm', invocations: [{ id: 'world', function_name: 'hello', args: [{ type: 'Symbol', value: 'world' }] }] }],
};

// Any account entry works as a template; the mock rewrites its account id per request.
const accountTemplateXdr = require('../docs/experiments/fixture-migration/bridge/rpc.json')
  .flatMap(c => c.raw.result?.entries || [])
  .find(e => { try { return xdr.LedgerEntryData.fromXDR(e.xdr, 'base64').switch().name === 'account'; } catch { return false; } }).xdr;

// `work` holds the fixtures; `sandbox` is where os.tmpdir() points during the run,
// so everything the run creates outside `work` is visible in `sandbox`.
function setup(t, { wasm = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-lifecycle-work-'));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-lifecycle-tmp-'));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = sandbox;
  t.after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(work, 'fixtures.json'), JSON.stringify(FIXTURES));
  if (wasm) fs.writeFileSync(path.join(work, 'contract.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    const key = body.params.keys[0];
    const value = xdr.LedgerEntryData.fromXDR(accountTemplateXdr, 'base64');
    value.account().accountId(xdr.LedgerKey.fromXDR(key, 'base64').account().accountId());
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { latestLedger: 100, entries: [{ key, xdr: value.toXDR('base64') }] } }));
  });
  t.mock.method(rpc.Server.prototype, 'getAccount', async address => new Account(address, '1'));
  // A well-formed contract-instance entry for whichever key is probed.
  t.mock.method(rpc.Server.prototype, 'getLedgerEntries', async key => {
    const instance = xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: key.contractData().contract(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvBool(true),
      }),
    );
    return {
      latestLedger: 100,
      entries: [{ key: key.toXDR('base64'), xdr: instance.toXDR('base64'), liveUntilLedgerSeq: 100 + 1_000_000 }],
    };
  });
  return { work, sandbox, fetchMock };
}

const run = (work, extra = {}) =>
  runMeasurement({ fixturesPath: path.join(work, 'fixtures.json'), fixtureId: 'fixtures.json', gitCommit: 'test', sdkVersion: '25.3.1', ...extra });

test('no keyFile, WASM missing (preflight rejects before funding): no key is left behind', async t => {
  const { work, sandbox, fetchMock } = setup(t);
  await assert.rejects(run(work), /WASM not found/);
  assert.equal(fetchMock.mock.callCount(), 0, 'WASM preflight must reject before any account funding');
  assert.deepEqual(fs.readdirSync(work).sort(), ['fixtures.json']);
  assert.deepEqual(fs.readdirSync(sandbox), []);
});

test('no keyFile, simulation fails mid-run: no key is left behind', async t => {
  const { work, sandbox, fetchMock } = setup(t, { wasm: true });
  t.mock.method(rpc.Server.prototype, 'simulateTransaction', async () => ({ _parsed: true, latestLedger: 1, events: [], error: 'HostError(Budget, LimitExceeded)' }));
  await assert.rejects(run(work), /Simulation failed for hello/);
  assert.ok(fetchMock.mock.callCount() >= 1);
  assert.deepEqual(fs.readdirSync(work).sort(), ['contract.wasm', 'fixtures.json']);
  assert.deepEqual(fs.readdirSync(sandbox), []);
});

test('supplied keyFile is preserved untouched when the run fails', async t => {
  const { work, sandbox } = setup(t);
  const secret = Keypair.random().secret();
  const keyFile = path.join(work, 'shared-key');
  fs.writeFileSync(keyFile, secret, { mode: 0o600 });
  await assert.rejects(run(work, { keyFile }), /WASM not found/);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), secret);
  assert.deepEqual(fs.readdirSync(work).sort(), ['fixtures.json', 'shared-key']);
  assert.deepEqual(fs.readdirSync(sandbox), []);
});

test('invalid fixtures with no keyFile create no key material at all', async t => {
  const { work, sandbox } = setup(t);
  fs.writeFileSync(path.join(work, 'fixtures.json'), 'not json');
  await assert.rejects(run(work));
  assert.deepEqual(fs.readdirSync(work), ['fixtures.json']);
  assert.deepEqual(fs.readdirSync(sandbox), []);
});

// ---------------------------------------------------------------------------
// Successful runs. The native helper is stubbed; RPC transport is mocked above.
// ---------------------------------------------------------------------------
const simulation = require('../dist/simulation');
const successfulSimulation = require('./fixtures/stage1b/base-simulation.json');

// Returns a probe that records what exists in `sandbox` while the measurement runs.
function stubSuccessfulMeasurement(t, sandbox) {
  const probe = { entriesDuringRun: null };
  t.mock.method(rpc.Server.prototype, 'simulateTransaction', async () => rpc.parseRawSimulation(successfulSimulation.raw.result));
  t.mock.method(simulation, 'resolveSimulationHelper', async () => '/stub/helper');
  t.mock.method(simulation, 'measureInvocation', async () => {
    probe.entriesDuringRun = fs.readdirSync(sandbox).map(name => ({ name, files: fs.readdirSync(path.join(sandbox, name)) }));
    return {
      output: {
        cpu_instructions_consumed: 1, memory_bytes_consumed: 1, read_only_keys: [], read_write_keys: [],
        disk_read_bytes: 0, write_bytes: 0, contract_events_xdr: [], retval_xdr: xdr.ScVal.scvVoid().toXDR('base64'),
      },
      provenance: { source: 'soroban-simulation' },
      limits: { cpu_instructions: 1, memory_bytes: 1, footprint_entries: 1, disk_read_bytes: 1, write_entries: 1, write_bytes: 1, events_and_return_bytes: 1 },
    };
  });
  return probe;
}

test('no keyFile, successful run: a private key exists during the run and nothing is left after', async t => {
  const { work, sandbox } = setup(t, { wasm: true });
  const probe = stubSuccessfulMeasurement(t, sandbox);

  const results = await run(work);

  assert.equal(results.length, 1);
  assert.equal(results[0].benchmarks[0].function_name, 'hello');
  assert.equal(probe.entriesDuringRun.length, 1, 'exactly one owned key directory while running');
  assert.match(probe.entriesDuringRun[0].name, /^weighin-key-/);
  assert.deepEqual(probe.entriesDuringRun[0].files, ['deployer-key']);
  assert.deepEqual(fs.readdirSync(work).sort(), ['contract.wasm', 'fixtures.json']);
  assert.deepEqual(fs.readdirSync(sandbox), []);
});

test('supplied keyFile is preserved untouched when the run succeeds', async t => {
  const { work, sandbox } = setup(t, { wasm: true });
  const probe = stubSuccessfulMeasurement(t, sandbox);
  const secret = Keypair.random().secret();
  const keyFile = path.join(work, 'shared-key');
  fs.writeFileSync(keyFile, secret, { mode: 0o600 });

  const results = await run(work, { keyFile });

  assert.equal(results.length, 1);
  assert.deepEqual(probe.entriesDuringRun, [], 'no owned key directory is created for a supplied key');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), secret);
  assert.deepEqual(fs.readdirSync(sandbox), []);
});
