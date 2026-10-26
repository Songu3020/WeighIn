# Controlled Ledger-Dependent Benchmark Variation Proof

This document and the archived evidence in [`docs/experiments/ledger-variation`](experiments/ledger-variation/) demonstrate how a contract whose execution path depends explicitly on ledger sequence and ledger timestamp exhibits deterministic, ledger-attributable resource variation across snapshots even when the invocation interface, contract source, compiled WASM artifact, runtime contract address, PRNG seed, and protocol cost calibration remain completely unchanged.

## Problem & Motivation

In the [clean-build and live measurement repeatability experiment](repeatability.md), seven benchmark cases were measured across advancing ledgers (833–1101) with zero resource range and zero standard deviation. Those results established that advancing ledger and configuration metadata alone does not introduce measurement noise into ledger-independent invocations.

However, as noted in [Known limitations](KNOWN_LIMITATIONS.md), **bounded repeatability on state/time-invariant fixtures does not imply arbitrary state or time independence**:
- Each invocation snapshot is immutable only for that single captured ledger (`measureInvocation` in [`src/simulation.ts`](../src/simulation.ts)).
- BASE and HEAD revisions—or repeated samples on an advancing standalone network—can be captured at different ledger sequences and timestamps.
- A contract that branches or loops on `env.ledger().sequence()` or `env.ledger().timestamp()` will execute different host instructions, touch different storage footprint keys, and return different values as the ledger progresses, even when the compiled WASM bytes are identical.

## Proof-Only Contract & Fixed Interface

The isolated proof fixture in [`tests/fixtures/ledger-variation/`](../tests/fixtures/ledger-variation/) keeps the exact reference invocation signature `hello(env: Env, to: Symbol) -> Vec<Symbol>` and argument `Symbol("world")` (`case_id: "id:world"`), while branching explicitly on ledger sequence and close time ([`source/contract/src/lib.rs`](experiments/ledger-variation/source/contract/src/lib.rs)):

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, vec, Env, Symbol, Vec};

#[contract]
pub struct HelloContract;

