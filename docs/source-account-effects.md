# Source-account effects

WeighIn can measure one contract case under several source accounts while
everything else stays fixed, and it states whether the measured results stay
comparable across those accounts. The source account is the account that
invokes the measured contract call. It selects the invoking identity of a
simulated call; no key material is needed, held or submitted.

The controlled proof of this capability is retained in
[experiments/source-account-effects](experiments/source-account-effects/): three
valid accounts, one contract case, fixed arguments, fixed protocol, fixed
calibration and fixed resource limits.

## What the measurement holds fixed

| Held fixed | Recorded in | Source |
|---|---|---|
| Contract code | `wasm_sha256` | SHA256 of the measured WASM artifact |
| Contract arguments and case | `function_name`, `case_id` | The fixture case, identical for every variant |
| Invoked host function | `host_function_sha256` | SHA256 of the invoked host function XDR |
| Protocol | `protocol` | Captured ledger protocol version |
| Calibration | `helper_sha256`, `seed`, `network_id` | Native helper identity, seed and network id |
| Ledger configuration | `compute_config_sha256` | SHA256 of the captured configuration entries |
| Resource limits | `resource_limits_sha256` | SHA256 of the captured resource limits |
| Authorization mode and host features | `auth_mode`, `host_features` | Reported by the native helper |

The measurement refuses to report an effect when any of these values differs
between the runs it compares. A drifted run fails with
`Source-account comparison is not isolated: <field> changed between <run> and
<run>` instead of being summarised as a source-account effect.

## What the measurement reports

Every measured run records the account that produced it in
`provenance.source_account`, alongside the per-metric consumption and the
recorded auth mode and resource limits. The report contains:

- `baseline`: the first measured run; every effect is relative to it.
- `variants`: the remaining measured runs.
- `effects`: the per-metric `baseline`, `variant`, `delta` and `changed` values
  of every variant, for all eleven metric keys.
- `held_fixed`: the values that stayed fixed across the compared runs.
- `comparison`: the verdict, including `cross_run_comparison_valid`.

`cross_run_comparison_valid` is true only when the source account changed no
measured metric. It answers the question the measurement was made for: whether
an account change invalidates cross-run comparisons.

## Using it

```ts
import { measureSourceAccountEffects } from "weighin/dist/source-account";

const report = await measureSourceAccountEffects({
  fixturesPath: "weighin-fixtures.json",
  rpcUrl: "http://localhost:8000/rpc",
  sourceAccounts: [
    { label: "account-a", public_key: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ" },
    { label: "account-b", public_key: "GCYNMW6XLAXBDC7PM3QGB47RMG2CQV3LQG6J5ZCMOHWXRCX26PUEHRJ6" },
  ],
});
```

The keys above are examples. Every account must exist on the measured network.
At least two distinct accounts are required, and the first one is the
baseline. The same source account can also be used for a single measured run
through the measurement API:

```ts
import { runMeasurement } from "weighin";

const results = await runMeasurement({
  fixturesPath: "weighin-fixtures.json",
  gitCommit: "abc1234",
  sdkVersion: "28.0.0",
  invocationSourceAccount: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
});
```

The deployment account is unaffected: deployment always uses the deployer
keypair, and only the invocation source varies.

## Valid source accounts

A source account is valid for a measurement when it is an Ed25519 account
public key that exists on the measured network. The measurement fails closed
before it deploys anything or captures a snapshot:

- A malformed key is rejected by the variant schema with
  `public_key must be an Ed25519 account public key (G...)`.
- A well-formed key that does not exist on the network is rejected with
  `Source account <label> is not available on the network: <key>`, before the
  contract is deployed and before any snapshot is captured.

A valid account is not automatically an account that may invoke a specific
case. A contract that requires authorization from a fixed address accepts only
that address in a signed production transaction. The measurement path uses
recording authorization, so it cannot prove that a given account satisfies the
authorization requirements of a case; see
[known limitations](KNOWN_LIMITATIONS.md).

## Measured result

The retained proof measured the `constant_probe` case of the proof contract
under three funded accounts on the pinned protocol-28 standalone network:

| Metric | Baseline | Account 2 | Account 3 |
|---|---|---|---|
| `cpu_instructions` | 264852 | 264852 | 264852 |
| `memory_bytes` | 1124030 | 1124030 | 1124030 |
| `ledger_read_entries` | 2 | 2 | 2 |
| `events_count` | 0 | 0 | 0 |
| `event_data_bytes` | 8 | 8 | 8 |

The source account changed no measured resource, so
`cross_run_comparison_valid` is true for that case. The repeatability control,
an identical rerun of the same measurement, reported no changed metric either.
In protocol 28 a contract cannot observe the invoking account, and reading the
source account entry costs the same for every account, so the account does not
enter the measured consumption. The provenance now records the account anyway,
so a reviewer can see which account produced a record and a future protocol
that exposes the invoker to contracts is detectable instead of silent.

## Comparison rules in saved records

`provenance.source_account` is an optional field. Records written before the
field existed stay valid, and a comparison of two records that both omit it
keeps its previous behaviour.

A comparison of two records that both carry the field fails when the accounts
differ:

```text
Incompatible measurement environment: source_account
```

This is the saved-record counterpart of the measurement verdict: records
measured under different source accounts are not comparable, and the difference
is reported instead of being averaged away.

## Boundaries

- The proof covers one contract case on one protocol-28 standalone network on
  one host. It is not a claim about every contract, protocol or network.
- The measurement is a simulation. It does not submit the measured
  transaction and does not produce a signed production authorization.
- Only the account identity is varied. A contract whose behaviour depends on
  the account state it reads, for example a contract account with storage, is
  a different case with different valid accounts.
