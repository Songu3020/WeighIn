const { test } = require('node:test');
const assert = require('node:assert/strict');
const { xdr, StrKey } = require('@stellar/stellar-sdk');
const { ensureAccountReady } = require('../dist/account');
const captures = require('../docs/experiments/fixture-migration/bridge/rpc.json');
const entry = captures.flatMap(c => c.raw.result?.entries || []).find(e => {
  try { return xdr.LedgerEntryData.fromXDR(e.xdr, 'base64').switch().name === 'account'; } catch { return false; }
});
const publicKey = StrKey.encodeEd25519PublicKey(xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64').account().accountId().ed25519());
const absent = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { entries: [], latestLedger: 100 } }));
const present = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { entries: [entry], latestLedger: 101 } }));
// Controlled HTTP responses and virtual elapsed time only, not live funding evidence.
async function scenario(handler, preserveEnvelope = false) {
  const oldFetch = global.fetch, oldTimer = global.setTimeout, oldNow = Date.now;
  let elapsed = 0; const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const response = await handler(url, options, calls);
    if (preserveEnvelope || options?.method !== 'POST') return response;
    const body = await response.json();
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ ...body, jsonrpc: '2.0', id: request.id }), { status: response.status });
  };
  Date.now = () => elapsed;
  global.setTimeout = (callback, delay, ...args) => { elapsed += delay; return setImmediate(callback, ...args); };
  try { await ensureAccountReady('http://localhost:8000/rpc', publicKey); return { calls, elapsed }; }
  finally { global.fetch = oldFetch; global.setTimeout = oldTimer; Date.now = oldNow; }
}
test('existing account is confirmed without calling Friendbot', async () => {
  const { calls } = await scenario(() => present()); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, false);
});
test('temporary Friendbot 502 recovers with the same address and confirmed inclusion', async () => {
  let funds = 0, reads = 0;
  const { calls } = await scenario((url, options) => options.method === 'POST' ? (++reads < 4 ? absent() : present())
    : (++funds === 1 ? new Response('warming', { status: 502 }) : new Response('{}')));
  assert.equal(funds, 2); assert.equal(reads, 4);
  assert.ok(calls.filter(c => !c.options.method).every(c => new URL(c.url).searchParams.get('addr') === publicKey));
});
test('accepted funding is not repeated while RPC inclusion is delayed', async () => {
  let reads = 0, funds = 0;
  await scenario((url, options) => options.method === 'POST' ? (++reads < 5 ? absent() : present()) : (funds++, new Response('{}')));
  assert.equal(funds, 1); assert.equal(reads, 5);
});
test('ambiguous temporary funding response checks account before attempting another funding', async () => {
  let reads = 0, funds = 0;
  await scenario((url, options) => options.method === 'POST' ? (++reads === 1 ? absent() : present()) : (funds++, new Response('', { status: 503 })));
  assert.equal(funds, 1);
});
for (const status of [429, 500, 502, 503, 504]) test(`persistent HTTP ${status} exhausts the deadline and never succeeds`, async () => {
  await assert.rejects(scenario((url, options) => options.method === 'POST' ? absent() : new Response('', { status })), /Account readiness failed within 120s/);
});
test('successful funding without RPC inclusion exhausts the deadline', async () => {
  let funds = 0;
  await assert.rejects(scenario((url, options) => options.method === 'POST' ? absent() : (funds++, new Response('{}'))), /funded account has not appeared/);
  assert.equal(funds, 1);
});
for (const status of [400, 401, 403, 404]) test(`permanent funding HTTP ${status} fails immediately`, async () => {
  let funds = 0;
  await assert.rejects(scenario((url, options) => options.method === 'POST' ? absent() : (funds++, new Response('', { status }))), new RegExp(`HTTP ${status}`));
  assert.equal(funds, 1);
});
test('transport timeout can recover; persistent transport failure exhausts the deadline', async () => {
  let calls = 0;
  await scenario(() => { if (++calls === 1) throw new DOMException('timed out', 'TimeoutError'); return present(); });
  await assert.rejects(scenario(() => { throw new TypeError('fetch failed'); }), /Account readiness failed within 120s/);
});
test('RPC error is not interpreted as account absence and does not trigger funding', async () => {
  let calls = 0;
  await assert.rejects(scenario(() => { calls++; return new Response(JSON.stringify({ error: { code: -32603, message: 'internal failure' } })); }), /Account readiness RPC method error.*-32603/);
  assert.equal(calls, 1);
});
test('malformed or unrelated account rows are rejected before measurement', async () => {
  for (const entries of [[{ ...entry, key: 'unrelated' }], [{ ...entry, xdr: 'broken' }], [entry, entry]]) {
    await assert.rejects(scenario(() => new Response(JSON.stringify({ result: { entries, latestLedger: 100 } }))));
  }
});

test('malformed JSON-RPC envelopes fail before account funding', async () => {
  const validResult = { entries: [], latestLedger: 100 };
  const malformed = [
    { jsonrpc: '1.0', id: 1, result: validResult },
    { jsonrpc: '2.0', id: 9, result: validResult },
    { jsonrpc: '2.0', id: 1, result: validResult, error: { code: -1, message: 'conflict' } },
    { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', result: validResult },
    { jsonrpc: '2.0', id: 1, error: { code: '-32603', message: 'wrong code type' } },
    { jsonrpc: '2.0', id: 1, result: validResult, extra: true },
    'not json',
  ];
  for (const envelope of malformed) {
    let calls = 0;
    await assert.rejects(
      scenario(() => { calls++; return new Response(typeof envelope === 'string' ? envelope : JSON.stringify(envelope)); }, true),
      /Account readiness invalid RPC response/,
    );
    assert.equal(calls, 1);
  }
});

test('permanent HTTP error with a stalled body fails from headers without retrying', async () => {
  let funds = 0, cancelled = false;
  await assert.rejects(scenario((url, options) => options.method === 'POST' ? absent() :
    (funds++, new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 }))), /HTTP 403/);
  assert.equal(funds, 1); assert.equal(cancelled, true);
});
