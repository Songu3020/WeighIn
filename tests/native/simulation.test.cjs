const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { TransactionBuilder, xdr } = require('@stellar/stellar-sdk');
const { simulateSnapshot, measureInvocation } = require('../../dist/simulation');
const evidence = path.resolve(__dirname, '../../docs/experiments/compute-source-spike');
const helper = path.resolve(__dirname, '../../native/simulation/target/x86_64-unknown-linux-gnu/release/weighin-simulation');
const base = require(`${evidence}/base-input.json`);
const head = require(`${evidence}/head-input.json`);
const snapshot = require(`${evidence}/snapshot-raw.json`);

for (const [label, input] of [['base', base], ['head', head]]) {
  test(`${label}: real native source reproduces saved consumed compute five times, independently of leeway`, async () => {
    const captured = require(`${evidence}/${label}-output.json`);
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await simulateSnapshot(input, helper));
    for (const output of runs) {
      for (const [key, value] of Object.entries(captured)) assert.deepEqual(output[key], value, key);
      assert.deepEqual(output, runs[0]);
    }
    const leeway = await simulateSnapshot({ ...input, instruction_leeway: 5000000 }, helper);
    assert.equal(leeway.cpu_instructions_consumed, runs[0].cpu_instructions_consumed);
    assert.equal(leeway.memory_bytes_consumed, runs[0].memory_bytes_consumed);
    assert.ok(leeway.instruction_budget > runs[0].instruction_budget);
  });
}
test('real helper rejects missing config, uncaptured state, failed calls, protocol mismatch and malformed seed', async () => {
  const alteredHeader = xdr.LedgerHeader.fromXDR(base.header_xdr, 'base64'); alteredHeader.ledgerVersion(27);
  const badFunction = xdr.HostFunction.fromXDR(base.host_function_xdr, 'base64'); badFunction.invokeContract().functionName('missing');
  const cases = [
    [{ ...base, entries: [] }, /network configuration/],
    [{ ...base, entries: base.entries.filter(row => !['contractCode', 'contractData'].includes(xdr.LedgerKey.fromXDR(row.key, 'base64').switch().name)) }, /Native helper uncaptured: snapshot is missing ledger keys/],
    [{ ...base, host_function_xdr: badFunction.toXDR('base64') }, /host invocation failed/],
    [{ ...base, header_xdr: alteredHeader.toXDR('base64') }, /unsupported protocol/],
    [{ ...base, seed: [0] }, /32 bytes/],
  ];
  for (const [input, message] of cases) await assert.rejects(simulateSnapshot(input, helper), message);
});

