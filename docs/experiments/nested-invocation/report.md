## 🔴 WeighIn Benchmark Report

**2 threshold violations** — comparing `nested-base` → `nested-h`

### ❌ Violations

- **`id:nested-invocation-suite / id:callee / work / id:work-once` / CPU Instructions**: cpu_instructions increased by 28882 (strict zero tolerance)
- **`id:nested-invocation-suite / id:caller / run / id:nested-work` / CPU Instructions**: cpu_instructions increased by 29329 (strict zero tolerance)

### Contract `id:nested-invocation-suite / id:callee`

Runtime addresses: BASE `CC4CPMMFFM46DREYMNFUZPUBMY7VL4NDBWQE2UEPSROBZI4WSGUJGX3X` → HEAD `CCLVGBBKV335I43BSSKHABHBJNC3BEUTNME343HTJFYFJ37QKLQULIHZ`

#### `work / id:work-once`

Compute source: soroban-simulation 28.0.1; protocol 28.

| | Metric | Base | Head | Delta | Change | Limit |
|---|---|---|---|---|---|---|
| 🔴 | CPU Instructions | 337,065 | 365,947 | +28,882 | +8.6% | 400,000,000 |
| 🔴 | Memory Bytes | 1,195,786 | 1,197,228 | +1,442 | +0.1% | 41,943,040 |
| 🔴 | Footprint Entries (RO + RW) | 3 | 4 | +1 | +33.3% | 400 |
| ⚪ | Disk Read Bytes | 0 | 0 | ±0 | — (BASE 0) | 200,000 |
| 🔴 | Write Footprint Entries | 1 | 2 | +1 | +100.0% | 200 |
| 🔴 | Ledger Write Bytes | 80 | 160 | +80 | +100.0% | 132,096 |
| ⚪ | Historical Read Bytes | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Contract Data (instance) | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Tx Size Bytes | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Successful Contract/System Events | 1 | 1 | ±0 | — | No independent limit |
| ⚪ | Events + Return XDR Bytes | 80 | 80 | ±0 | — | 16,384 |

- **Historical Read Bytes unavailable**: BASE: Protocol 28 exposes historical-data fees, not a historical read consumption resource; HEAD: Protocol 28 exposes historical-data fees, not a historical read consumption resource
- **Contract Data (instance) unavailable**: BASE: No verified instance-only post-invocation size and corresponding limit mapping; HEAD: No verified instance-only post-invocation size and corresponding limit mapping
- **Tx Size Bytes unavailable**: BASE: Simulation estimates a maximum envelope; no signed benchmark transaction is submitted; HEAD: Simulation estimates a maximum envelope; no signed benchmark transaction is submitted

<details><summary>Snapshot and metric provenance</summary>

Snapshot ledgers: BASE 21881 → HEAD 21915.
Compute config SHA256: BASE `5e0aaa432815c17b201e2eeb5591a85e2355d758dc9a3989e58d7319096cf6b5` → HEAD `5e0aaa432815c17b201e2eeb5591a85e2355d758dc9a3989e58d7319096cf6b5`.
Full config SHA256: BASE `bd48542edc490394acd0ee7e84f81e59a8be2484213853c451d0cfbfcec8352f` → HEAD `f7b0796316dca97513ba7358651c15788860c7dd9d7734dbc2cd4cb1608a2bd3`.
Resource limits SHA256: BASE `bd6ad7c9ae2afffe53a3d12e11fd45f0d74cd49b40be76a1ed10ace6b0f215a9` → HEAD `bd6ad7c9ae2afffe53a3d12e11fd45f0d74cd49b40be76a1ed10ace6b0f215a9`.
Helper SHA256: BASE `60e51c7b7f528e76d17e6fc285b7d2bbd0b14b967b0b58ffa8c4f55300ed64a7` → HEAD `60e51c7b7f528e76d17e6fc285b7d2bbd0b14b967b0b58ffa8c4f55300ed64a7`.
- **CPU Instructions** source: `soroban-simulation.simulated_instructions`; limit: `ConfigSettingContractComputeV0.txMaxInstructions`.
- **Memory Bytes** source: `soroban-simulation.simulated_memory`; limit: `ConfigSettingContractComputeV0.txMemoryLimit`.
- **Footprint Entries (RO + RW)** source: `SorobanResources.footprint.readOnly.length + readWrite.length`; limit: `ConfigSettingContractLedgerCostExtV0.txMaxFootprintEntries`.
- **Disk Read Bytes** source: `SorobanResources.diskReadBytes (identity adjustment)`; limit: `ConfigSettingContractLedgerCostV0.txMaxDiskReadBytes`.
- **Write Footprint Entries** source: `SorobanResources.footprint.readWrite.length`; limit: `ConfigSettingContractLedgerCostV0.txMaxWriteLedgerEntries`.
- **Ledger Write Bytes** source: `SorobanResources.writeBytes (identity adjustment)`; limit: `ConfigSettingContractLedgerCostV0.txMaxWriteBytes`.
- **Successful Contract/System Events** source: `successful non-diagnostic ContractEvents.length`; limit: Protocol 28 has no independent event-count cap.
- **Events + Return XDR Bytes** source: `sum(successful non-diagnostic ContractEvent XDR bytes) + return ScVal XDR bytes`; limit: `ConfigSettingContractEventsV0.txMaxContractEventsSizeBytes`.

