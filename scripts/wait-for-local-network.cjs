// Readiness for the repository's pinned standalone sidecar, not a general network provisioner.
const { Keypair, xdr } = require('@stellar/stellar-sdk');
const { ensureAccountReady } = require('../dist/account');
const rpcUrl = process.argv[2] || 'http://localhost:8000/rpc';
const computeKey = xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({
  configSettingId: xdr.ConfigSettingId.configSettingContractComputeV0(),
})).toXDR('base64');
async function waitForComputeConfig(deadline) {
  let lastError = 'ContractComputeV0 is not present in the RPC snapshot';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getLedgerEntries', params: { keys: [computeKey] } }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(4000, deadline - Date.now()))) });
      const json = await response.json();
      if (response.ok && !json.error && json.result?.entries?.some(entry => entry.key === computeKey)) return;
      lastError = `ContractComputeV0 is not present in the RPC snapshot: ${JSON.stringify(json)}`;
    } catch (error) { lastError = error.message; }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(2000, remaining)));
  }
  throw new Error(`Soroban configuration readiness failed within 120s: ${lastError}`);
}
async function main() {
  const deadline = Date.now() + 120000;
  let lastError = 'RPC has not reported healthy', healthy = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(4000, deadline - Date.now()))) });
      const json = await response.json();
      if (response.ok && json.result?.status === 'healthy' && !json.error) { healthy = true; break; }
      lastError = `RPC health HTTP ${response.status}: ${JSON.stringify(json)}`;
    } catch (error) { lastError = error.message; }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(2000, remaining)));
  }
  if (!healthy) throw new Error(`RPC readiness failed within 120s: ${lastError}`);
  console.log('RPC reports healthy; checking real Friendbot funding and RPC account inclusion...');
  // Only the disposable public key is used; no seed is saved or logged.
  await ensureAccountReady(rpcUrl, Keypair.random().publicKey());
  await waitForComputeConfig(deadline);
  console.log('Stellar Quickstart local network is ready for account funding and RPC reads.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