function capturedRpc(t, mutate) {
  let entryCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    let result;
    if (body.method === 'getNetwork') result = { passphrase: base.network_passphrase, protocolVersion: 28 };
    if (body.method === 'simulateTransaction') result = snapshot.simulations[0].raw.result;
    if (body.method === 'getLedgerEntries') {
      entryCalls++;
      result = { ...snapshot.entries.raw.result, entries: snapshot.entries.raw.result.entries.filter(entry => body.params.keys.includes(entry.key)) };
    }
    if (body.method === 'getLedgers') result = snapshot.headers.raw.result;
    if (mutate) result = mutate(body, result, entryCalls);
    assert.ok(result, body.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  return () => entryCalls;
}
const transaction = () => TransactionBuilder.fromXDR(snapshot.simulations[0].request.params.transaction, base.network_passphrase);
test('production snapshot adapter measures real captured invocation and emits provenance', async t => {
  capturedRpc(t);
  const measured = await measureInvocation('http://captured/rpc', transaction(), helper);
  assert.equal(measured.output.cpu_instructions_consumed, 270219);
  assert.equal(measured.provenance.ledger, 229);
  assert.equal(measured.provenance.protocol, 28);
  assert.match(measured.provenance.helper_sha256, /^[a-f0-9]{64}$/);
  assert.match(measured.provenance.config_sha256, /^[a-f0-9]{64}$/);
  const names = new Set(['configSettingContractComputeV0', 'configSettingContractCostParamsCpuInstructions', 'configSettingContractCostParamsMemoryBytes', 'configSettingStateArchival']);
  const calibration = base.entries.filter(entry => {
    const key = xdr.LedgerKey.fromXDR(entry.key, 'base64');
    return key.switch().name === 'configSetting' && names.has(key.configSetting().configSettingId().name);
  }).sort((a, b) => a.key.localeCompare(b.key, 'en', { sensitivity: 'variant' }));
  // Adapter sorts raw base64 lexically, rather than locale-dependent sorting.
  calibration.sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  assert.equal(calibration.length, 4);
  const expected = crypto.createHash('sha256').update(JSON.stringify(calibration.map(({key,xdr}) => ({key,xdr})))).digest('hex');
  assert.equal(measured.provenance.compute_config_sha256, expected);
});
test('ledger drift retries the entire capture before measuring', async t => {
  const calls = capturedRpc(t, (body, result, count) => body.method === 'getLedgerEntries' && count === 1 ? { ...result, latestLedger: 230 } : result);
  assert.equal((await measureInvocation('http://captured/rpc', transaction(), helper)).output.cpu_instructions_consumed, 270219);
  assert.equal(calls(), 2);
});
test('protocol mismatch and missing extension metadata fail explicitly', async t => {
  capturedRpc(t, (body, result) => body.method === 'getNetwork' ? { ...result, protocolVersion: 29 } : result);
  await assert.rejects(measureInvocation('http://captured/rpc', transaction(), helper), /Unsupported protocol 29/);
  t.mock.restoreAll();
  capturedRpc(t, (body, result) => body.method === 'getLedgerEntries' ? { ...result, entries: result.entries.map(({ extXdr, ...entry }) => entry) } : result);
  await assert.rejects(measureInvocation('http://captured/rpc', transaction(), helper));
});
test('missing required configuration entries fail explicitly before helper execution', async t => {
  capturedRpc(t, (body, result) => {
    if (body.method === 'getLedgerEntries') {
      return {
        ...result,
        entries: result.entries.filter(e => {
          const k = xdr.LedgerKey.fromXDR(e.key, 'base64');
          return k.switch().name !== 'configSetting';
        }),
      };
    }
    return result;
  });
  await assert.rejects(
    measureInvocation('http://captured/rpc', transaction(), helper),
    /Missing required configuration entries/,
  );
});
test('ambiguous duplicate ledger headers for sequence are rejected before helper execution', async t => {
  capturedRpc(t, (body, result) => {
    if (body.method === 'getLedgers') {
      return { ...result, ledgers: [...result.ledgers, ...result.ledgers] };
    }
    return result;
  });
  await assert.rejects(
    measureInvocation('http://captured/rpc', transaction(), helper),
    /Ambiguous duplicate ledger headers returned for sequence/,
  );
});
test('captured-state/local result disagreement is rejected rather than blended with RPC values', async t => {
  capturedRpc(t, (body, result) => body.method === 'simulateTransaction' ? { ...result, results: [{ ...result.results[0], xdr: xdr.ScVal.scvVoid().toXDR('base64') }] } : result);
  await assert.rejects(measureInvocation('http://captured/rpc', transaction(), helper), /disagrees with RPC/);
});

test('resource caps come from captured settings and fee-only changes do not alter their identity', async t => {
  capturedRpc(t);
  const original = await measureInvocation('http://captured/rpc', transaction(), helper);
  assert.match(original.provenance.resource_limits_sha256, /^[a-f0-9]{64}$/);
  assert.equal(original.limits.cpu_instructions, original.output.cpu_limit);
  assert.equal(original.limits.memory_bytes, original.output.memory_limit);
  t.mock.restoreAll();
  const mutateSetting = (name, change) => (body, result) => {
    if (body.method !== 'getLedgerEntries') return result;
    return { ...result, entries: result.entries.map(entry => {
      const data = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
      if (data.switch().name !== 'configSetting' || data.configSetting().switch().name !== name) return entry;
      change(data.configSetting());
      return { ...entry, xdr: data.toXDR('base64') };
    }) };
  };
  capturedRpc(t, mutateSetting('configSettingContractLedgerCostExtV0', setting => {
    const value = setting.contractLedgerCostExt(); value.txMaxFootprintEntries(value.txMaxFootprintEntries()+1);
  }));
  const cap = await measureInvocation('http://captured/rpc', transaction(), helper);
  assert.equal(cap.limits.footprint_entries, original.limits.footprint_entries+1);
  assert.notEqual(cap.provenance.resource_limits_sha256, original.provenance.resource_limits_sha256);
  assert.equal(cap.provenance.compute_config_sha256, original.provenance.compute_config_sha256);
  t.mock.restoreAll();
  capturedRpc(t, mutateSetting('configSettingContractLedgerCostExtV0', setting => {
    const value = setting.contractLedgerCostExt();
    value.feeWrite1Kb(xdr.Int64.fromString((BigInt(value.feeWrite1Kb().toString())+1n).toString()));
  }));
  const fee = await measureInvocation('http://captured/rpc', transaction(), helper);
  assert.notEqual(fee.provenance.config_sha256, original.provenance.config_sha256);
  assert.equal(fee.provenance.resource_limits_sha256, original.provenance.resource_limits_sha256);
  assert.equal(fee.provenance.compute_config_sha256, original.provenance.compute_config_sha256);
  t.mock.restoreAll();
  capturedRpc(t, (body,result) => body.method === 'getLedgerEntries' ? {
    ...result, entries:result.entries.map(entry => ({...entry,lastModifiedLedgerSeq:entry.lastModifiedLedgerSeq+1})),
  } : result);
  const metadata = await measureInvocation('http://captured/rpc', transaction(), helper);
  assert.notEqual(metadata.provenance.config_sha256, original.provenance.config_sha256);
  assert.equal(metadata.provenance.resource_limits_sha256, original.provenance.resource_limits_sha256);
});

test('RPC charged-event disagreement fails even when return value and transaction data agree', async t => {
  capturedRpc(t, (body,result) => {
    if (body.method !== 'simulateTransaction') return result;
    const event = xdr.DiagnosticEvent.fromXDR(result.events[0],'base64');
    event.event().type(xdr.ContractEventType.contract());
    return { ...result, events:[event.toXDR('base64'),...result.events.slice(1)] };
  });
  await assert.rejects(measureInvocation('http://captured/rpc', transaction(), helper), /disagrees with RPC/);
});
