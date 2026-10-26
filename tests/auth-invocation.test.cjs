const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const archiveDir = path.resolve(__dirname, '../docs/experiments/auth-invocation');
const fixtureDir = path.resolve(__dirname, 'fixtures/auth');
const hash = (data) => createHash('sha256').update(data).digest('hex');

function verifyAuthInvocation(contractSource, rpc, native, verification) {
  assert.equal(verification.status, 'VERIFIED');
  assert.equal(verification.scenario, 'auth_invocation');
  assert.equal(verification.action_exit, 0);
  assert.equal(verification.action_outcome, 'success');
  assert.equal(verification.result, 'pass');
  assert.equal(verification.supports_recording_auth_mode, true);
  assert.equal(verification.supports_signed_production_authorization, false);
  assert.equal(verification.network_support_broadened, false);
  assert.equal(verification.fail_closed_on_invalid_auth, true);
  assert.equal(verification.explicit_require_auth_call, true);

  // Contract verification: must explicitly call require_auth
  assert.ok(
    contractSource.includes('.require_auth()'),
    'Reference contract must explicitly invoke require_auth()',
  );

  // Auth mode verification: must be recording(true,true)
  assert.equal(rpc.auth_mode, 'recording(true,true)');
  assert.equal(native.auth_mode, 'recording(true,true)');
  assert.equal(verification.auth_mode, 'recording(true,true)');

  // Parity checks between RPC and native helper
  assert.equal(
    rpc.resources.cpu_instructions,
    native.cpu_instructions_consumed,
    'RPC and native CPU instructions consumed must agree exactly',
  );
  assert.equal(
    rpc.resources.memory_bytes,
    native.memory_bytes_consumed,
    'RPC and native memory bytes consumed must agree exactly',
  );
  assert.equal(
    rpc.resources.disk_read_bytes,
    native.disk_read_bytes,
    'RPC and native disk read bytes must agree exactly',
  );
  assert.equal(
    rpc.resources.write_bytes,
    native.write_bytes,
    'RPC and native write bytes must agree exactly',
  );
  assert.equal(
    rpc.retval_xdr,
    native.retval_xdr,
    'RPC and native return value XDR must agree exactly',
  );
  assert.equal(
    rpc.transaction_data_sha256,
    native.transaction_data_sha256,
    'RPC and native transaction data hash must agree exactly',
  );

  // Parity flags
  assert.equal(native.parity.transaction_data, true);
  assert.equal(native.parity.return_value, true);
  assert.equal(native.parity.events, true);

  // Fail-closed checks: invalid authorization must produce explicit error, never zero or fallback
  assert.equal(verification.invalid_auth_simulation.zero_budget_fallback_substituted, false);
  assert.equal(verification.invalid_auth_simulation.missing_caller_status, 'error');
  assert.equal(verification.invalid_auth_simulation.invalid_address_status, 'error');

  return true;
}

test('retained auth invocation evidence matches checksums and satisfies all criteria', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const sha256 = read('sha256.json');
  for (const [file, expectedHash] of Object.entries(sha256)) {
    assert.equal(hash(fs.readFileSync(path.join(archiveDir, file))), expectedHash, `Checksum mismatch for ${file}`);
  }

  const contractSource = fs.readFileSync(path.join(archiveDir, 'contract/src/lib.rs'), 'utf8');
  const rpc = read('rpc.json');
  const native = read('native.json');
  const verification = read('verification.json');

  assert.ok(verifyAuthInvocation(contractSource, rpc, native, verification));
});

test('fixture contract source and auth-fixtures.json exist and match retained archive', () => {
  const fixtureSource = fs.readFileSync(path.join(fixtureDir, 'contract/src/lib.rs'), 'utf8');
  const archiveSource = fs.readFileSync(path.join(archiveDir, 'contract/src/lib.rs'), 'utf8');
  assert.equal(hash(fixtureSource), hash(archiveSource), 'Fixture source and archive source must be identical');

  const fixtures = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'auth-fixtures.json'), 'utf8'));
  assert.equal(fixtures.id, 'auth-invocation-suite');
  assert.equal(fixtures.contracts[0].id, 'contract-auth');
  assert.equal(fixtures.contracts[0].invocations[0].function_name, 'auth_call');
});

test('verifier rejects contract that does not call require_auth', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const contractSource = 'pub fn auth_call(_env: Env, _caller: Address) -> Symbol { symbol_short!("noauth") }';
  const rpc = read('rpc.json');
  const native = read('native.json');
  const verification = read('verification.json');

  assert.throws(
    () => verifyAuthInvocation(contractSource, rpc, native, verification),
    /Reference contract must explicitly invoke require_auth\(\)/,
  );
});

test('verifier rejects RPC and native resource parity divergence', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const contractSource = fs.readFileSync(path.join(archiveDir, 'contract/src/lib.rs'), 'utf8');
  const rpc = read('rpc.json');
  const native = read('native.json');
  const verification = read('verification.json');

  // Divergent CPU instructions
  native.cpu_instructions_consumed = rpc.resources.cpu_instructions + 1000;

  assert.throws(
    () => verifyAuthInvocation(contractSource, rpc, native, verification),
    /RPC and native CPU instructions consumed must agree exactly/,
  );
});

test('verifier rejects zero-budget fallback substitution on auth failure', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const contractSource = fs.readFileSync(path.join(archiveDir, 'contract/src/lib.rs'), 'utf8');
  const rpc = read('rpc.json');
  const native = read('native.json');
  const verification = read('verification.json');

  verification.invalid_auth_simulation.zero_budget_fallback_substituted = true;

  assert.throws(
    () => verifyAuthInvocation(contractSource, rpc, native, verification),
    /Expected values to be strictly equal/,
  );
});
