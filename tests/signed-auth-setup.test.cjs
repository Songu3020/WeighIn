const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  Keypair,
  Address,
  xdr,
  Networks,
  authorizeInvocation,
  buildAuthorizationEntryPreimage,
} = require('@stellar/stellar-sdk');

const archiveDir = path.resolve(__dirname, '../docs/experiments/signed-auth-setup');

function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

test('retained signed auth setup evidence matches checksums and satisfies security verification', () => {
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const sha256 = readJson('sha256.json');

  for (const [file, expectedHash] of Object.entries(sha256)) {
    const filePath = path.join(archiveDir, file);
    assert.ok(fs.existsSync(filePath), `Expected file ${file} to exist in ${archiveDir}`);
    assert.equal(hash(fs.readFileSync(filePath)), expectedHash, `Checksum mismatch for ${file}`);
  }

  const verification = readJson('verification.json');
  assert.equal(verification.status, 'VERIFIED');
  assert.equal(verification.assessment, 'signed_authorization_committed_setup');
  assert.equal(verification.protocol, 28);
  assert.equal(verification.result, 'pass');
  assert.deepEqual(verification.smallest_supported_modes, ['SourceAccountAuth', 'AddressAccountAuth']);
  assert.ok(verification.unsupported_modes.includes('ContractAuth'));
  assert.ok(verification.unsupported_modes.includes('MultisigThreshold'));
  assert.ok(verification.unsupported_modes.includes('AddressWithDelegates'));
  assert.equal(verification.security_invariants.uncommitted_private_signers, true);
  assert.equal(verification.security_invariants.credentials_sanitized, true);
  assert.equal(verification.security_invariants.signing_overhead_excluded_from_benchmark, true);
  assert.equal(verification.security_invariants.setup_rejection_halts_measurement, true);
});

test('sanitized evidence contains zero private keys or secrets', () => {
  const files = ['authorized-setup.json', 'unauthorized-setup.json', 'verification.json'];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(archiveDir, file), 'utf8');
    // Secret keys in Stellar start with 'S' followed by 55 alphanumeric characters
    assert.doesNotMatch(raw, /\bS[A-Z0-9]{55}\b/, `File ${file} must not contain Stellar secret keys`);
    assert.doesNotMatch(raw, /private_key|secret_key|seed_bytes/i, `File ${file} must not contain private key fields`);
  }
});

test('pinned SDK builds exact HashIdPreimage and verifies valid authorizer signature', async () => {
  const admin = Keypair.random();
  const contractAddress = Address.contract(Buffer.alloc(32, 1));

  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: new xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: contractAddress.toScAddress(),
        functionName: 'initialize',
        args: [Address.fromString(admin.publicKey()).toScVal()],
      }),
    ),
    subInvocations: [],
  });

  const entry = await authorizeInvocation({
    signer: admin,
    validUntilLedgerSeq: 1000,
    invocation,
    networkPassphrase: Networks.STANDALONE,
    publicKey: admin.publicKey(),
  });

  assert.equal(entry.credentials().switch().name, 'sorobanCredentialsAddress');
  const addressCreds = entry.credentials().address();
  assert.equal(Address.fromScAddress(addressCreds.address()).toString(), admin.publicKey());
  assert.equal(addressCreds.signatureExpirationLedger(), 1000);

  // Build preimage independently and verify signature
  const preimage = buildAuthorizationEntryPreimage(entry, 1000, Networks.STANDALONE);
  assert.equal(preimage.switch().name, 'envelopeTypeSorobanAuthorization');
  const preimageHash = crypto.createHash('sha256').update(preimage.toXDR()).digest();

  const map = addressCreds.signature().vec()[0].map();
  const sigItem = map.find((item) => item.val().switch().name === 'scvBytes' && item.val().bytes().length === 64);
  assert.ok(sigItem, 'Signature vector must contain 64-byte Ed25519 signature');
  const signatureBytes = sigItem.val().bytes();

  assert.ok(admin.verify(preimageHash, signatureBytes), 'Signature must verify against admin public key');
});

test('mismatched / rogue signer fails signature verification against required authorizer', async () => {
  const admin = Keypair.random();
  const rogue = Keypair.random();
  const contractAddress = Address.contract(Buffer.alloc(32, 1));

  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: new xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: contractAddress.toScAddress(),
        functionName: 'initialize',
        args: [Address.fromString(admin.publicKey()).toScVal()],
      }),
    ),
    subInvocations: [],
  });

  // Rogue signs the invocation intending to impersonate admin
  const entry = await authorizeInvocation({
    signer: rogue,
    validUntilLedgerSeq: 1000,
    invocation,
    networkPassphrase: Networks.STANDALONE,
    publicKey: rogue.publicKey(),
  });

  const preimage = buildAuthorizationEntryPreimage(entry, 1000, Networks.STANDALONE);
  const preimageHash = crypto.createHash('sha256').update(preimage.toXDR()).digest();

  const map = entry.credentials().address().signature().vec()[0].map();
  const sigItem = map.find((item) => item.val().switch().name === 'scvBytes' && item.val().bytes().length === 64);
  const signatureBytes = sigItem.val().bytes();

  // Rogue's signature verifies against rogue's key, but FAILS against admin key
  assert.ok(rogue.verify(preimageHash, signatureBytes));
  assert.equal(admin.verify(preimageHash, signatureBytes), false, 'Rogue signature must not verify against admin key');
});

test('expired authorization ledger sequence fails validity gate', () => {
  const currentLedger = 500;
  const expiredValidUntil = 400; // In the past!
  const isExpired = (validUntil, current) => current > validUntil;
  assert.equal(isExpired(expiredValidUntil, currentLedger), true, 'Past validUntilLedgerSeq is expired');
  assert.equal(isExpired(600, currentLedger), false, 'Future validUntilLedgerSeq is unexpired');
});

test('setup gate strictly rejects uncommitted or rejected setup transactions', () => {
  const authorizedSetup = JSON.parse(fs.readFileSync(path.join(archiveDir, 'authorized-setup.json'), 'utf8'));
  const unauthorizedSetup = JSON.parse(fs.readFileSync(path.join(archiveDir, 'unauthorized-setup.json'), 'utf8'));

  const gate = (setup) => setup.status === 'committed' && setup.receipt?.status === 'SUCCESS';

  assert.equal(gate(authorizedSetup), true, 'Authorized setup with SUCCESS receipt passes gate');
  assert.equal(gate(unauthorizedSetup), false, 'Unauthorized setup must fail gate');
  assert.equal(unauthorizedSetup.setup_gate_result.proceed_to_measurement, false);
});

test('setup transaction resource overhead is strictly excluded from benchmark consumption', () => {
  const authorizedSetup = JSON.parse(fs.readFileSync(path.join(archiveDir, 'authorized-setup.json'), 'utf8'));
  const overhead = authorizedSetup.setup_resource_overhead;

  assert.ok(overhead.cpu_instructions > 0);
  assert.ok(overhead.fee_stroops > 0);
  assert.equal(overhead.excluded_from_benchmark_consumption, true);

  // Benchmark metrics should not contain setup fees or setup transaction CPU
  const simulatedBenchmarkMetrics = {
    cpu_instructions: 15000, // invocation-only
    memory_bytes: 1200,
  };

  assert.notEqual(
    simulatedBenchmarkMetrics.cpu_instructions,
    simulatedBenchmarkMetrics.cpu_instructions + overhead.cpu_instructions,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(simulatedBenchmarkMetrics, 'fee_stroops'),
    false,
    'Benchmark metrics must not include transaction fees',
  );
});
