# Distinct Benchmark Contracts Control Proof

This document describes the hosted unchanged control proof for two genuinely distinct benchmarked contracts with overlapping function and case labels, explicit logical identities, and verified resource parity.

## Overview

Existing tests and earlier experiments validated multiple benchmark declarations, but often used the same compiled WASM artifact under different logical IDs or paths. This experiment provides proof that:

1. Two genuinely distinct contract WASMs with overlapping function and case names (`hello` / `id:world`) are benchmarked side-by-side.
2. Explicit logical identities (`id:contract-alpha` and `id:contract-beta`) ensure unambiguous pairing across BASE and HEAD revisions.
3. Neither contract accidentally cross-pairs with the other, even though they share the identical function and invocation case label.
4. All 8 comparable resource metrics exhibit zero deltas in an unchanged control.
5. Verifier rejection tests fail closed when identities are swapped, contracts are missing, or control deltas are non-zero.
6. This setup evaluates independent deployed contracts and is distinct from inter-contract caller/callee stateful execution, which is covered by the [nested invocation attribution proof](nested-invocation.md).

## Declared Contracts and Identities

Configured in [`tests/fixtures/distinct-contracts/distinct-fixtures.json`](../tests/fixtures/distinct-contracts/distinct-fixtures.json):

| Contract | Logical ID | WASM SHA-256 | Deployed Address | Function | Case ID | Base CPU | Head CPU | Delta |
|---|---|---|---|---|---|---:|---:|---:|
| Alpha | `id:contract-alpha` | `718ba183...` | `CD2A22Z...` | `hello` | `id:world` | 266,842 | 266,842 | 0 |
| Beta | `id:contract-beta` | `a82f349c...` | `CBTG57U...` | `hello` | `id:world` | 328,450 | 328,450 | 0 |

## Evidence and Verification

Sanitized records and verification metadata are preserved in [`docs/experiments/distinct-contracts-control/`](experiments/distinct-contracts-control/):

- `diff.json`: Structural diff output asserting 2 matched contracts, 0 regressions, and no added or removed contracts.
- `verification.json`: Audit proof asserting `status: VERIFIED`, `action_exit: 0`, matching build hashes, and `inter_contract_stateful_call: false`.
- `rpc.json` & `native.json`: Sanitized simulation records confirming return parity and agreement with native execution.
- `sha256.json`: Cryptographic integrity manifest for all proof artifacts.

## Automated Verification

Automated behavior and verifier rejection tests are implemented in [`tests/distinct-contracts-control.test.cjs`](../tests/distinct-contracts-control.test.cjs).
