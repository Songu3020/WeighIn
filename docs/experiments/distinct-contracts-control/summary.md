## 🟢 WeighIn Benchmark Report

**All thresholds passed** — comparing `main` → `082f8918`

### Contract `id:distinct-contracts-suite / id:contract-alpha`

Runtime addresses: BASE `CD2A22ZSCFXNQ3KDJAOISADM55GPV4NKQPMKCOWUVPVSDZ25DJ3G2DQN` → HEAD `CD2A22ZSCFXNQ3KDJAOISADM55GPV4NKQPMKCOWUVPVSDZ25DJ3G2DQN`

#### `hello / id:world`

| | Metric | Base | Head | Delta | Change | Limit |
|---|---|---|---|---|---|---|
| ⚪ | CPU Instructions | 266,842 | 266,842 | ±0 | — | 400,000,000 |
| ⚪ | Memory Bytes | 2,048 | 2,048 | ±0 | — | 41,943,040 |
| ⚪ | Footprint Entries (RO + RW) | 2 | 2 | ±0 | — | 40 |
| ⚪ | Disk Read Bytes | 512 | 512 | ±0 | — | 200,000 |
| ⚪ | Write Footprint Entries | 0 | 0 | ±0 | — | 25 |
| ⚪ | Ledger Write Bytes | 0 | 0 | ±0 | — | 132,096 |
| ⚪ | Historical Read Bytes | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Contract Data (instance) | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Tx Size Bytes | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Successful Contract/System Events | 0 | 0 | ±0 | — | 100 |
| ⚪ | Events + Return XDR Bytes | 32 | 32 | ±0 | — | 16,384 |

- **Historical Read Bytes unavailable**: Resource metric not available from Soroban simulation
- **Contract Data (instance) unavailable**: Resource metric not available from Soroban simulation
- **Tx Size Bytes unavailable**: Resource metric not available from Soroban simulation
- **CPU Instructions** source: `soroban-simulation.simulated_instructions`; limit: `ConfigSettingContractComputeV0.txMaxInstructions`.
- **Memory Bytes** source: `soroban-simulation.simulated_memory_bytes`; limit: `ConfigSettingContractComputeV0.txMemoryLimit`.
- **Footprint Entries (RO + RW)** source: `soroban-simulation.footprint.read_only.len + read_write.len`; limit: `ConfigSettingContractLedgerCostExtV0.txMaxFootprintEntries`.
- **Disk Read Bytes** source: `soroban-simulation.resources.disk_read_bytes`; limit: `ConfigSettingContractLedgerCostV0.txMaxDiskReadBytes`.
- **Write Footprint Entries** source: `soroban-simulation.footprint.read_write.len`; limit: `ConfigSettingContractLedgerCostV0.txMaxWriteLedgerEntries`.
- **Ledger Write Bytes** source: `soroban-simulation.resources.write_bytes`; limit: `ConfigSettingContractLedgerCostV0.txMaxWriteBytes`.
- **Successful Contract/System Events** source: `soroban-simulation.contract_events.len`; limit: `ConfigSettingContractEventsV0.txMaxContractEventsSizeBytes`.
- **Events + Return XDR Bytes** source: `soroban-simulation.event_and_return_bytes`; limit: `ConfigSettingContractEventsV0.txMaxContractEventsSizeBytes`.

### Contract `id:distinct-contracts-suite / id:contract-beta`

Runtime addresses: BASE `CBTG57UJJ5667XNJW7G2J3Z7S6Q4EZZJ5E763BOCB4J3V3W2PQJ7Z36B` → HEAD `CBTG57UJJ5667XNJW7G2J3Z7S6Q4EZZJ5E763BOCB4J3V3W2PQJ7Z36B`

#### `hello / id:world`

| | Metric | Base | Head | Delta | Change | Limit |
|---|---|---|---|---|---|---|
| ⚪ | CPU Instructions | 328,450 | 328,450 | ±0 | — | 400,000,000 |
| ⚪ | Memory Bytes | 3,072 | 3,072 | ±0 | — | 41,943,040 |
| ⚪ | Footprint Entries (RO + RW) | 3 | 3 | ±0 | — | 40 |
| ⚪ | Disk Read Bytes | 640 | 640 | ±0 | — | 200,000 |
| ⚪ | Write Footprint Entries | 1 | 1 | ±0 | — | 25 |
| ⚪ | Ledger Write Bytes | 88 | 88 | ±0 | — | 132,096 |
| ⚪ | Historical Read Bytes | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Contract Data (instance) | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Tx Size Bytes | Unavailable | Unavailable | Unavailable | — | Unavailable |
| ⚪ | Successful Contract/System Events | 1 | 1 | ±0 | — | 100 |
| ⚪ | Events + Return XDR Bytes | 64 | 64 | ±0 | — | 16,384 |

- **Historical Read Bytes unavailable**: Resource metric not available from Soroban simulation
- **Contract Data (instance) unavailable**: Resource metric not available from Soroban simulation
- **Tx Size Bytes unavailable**: Resource metric not available from Soroban simulation
- **CPU Instructions** source: `soroban-simulation.simulated_instructions`; limit: `ConfigSettingContractComputeV0.txMaxInstructions`.
- **Memory Bytes** source: `soroban-simulation.simulated_memory_bytes`; limit: `ConfigSettingContractComputeV0.txMemoryLimit`.
- **Footprint Entries (RO + RW)** source: `soroban-simulation.footprint.read_only.len + read_write.len`; limit: `ConfigSettingContractLedgerCostExtV0.txMaxFootprintEntries`.
- **Disk Read Bytes** source: `soroban-simulation.resources.disk_read_bytes`; limit: `ConfigSettingContractLedgerCostV0.txMaxDiskReadBytes`.
- **Write Footprint Entries** source: `soroban-simulation.footprint.read_write.len`; limit: `ConfigSettingContractLedgerCostV0.txMaxWriteLedgerEntries`.
- **Ledger Write Bytes** source: `soroban-simulation.resources.write_bytes`; limit: `ConfigSettingContractLedgerCostV0.txMaxWriteBytes`.
- **Successful Contract/System Events** source: `soroban-simulation.contract_events.len`; limit: `ConfigSettingContractEventsV0.txMaxContractEventsSizeBytes`.
- **Events + Return XDR Bytes** source: `soroban-simulation.event_and_return_bytes`; limit: `ConfigSettingContractEventsV0.txMaxContractEventsSizeBytes`.

---

<details><summary>Known measurement gaps</summary>

- **Unavailable metrics** are shown explicitly; configured policies requiring them fail.
- **Compute** uses protocol-matched native simulation and captured network cost settings.
- **WASM build determinism**: cross-CI-run hash equality has not yet been verified
  in two separate GitHub Actions runs. Snapshot repeatability does not prove build repeatability.

</details>

<!-- weighin-report -->