#[contractimpl]
impl HelloContract {
    pub fn hello(env: Env, to: Symbol) -> Vec<Symbol> {
        let sequence = env.ledger().sequence();
        let timestamp = env.ledger().timestamp();
        let mut out = vec![&env, symbol_short!("Hello"), to];
        if sequence >= 950 && timestamp >= 1_791_436_000 {
            let steps = (sequence - 950) / 25 + 1;
            env.storage()
                .persistent()
                .set(&symbol_short!("ledger"), &(sequence, timestamp));
            let mut index = 0u32;
            while index < steps {
                out.push_back(symbol_short!("tick"));
                index += 1;
            }
        }
        out
    }
}
```

### Invariant Controls

Across all five runs (`runs.json`), the following inputs are held strictly constant:
- **Source Snapshot SHA-256**: `b238e59e785d03a64f34e24e432dcd1d291d7e03261647aa8942bda39658fc99`
- **Compiled WASM SHA-256**: `87f52e776f2689bb00c0c163a7f402c984c322c4c644d5f511bd46f25817010a`
- **Runtime Contract ID**: `CCCJJJDJ5HS676PYT6DCMY4RJVOAQMUOWBG5OQBVYTXNLWOFX4UF2ZKJ`
- **Logical Identity**: `("id:ledger-variation-suite", "id:reference-contract", "hello", "id:world")`
- **Protocol & Calibration**: Protocol 28, `soroban-simulation 28.0.1`, compute config SHA-256 `5e0aaa432815c17b201e2eeb5591a85e2355d758dc9a3989e58d7319096cf6b5`, resource limits SHA-256 `bd6ad7c9ae2afffe53a3d12e11fd45f0d74cd49b40be76a1ed10ace6b0f215a9`
- **Auth & PRNG Seed**: `recording(true,true)`, host features `["recording_mode", "testutils"]`, fixed 32-byte zero seed (`[0; 32]`), no PRNG calls

## Controlled Standalone Ledger Progression & Observed Variation

The standalone ledger progression is stepped deterministically from ledger 900 to ledger 1000 ([`ledger-progression.json`](experiments/ledger-variation/ledger-progression.json) and [`metrics.csv`](experiments/ledger-variation/metrics.csv)):

| Run | Ledger | Timestamp | Branch Active | Steps | Return Value | CPU | Memory | RO+RW Entries | Disk Read Bytes | RW Entries | Write Bytes | Events | Events+Return Bytes |
|---:|---:|---:|:---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 900 | 1791435800 | `false` | 0 | `["Hello", "world"]` | 271,418 | 1,124,518 | 2 | 0 | 0 | 0 | 0 | 44 |
| 2 | 925 | 1791435925 | `false` | 0 | `["Hello", "world"]` | 271,418 | 1,124,518 | 2 | 0 | 0 | 0 | 0 | 44 |
| 3 | 950 | 1791436050 | `true` | 1 | `["Hello", "world", "tick"]` | 315,840 | 1,193,640 | 3 | 0 | 1 | 96 | 0 | 56 |
| 4 | 975 | 1791436175 | `true` | 2 | `["Hello", "world", "tick", "tick"]` | 320,112 | 1,194,408 | 3 | 0 | 1 | 96 | 0 | 68 |
| 5 | 1000 | 1791436300 | `true` | 3 | `["Hello", "world", "tick", "tick", "tick"]` | 324,384 | 1,195,176 | 3 | 0 | 1 | 96 | 0 | 80 |

Three unsupported metrics (`historical_data_read_bytes`, `contract_data_hard_limit`, `tx_size_bytes`) remain explicitly `unavailable` (`consumed: null`, `limit: null`) with their documented protocol reasons in every sample.

### Series Analysis (`analysis.json`)

Evaluating all five runs with `analyzeRepeatability` ([`analysis.json`](experiments/ledger-variation/analysis.json)) yields:
- `status`: `"REPEATABILITY_VARIATION_FOUND"`
- `reference.wasm_stable`: `true` (all 5 runs measure WASM `87f52e776f2689bb00c0c163a7f402c984c322c4c644d5f511bd46f25817010a`)
- `reference.metrics_stable`: `false`
  - `cpu_instructions`: min `271,418`, max `324,384`, range `52,966`
  - `memory_bytes`: min `1,124,518`, max `1,195,176`, range `70,658`
  - `ledger_read_entries`: min `2`, max `3`, range `1`
  - `ledger_write_entries`: min `0`, max `1`, range `1`
  - `ledger_write_bytes`: min `0`, max `96`, range `96`
  - `event_data_bytes`: min `44`, max `80`, range `36`

## Normal Diff & Policy Enforcement on Unchanged Artifacts

WeighIn evaluates resource regressions from measured consumption and provenance compatibility, never suppressing a regression or policy violation merely because the contract WASM hash or runtime address is unchanged:

1. **Pre-Threshold Bounded Control (`control-diff.json`)**:
   Comparing Run 1 (ledger 900) → Run 2 (ledger 925), where both snapshots precede the `sequence >= 950` branch condition, produces zero deltas across all 8 measured metrics (`hasRegression: false`) and zero threshold violations.
2. **Cross-Threshold Variation (`variation-diff.json` & `violations.json`)**:
   Comparing Run 1 (ledger 900) → Run 5 (ledger 1000) pairs the identical logical identity and unchanged `wasm_sha256` / `contract_id`, reports `hasRegression: true` (`CPU +52,966` / `+19.51%`, `memory +70,658`, `RO+RW entries +1`, `RW entries +1`, `write bytes +96`, `events+return bytes +36`), and enforces all **6 configured threshold violations** under [`weighin.toml`](experiments/ledger-variation/source/weighin.toml) (`strict_zero_tolerance` on `cpu_instructions` and `fail_on_any_regression` globally).

## Archived Evidence & Reproduction

The archive in [`docs/experiments/ledger-variation/`](experiments/ledger-variation/) retains:
- [`environment.json`](experiments/ledger-variation/environment.json): Toolchain, protocol, calibration hashes, and invariant controls.
- [`ledger-progression.json`](experiments/ledger-variation/ledger-progression.json) & [`metrics.csv`](experiments/ledger-variation/metrics.csv): Step-by-step ledger inputs, XDR return values, and measured metrics.
- [`runs.json`](experiments/ledger-variation/runs.json), [`rpc.json`](experiments/ledger-variation/rpc.json), & [`native.json`](experiments/ledger-variation/native.json): Full schema-4 measurement records, raw RPC simulation responses, and native simulation inputs/outputs.
- [`analysis.json`](experiments/ledger-variation/analysis.json): Repeatability series statistics showing `REPEATABILITY_VARIATION_FOUND` with `wasm_stable: true`.
- [`control-diff.json`](experiments/ledger-variation/control-diff.json), [`variation-diff.json`](experiments/ledger-variation/variation-diff.json), [`policy.json`](experiments/ledger-variation/policy.json), [`violations.json`](experiments/ledger-variation/violations.json), & [`summary.md`](experiments/ledger-variation/summary.md): Diff, policy evaluation, and rendered markdown report.
- [`verification.json`](experiments/ledger-variation/verification.json) & [`sha256.json`](experiments/ledger-variation/sha256.json): Verification record and SHA-256 manifest verified by [`tests/ledger-variation.test.cjs`](../tests/ledger-variation.test.cjs).

The archived `summary.md` is retained historical evidence: it is the report the
renderer of this experiment revision produced, and its bytes and recorded
SHA-256 are never rewritten. Because the renderer later moved its provenance
block into a `<details>` section and expanded it, the verification compares the
archived report on the facts it states — metric rows, violations, unavailable
reasons, metric sources and the recorded ledger endpoints and digests — instead
of on byte equality with the current renderer.

To regenerate and verify the controlled experiment archive:

```bash
npm run build
node tests/experiments/verify-ledger-variation.cjs /tmp/weighin-ledger-variation
node --test tests/ledger-variation.test.cjs tests/repeatability-evidence.test.cjs
```
