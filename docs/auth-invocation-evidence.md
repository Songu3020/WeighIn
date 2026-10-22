# Authorization-Required Invocation Evidence (Schema 4)

This document and the retained evidence in [`docs/experiments/auth-invocation`](experiments/auth-invocation/) validate invocation measurement behavior for a Soroban smart contract function that requires explicit caller authorization via `caller.require_auth()`.

## Reference Contract Fixture

The reference contract fixture is located at `tests/fixtures/auth/contract`:
- **Source**: `tests/fixtures/auth/contract/src/lib.rs`
- **Manifest**: `tests/fixtures/auth/contract/Cargo.toml`
- **Fixture Specification**: `tests/fixtures/auth/auth-fixtures.json`

The function under test is `auth_call(caller: Address) -> Symbol`:

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

#[contract]
pub struct AuthContract;

#[contractimpl]
impl AuthContract {
    pub fn auth_call(_env: Env, caller: Address) -> Symbol {
        caller.require_auth();
        symbol_short!("authed")
    }
}
```

Unlike read-only getters without authorization, `auth_call` triggers Soroban's invocation authorization subsystem during host execution.

## Authorization Mode & Recording Semantics

In WeighIn's native simulation helper (`native/simulation/src/main.rs`), Soroban simulation executes with:

```rust
RecordingInvocationAuthMode::recording(true, true)
```

### Supported Recording Mode Behavior
1. **Recording Mode**: The Soroban host intercepts calls to `caller.require_auth()` and records the required authorization trees into the simulation result without requiring pre-signed cryptographic credentials or live secret keys.
2. **Transaction Data**: The simulated transaction data captures the required authorization entries (`soroban_auth`) alongside resource consumption:
   - CPU instructions consumed
   - Memory bytes consumed
   - Read-only and read-write footprint keys
   - Return value (`Symbol("authed")`)
3. **Parity**: The raw RPC simulation and the native helper (`soroban-simulation 28.0.1`) produce identical consumption and authorization trees under matching protocol 28 configuration.

### Fail-Closed Behavior on Incompatible Authorization
- Incompatible or malformed authorization parameters (e.g. invalid caller address, mismatched credential structure, or host auth failures) fail explicitly with host execution errors.
- WeighIn never substitutes simulated resource budgets, fallback values, or measured zero when authorization fails or cannot be validated.
- Failed simulations produce no benchmark results and exit with actionable diagnostic errors.

## Limitations & Boundaries

As bounded in [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md):
- **Recording Mode vs. Production Signed Authorization**: This validation proves the supported recording-mode simulation path used by RPC simulation and the native helper. It does **not** claim production signed authorization, multi-party threshold signatures, or arbitrary live mainnet wallet credentials.
- **Protocol 28 Scoping**: Tested on Stellar protocol 28 with a fixed 32-byte PRNG seed (`[0u8; 32]`) and standard network configuration.
- **Logical Identity**: Logical benchmark identity `(fixture_id, logical_id, function_name, case_id)` remains independent of runtime contract addresses and WASM hashes.