</details>

### Contract `id:nested-invocation-suite / id:caller`

Runtime addresses: BASE `CDDW2K52YHC4IACBI3RMISKYZLURQUSGVP5KSCU2NRZQ5V6TYKP3YGGO` → HEAD `CDDW2K52YHC4IACBI3RMISKYZLURQUSGVP5KSCU2NRZQ5V6TYKP3YGGO`

#### `run / id:nested-work`

Compute source: soroban-simulation 28.0.1; protocol 28.

| | Metric | Base | Head | Delta | Change | Limit |
|---|---|---|---|---|---|---|
| 🔴 | CPU Instructions | 674,626 | 703,955 | +29,329 | +4.3% | 400,000,000 |
| 🔴 | Memory Bytes | 2,393,762 | 2,395,762 | +2,000 | +0.1% | 41,943,040 |
| 🔴 | Footprint Entries (RO + RW) | 6 | 7 | +1 | +16.7% | 400 |
| ⚪ | Disk Read Bytes | 0 | 0 | ±0 | — (BASE 0) | 200,000 |
| 🔴 | Write Footprint Entries | 2 | 3 | +1 | +50.0% | 200 |
| 🔴 | Ledger Write Bytes | 156 | 236 | +80 | +51.3% | 132,096 |
| ⚪ | Historical Read Bytes | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Contract Data (instance) | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Tx Size Bytes | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Successful Contract/System Events | 2 | 2 | ±0 | — | No independent limit |
| ⚪ | Events + Return XDR Bytes | 168 | 168 | ±0 | — | 16,384 |

- **Historical Read Bytes unavailable**: BASE: Protocol 28 exposes historical-data fees, not a historical read consumption resource; HEAD: Protocol 28 exposes historical-data fees, not a historical read consumption resource
- **Contract Data (instance) unavailable**: BASE: No verified instance-only post-invocation size and corresponding limit mapping; HEAD: No verified instance-only post-invocation size and corresponding limit mapping
- **Tx Size Bytes unavailable**: BASE: Simulation estimates a maximum envelope; no signed benchmark transaction is submitted; HEAD: Simulation estimates a maximum envelope; no signed benchmark transaction is submitted

<details><summary>Snapshot and metric provenance</summary>

Snapshot ledgers: BASE 21888 → HEAD 21917.
Compute config SHA256: BASE `5e0aaa432815c17b201e2eeb5591a85e2355d758dc9a3989e58d7319096cf6b5` → HEAD `5e0aaa432815c17b201e2eeb5591a85e2355d758dc9a3989e58d7319096cf6b5`.
Full config SHA256: BASE `f7b0796316dca97513ba7358651c15788860c7dd9d7734dbc2cd4cb1608a2bd3` → HEAD `f7b0796316dca97513ba7358651c15788860c7dd9d7734dbc2cd4cb1608a2bd3`.
Resource limits SHA256: BASE `bd6ad7c9ae2afffe53a3d12e11fd45f0d74cd49b40be76a1ed10ace6b0f215a9` → HEAD `bd6ad7c9ae2afffe53a3d12e11fd45f0d74cd49b40be76a1ed10ace6b0f215a9`.
Helper SHA256: BASE `60e51c7b7f528e76d17e6fc285b7d2bbd0b14b967b0b58ffa8c4f55300ed64a7` → HEAD `60e51c7b7f528e76d17e6fc285b7d2bbd0b14b967b0b58ffa8c4f55300ed64a7`.
- **CPU Instructions** source: `soroban-simulation.simulated_instructions`; limit: `ConfigSettingContractComputeV0.txMaxInstructions`.
- **Memory Bytes** source: `soroban-simulation.simulated_memory`; limit: `ConfigSettingContractComputeV0.txMemoryLimit`.
- **Footprint Entries (RO + RW)** source: `SorobanResources.footprint.readOnly.length + readWrite.length`; limit: `ConfigSettingContractLedgerCostExtV0.txMaxFootprintEntries`.
- **Disk Read Bytes** source: `SorobanResources.diskReadBytes (identity adjustment)`; limit: `ConfigSettingContractLedgerCostV0.txMaxDiskReadBytes`.
- **Write Footprint Entries** source: `SorobanResources.footprint.readWrite.length`; limit: `ConfigSettingContractLedgerCostV0.txMaxWriteLedgerEntries`.
- **Ledger Write Bytes** source: `SorobanResources.writeBytes (identity adjustment)`; limit: `ConfigSettingContractLedgerCostV0.txMaxWriteBytes`.
- **Successful Contract/System Events** source: `successful non-diagnostic ContractEvents.length`; limit: Protocol 28 has no independent event-count cap.
- **Events + Return XDR Bytes** source: `sum(successful non-diagnostic ContractEvent XDR bytes) + return ScVal XDR bytes`; limit: `ConfigSettingContractEventsV0.txMaxContractEventsSizeBytes`.

</details>

---

<details><summary>Known measurement gaps</summary>

- **Unavailable metrics** are shown explicitly; configured policies requiring them fail.
- **Compute** uses protocol-matched native simulation and captured network cost settings.
- **WASM build determinism**: cross-CI-run hash equality has not yet been verified
  in two separate GitHub Actions runs. Snapshot repeatability does not prove build repeatability.

</details>

<!-- weighin-report -->