## 🔴 WeighIn Benchmark Report

**6 threshold violations** — comparing `ledger-900` → `ledger-1`

### ❌ Violations

- **`id:ledger-variation-suite / id:reference-contract / hello / id:world` / CPU Instructions**: cpu_instructions increased by 52966 (strict zero tolerance)
- **`id:ledger-variation-suite / id:reference-contract / hello / id:world` / Events + Return XDR Bytes**: event_data_bytes increased by 36 (fail_on_any_regression)
- **`id:ledger-variation-suite / id:reference-contract / hello / id:world` / Footprint Entries (RO + RW)**: ledger_read_entries increased by 1 (fail_on_any_regression)
- **`id:ledger-variation-suite / id:reference-contract / hello / id:world` / Ledger Write Bytes**: ledger_write_bytes increased by 96 (fail_on_any_regression)
- **`id:ledger-variation-suite / id:reference-contract / hello / id:world` / Write Footprint Entries**: ledger_write_entries increased by 1 (fail_on_any_regression)
- **`id:ledger-variation-suite / id:reference-contract / hello / id:world` / Memory Bytes**: memory_bytes increased by 70658 (fail_on_any_regression)

### Contract `id:ledger-variation-suite / id:reference-contract`

Runtime addresses: BASE `CCCJJJDJ5HS676PYT6DCMY4RJVOAQMUOWBG5OQBVYTXNLWOFX4UF2ZKJ` → HEAD `CCCJJJDJ5HS676PYT6DCMY4RJVOAQMUOWBG5OQBVYTXNLWOFX4UF2ZKJ`

#### `hello / id:world`

Compute source: soroban-simulation 28.0.1; protocol 28.
Snapshot ledgers: BASE 900 → HEAD 1000; compute config SHA256: `5e0aaa432815c17b201e2eeb5591a85e2355d758dc9a3989e58d7319096cf6b5`.
Full config SHA256: BASE `418969f287f51a60016ba316743bdb608fcd9f975c93f6e9cb1b7c2025dcc5eb` → HEAD `1ad75eb2419dea0958f9f52e4ae92ee4a60d0bb0ca18bb9e77da3e8daf85691a`.
Resource limits SHA256: `bd6ad7c9ae2afffe53a3d12e11fd45f0d74cd49b40be76a1ed10ace6b0f215a9`.

| | Metric | Base | Head | Delta | Change | Limit |
|---|---|---|---|---|---|---|
| 🔴 | CPU Instructions | 271,418 | 324,384 | +52,966 | +19.5% | 400,000,000 |
| 🔴 | Memory Bytes | 1,124,518 | 1,195,176 | +70,658 | +6.3% | 41,943,040 |
| 🔴 | Footprint Entries (RO + RW) | 2 | 3 | +1 | +50.0% | 400 |
| ⚪ | Disk Read Bytes | 0 | 0 | ±0 | — (BASE 0) | 200,000 |
| 🔴 | Write Footprint Entries | 0 | 1 | +1 | — (BASE 0) | 200 |
| 🔴 | Ledger Write Bytes | 0 | 96 | +96 | — (BASE 0) | 132,096 |
| ⚪ | Historical Read Bytes | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Contract Data (instance) | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Tx Size Bytes | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Successful Contract/System Events | 0 | 0 | ±0 | — (BASE 0) | No independent limit |
| 🔴 | Events + Return XDR Bytes | 44 | 80 | +36 | +81.8% | 16,384 |

- **Historical Read Bytes unavailable**: BASE: Protocol 28 exposes historical-data fees, not a historical read consumption resource; HEAD: Protocol 28 exposes historical-data fees, not a historical read consumption resource
- **Contract Data (instance) unavailable**: BASE: No verified instance-only post-invocation size and corresponding limit mapping; HEAD: No verified instance-only post-invocation size and corresponding limit mapping
- **Tx Size Bytes unavailable**: BASE: Simulation estimates a maximum envelope; no signed benchmark transaction is submitted; HEAD: Simulation estimates a maximum envelope; no signed benchmark transaction is submitted
- **CPU Instructions** source: `soroban-simulation.simulated_instructions`; limit: `ConfigSettingContractComputeV0.txMaxInstructions`.
- **Memory Bytes** source: `soroban-simulation.simulated_memory`; limit: `ConfigSettingContractComputeV0.txMemoryLimit`.
- **Footprint Entries (RO + RW)** source: `SorobanResources.footprint.readOnly.length + readWrite.length`; limit: `ConfigSettingContractLedgerCostExtV0.txMaxFootprintEntries`.
- **Disk Read Bytes** source: `SorobanResources.diskReadBytes (identity adjustment)`; limit: `ConfigSettingContractLedgerCostV0.txMaxDiskReadBytes`.
- **Write Footprint Entries** source: `SorobanResources.footprint.readWrite.length`; limit: `ConfigSettingContractLedgerCostV0.txMaxWriteLedgerEntries`.
- **Ledger Write Bytes** source: `SorobanResources.writeBytes (identity adjustment)`; limit: `ConfigSettingContractLedgerCostV0.txMaxWriteBytes`.
- **Successful Contract/System Events** source: `successful non-diagnostic ContractEvents.length`; limit: Protocol 28 has no independent event-count cap.
- **Events + Return XDR Bytes** source: `sum(successful non-diagnostic ContractEvent XDR bytes) + return ScVal XDR bytes`; limit: `ConfigSettingContractEventsV0.txMaxContractEventsSizeBytes`.

---

<details><summary>Known measurement gaps</summary>

- **Unavailable metrics** are shown explicitly; configured policies requiring them fail.
- **Compute** uses protocol-matched native simulation and captured network cost settings.
- **WASM build determinism**: cross-CI-run hash equality has not yet been verified
  in two separate GitHub Actions runs. Snapshot repeatability does not prove build repeatability.

</details>

<!-- weighin-report -->