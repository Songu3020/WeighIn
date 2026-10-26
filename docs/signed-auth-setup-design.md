# Assessment: Signed Authorization for Committed Fixture Setup

This document is the authorization feasibility and security design deliverable for **Issue #58**. It assesses and defines the architecture, compatibility model, smallest safely supported authorization modes, and security constraints for signed transactions in committed fixture setups, building upon the accepted setup isolation model in **#39**.

---

## 1. Problem Statement & Motivation

WeighIn's native simulation helper (`native/simulation/src/main.rs`) and RPC simulation evaluate invocation authorization using recording mode:
```rust
RecordingInvocationAuthMode::recording(true, true)
```

Recording mode permits the Soroban host to intercept `require_auth()` calls and record the required authorization trees into the simulation output without verifying cryptographic signatures. While sufficient for simulating read-only and uncommitted invocation costs, **recording mode does not prove signed authorization or transaction commitment on a ledger**.

Committed fixture setups (defined in #39) require actual on-chain transaction execution prior to benchmark measurement (e.g., initializing contract configuration, setting up administrative roles, or seeding state). If a setup operation invokes a contract function protected by `require_auth()`, the setup transaction must be cryptographically signed and confirmed on-chain.

This design assesses how to safely reconcile signed authorization with WeighIn's disposable environment model, dynamic credentials, and strict resource isolation boundaries.

---

## 2. Setup Lifecycle & Resource Boundary (#39 Alignment)

Committed setup is strictly separated from benchmark measurement in both lifecycle and resource accounting:

```
+-------------------------------------------------------------------------+
|                          1. SETUP PHASE                                 |
|                                                                         |
|  [Generate Ephemeral Signers]                                           |
|             │                                                           |
|             ▼                                                           |
|  [WASM Upload & Instance Creation] (Signed by Deployer)                 |
|             │                                                           |
|             ▼                                                           |
|  [Execute Setup Invocation with require_auth]                           |
|             │                                                           |
|             ├── Prepare via RPC (capture authorization tree)            |
|             ├── Cryptographically sign authorization entry              |
|             └── Submit & Confirm on Standalone Ledger                   |
|             │                                                           |
|             ▼                                                           |
|  [Verify Storage State & Emit "committed" Setup Receipt]                |
+-------------------------------------------------------------------------+
                                    │
               (Resource boundary: setup costs excluded)
                                    │
                                    ▼
+-------------------------------------------------------------------------+
|                      2. BENCHMARK MEASUREMENT                           |
|                                                                         |
|  [Simulate Measured Invocation against Committed State Snapshot]        |
|  - Consumed CPU instructions                                            |
|  - Consumed Memory bytes                                                |
|  - Audited Footprint & Event resources                                  |
+-------------------------------------------------------------------------+
```

### Strict Resource Isolation

- **Setup transactions consume real ledger resources**: Network transaction fees, sequence numbers, host CPU instructions, and ledger footprint changes.
- **Strict exclusion from benchmarks**: All setup resource overhead (signing costs, transaction fees, deployer funding, and setup host execution) is captured in `setup_receipts.resources` and **strictly excluded** from reported benchmark consumption.
- Setup failure (unauthorized signer, network timeout, rejection) halts the run with an incomplete scenario error; no benchmarks are recorded.

---

## 3. Pinned SDK & RPC Authorization Mechanics

Inspection of the pinned `@stellar/stellar-sdk` (v16.0.1) and protocol 28 RPC reveals how Soroban authorization entries are prepared and submitted:

### Authorization Entry Hierarchy

A Soroban invocation transaction carries authorization entries in its `InvokeHostFunctionOp`:

```typescript
xdr.SorobanAuthorizationEntry {
  credentials: xdr.SorobanCredentials,
  rootInvocation: xdr.SorobanAuthorizedInvocation
}
```

The `credentials` union determines how authorization is validated:
1. `sorobanCredentialsSourceAccount`: The authorizer is the source account of the transaction envelope.
2. `sorobanCredentialsAddress`: The authorizer is an account or contract address. Contains nonce, signature expiration ledger, and signature payload.
3. `sorobanCredentialsAddressV2` / `sorobanCredentialsAddressWithDelegates`: Protocol 29+ delegation models.

### Preparation Flow via RPC

When `server.prepareTransaction(tx)` is called on a transaction invoking a function with `require_auth()`:
1. RPC simulates execution with recording mode enabled.
2. RPC populates `tx.operations[0].auth` with the discovered authorization trees.
3. If the authorizer matches the transaction's source account, RPC sets `sorobanCredentialsSourceAccount`.
4. If the authorizer is a distinct address, RPC produces `sorobanCredentialsAddress` with a blank signature, requiring caller cryptographic authorization before network submission.

---

## 4. Smallest Safely Supported Authorization Modes

To balance validation rigor against operational risk, WeighIn defines the following boundary:

### Supported Modes

| Mode | Credentials Union | Signing Mechanism | Supported Use Case |
|---|---|---|---|
| **`SourceAccountAuth`** | `sorobanCredentialsSourceAccount` | Transaction envelope signature | Setup calls where authorizer is the scenario deployer |
| **`AddressAccountAuth`** | `sorobanCredentialsAddress` (Ed25519) | `buildAuthorizationEntryPreimage` signed by in-memory `Keypair` | Multi-account setup (e.g. distinct admin or participant accounts) |

#### 1. `SourceAccountAuth`
The simplest and most secure mode: when the contract's `require_auth()` expects the deployer/sponsor account address, the transaction envelope signature automatically satisfies the requirement without secondary signature payloads.

#### 2. `AddressAccountAuth`
When a setup function requires authorization from a separate account address:
- An ephemeral Ed25519 `Keypair` is created in memory for the scenario.
- An authorization preimage is generated:
  ```typescript
  const preimage = buildAuthorizationEntryPreimage(entry, validUntilLedgerSeq, networkPassphrase);
  const hash = crypto.createHash("sha256").update(preimage.toXDR()).digest();
  const signature = signer.sign(hash);
  ```
- The entry is signed using `authorizeEntry` / `authorizeInvocation` before submission.
- **Nonce handling**: Nonce is queried from the account's sequence/auth ledger state.
- **Expiration handling**: `validUntilLedgerSeq` is bounded to `current_ledger + 100` to prevent stale authorization retention.

### Explicitly Unsupported Modes

The following auth modes are **unsupported** in WeighIn committed fixture setup:
- **ContractAuth (Smart Wallets)**: Custom smart-contract accounts that implement custom `__check_auth` logic. These introduce dynamic, recursive execution trees during verification.
- **Multisig / Threshold Signing**: Multi-party schemes requiring asynchronous coordination or distributed key management.
- **Delegated Credentials (`AddressWithDelegates`)**: Complex multi-hop delegation chains.
- **Production Wallets & Remote Signing**: Hardware wallets (Ledger/Trezor), browser extension signers, or external KMS endpoints. All signers must be owned, disposable, and local.

---

## 5. Security Invariants & Credential Protection

1. **No Committed Credentials**: Secret keys (`S...`) are never written to disk, included in evidence archives, committed to git, or exposed in logs.
2. **Ephemeral In-Memory Signers**: All setup keys are generated dynamically in RAM within the disposable runner process.
3. **Evidence Sanitization**: Evidence bundles record only:
   - Public account keys (`G...`)
   - Contract addresses (`C...`)
   - Nonce values and expiration ledger sequences
   - SHA-256 hashes of signature bytes and preimage payloads
   - Transaction hashes and inclusion ledger numbers
4. **Independent BASE and HEAD State**: BASE and HEAD fixture setups execute in completely isolated disposable network environments with independent deployer keypairs and salts. State is never copied or shared.

---

## 6. Evidenced Rejection of Unauthorized Setup

Stellar protocol 28 enforces fail-closed authorization verification:

- **Missing Auth**: Submitting a transaction without the required `SorobanAuthorizationEntry` fails immediately during host execution:
  `HostError: Error(Auth, InvalidAction)`.
- **Mismatched / Rogue Signer**: If an authorization entry for Account `A` is signed by a different keypair `B`, signature verification fails:
  `HostError: Error(Auth, BadSignature)` or transaction status `ERROR`.
- **Expired Authorization**: If `validUntilLedgerSeq` is less than the current ledger sequence, the transaction is rejected:
  `HostError: Error(Auth, Expired)`.
- **Replayed Nonce**: Reusing an authorization nonce fails with sequence error.

Because the #39 setup gate strictly requires a confirmed, successful transaction receipt (`status === "committed"`), **any unauthorized, mismatched, or expired setup transaction cannot produce a valid setup receipt and halts evaluation**.

---

## 7. Retained Captures & Walkthrough

The feasibility proof and verifiable evidence are preserved in [`docs/experiments/signed-auth-setup/`](experiments/signed-auth-setup/):

- [`authorized-setup.json`](experiments/signed-auth-setup/authorized-setup.json): Sanitized capture of a committed setup transaction calling `initialize(admin: Address)` with valid `AddressAccountAuth`, verified inclusion ledger, and initialized storage receipt.
- [`unauthorized-setup.json`](experiments/signed-auth-setup/unauthorized-setup.json): Evidenced rejection showing a mismatched signer failing with explicit `HostError(Error(Auth, BadSignature))` and transaction status `ERROR`.
- [`verification.json`](experiments/signed-auth-setup/verification.json): Formal validation report recording schema version, protocol 28 identity, supported/unsupported auth modes, and security constraints.
- [`sha256.json`](experiments/signed-auth-setup/sha256.json): Checksums of all evidence files.

The accompanying behavior tests in `tests/signed-auth-setup.test.cjs` verify:
1. Pinned SDK `buildAuthorizationEntryPreimage` and `authorizeInvocation` parity.
2. Valid signature verification and rogue signer failure.
3. Receipt gate integrity: only `status: "committed"` proceeds to measurement.
4. Complete exclusion of setup transaction resources from benchmark consumption.
