# Hosted Runner Stability Validation (Schema 4)

This document and the retained evidence in [`docs/experiments/runner-stability`](experiments/runner-stability/) validate measurement stability across supported GitHub Actions Linux x64 hosted runner environments.

## Supported Hosted Runner Images

WeighIn officially supports Linux x64 GitHub Actions runners:
1. **`ubuntu-24.04`** (Noble Numbat):
   - Linux kernel 6.8, glibc 2.39, architecture x86_64.
2. **`ubuntu-22.04`** (Jammy Jellyfish):
   - Linux kernel 5.15, glibc 2.35, architecture x86_64.

### Toolchain & Native Helper Compatibility Rationale

- **Pinned Rust Toolchain**: Built with Rust 1.95.0 targeting `x86_64-unknown-linux-gnu`.
- **glibc Compatibility**: The native helper binary is dynamically linked against GNU libc with symbol compatibility targeting glibc <= 2.35. Because glibc provides backward compatibility, binaries running on `ubuntu-22.04` run identically on `ubuntu-24.04`.
- **Host-Independent Compute Accounting**: Soroban CPU instructions and memory consumption are computed in WebAssembly via `soroban-simulation 28.0.1` and `soroban-env-host 28.0.1`. They measure abstract protocol cost-model units rather than host CPU cycles, clock frequencies, or physical RAM allocations. Thus, measurement is fully decoupled from host hardware variances.
- **Isolated Snapshot Invocations**: Native simulation executes against in-memory snapshot state, eliminating local filesystem or OS caching side-effects.

## Experimental Controls & Invariant Inputs

All experiment inputs were held strictly invariant across runs on both runner images:
- **Contract Source & WASM**: `contract/src/lib.rs`, build hash held identical.
- **Protocol**: Stellar protocol 28.
- **Host Features**: `recording_mode`, `testutils`.
- **Authorization Mode**: `recording(true,true)`.
- **PRNG Seed**: Fixed 32-byte zero seed (`[0u8; 32]`).
- **Cost Configuration**: Protocol 28 network configuration parameters.

## Sample Collection & Results

Five repeated clean samples were captured on each runner image (10 total samples across `ubuntu-24.04` and `ubuntu-22.04`).

### Per-Metric Observed Values & Stability

| Metric | `ubuntu-24.04` (5 runs) | `ubuntu-22.04` (5 runs) | Range / Drift | Status |
|---|---|---|---|---|
| `cpu_instructions_consumed` | 266,842 | 266,842 | 0 | Measured (Deterministic) |
| `memory_bytes_consumed` | 2,048 | 2,048 | 0 | Measured (Deterministic) |
| `disk_read_bytes` | 2,400 | 2,400 | 0 | Measured (Deterministic) |
| `write_bytes` | 0 | 0 | 0 | Measured (Zero) |
| `read_only_keys` | 2 | 2 | 0 | Measured (Deterministic) |
| `read_write_keys` | 0 | 0 | 0 | Measured (Zero) |
| `historical_data_read_bytes` | `null` | `null` | N/A | Unavailable (Explicit null) |
| `contract_data_hard_limit` | `null` | `null` | N/A | Unavailable (Explicit null) |
| `tx_size_bytes` | `null` | `null` | N/A | Unavailable (Explicit null) |

### Strict Environmental Compatibility Policy

- **No Averaging Across Divergent Environments**: WeighIn strictly rejects averaging or aggregating benchmark metrics across incompatible runner environments, different CPU architectures, or mismatched calibration versions.
- **Explicit Unavailable State**: Unsupported metrics remain explicitly `null` with their documented reasons. They are never coerced or averaged to zero.
- **Deterministic Delta**: On supported Linux x64 runners with identical input WASM and snapshot state, the observed delta between `ubuntu-24.04` and `ubuntu-22.04` is exactly zero for all measured metrics.

## Retained Evidence Artifacts

The experiment directory [`docs/experiments/runner-stability`](experiments/runner-stability/) preserves:
- `matrix.json`: Detailed runner specifications and toolchain versions.
- `samples.json`: Complete per-runner measurement sample runs.
- `analysis.json`: Statistical breakdown confirming zero variance across deterministic metrics.
- `verification.json`: Proof summary and verification status.
- `sha256.json`: Checksums for all experiment artifacts.
