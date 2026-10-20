# Known limitations

These boundaries describe the current implementation. For exact tested values,
see [Evidence](EVIDENCE.md), [metric provenance](metric-provenance.md) and
[architecture](architecture.md).

| Area | Classification | Current boundary and evidence |
|---|---|---|
| Native platform | Unsupported outside tested path | Default helper provisioning is Linux x64 and Rust 1.95.0; `src/simulation.ts` rejects other platforms. A compatible binary override is not proof of another platform. Helper executable identity is bound by SHA256 before, during, across attempts, and before provenance emission |
| Protocol and network | Protocol-dependent / unsupported | Before builds or deployment, the Action requires the standalone network passphrase and protocol 28. Measured transactions must match that network. `rpc-url` is not arbitrary mainnet/testnet support (`src/action.ts`, `src/measurement.ts`, `src/simulation.ts`, `src/account.ts`) |
| CPU / memory | Protocol-dependent | Official native cost-model consumption, not RPC instruction budgets, hardware instructions, RSS, time or fees. Changing helper/calibration invalidates comparison |
| Three metric names | Unavailable | `historical_data_read_bytes`, `contract_data_hard_limit`, `tx_size_bytes` have null consumption/limit and reasons; required policy rules fail, explicit `ignore` opts out |
| Event count limit | Unavailable independent cap | Event count is measured; no independent protocol-28 count cap. A configured policy cap is permitted |
| Historical/archived state | Unsupported | Current-state capture only; archived snapshot entries are rejected by the helper |
| RPC availability | Environment-dependent | Captures must share a ledger/header and agree with native transaction data, return and events. Exactly one matching ledger header row with well-formed history entry XDR is required for the sequence; ambiguous duplicate headers are rejected. Every required configuration entry is identified and verified before native execution. Thirty capture attempts bound drift/discovered keys; only the exact observed captive-core 404 RPC error gets three bounded retries. Other errors fail |
| State between revisions | Environment-dependent | Snapshots are immutable per invocation, not across the whole suite. BASE/HEAD may use different ledgers. Ledger/time/state changes can change resources even when WASM is unchanged ([controlled ledger-variation proof](ledger-variation.md)). Comparable provenance does not freeze arbitrary state |
| Fixture execution | Unsupported chaining | Invocations are simulated independently; writes are discarded. Upload/deployment is submitted. Prior invocation output/state cannot be referenced as setup for the next case |
| Authorization / randomness | Not yet validated beyond documented mode | Native replay uses recording auth with testutils/recording_mode and a fixed zero seed. It is not signed production authorization. RPC/native disagreement fails rather than blending resources |
| Fixture arguments | Unsupported outside listed conversions | `toScVal` supports bool, string, symbol, u32/i32, u64/i64/u128/i128, address, hex bytes, typed vec/map. Large integers must be strings. Other ScVal types and output substitution are unsupported |
| Contract builds | Environment-dependent | Default build resolves workspace cdylib target names (falling back to package names when the target name is omitted) from fixture WASM basenames and rejects packages with multiple cdylib targets. Tools, locked dependency access and healthy temporary storage are caller requirements. SDK-specific Rust minimums can exceed the builder's gate |
| Custom / prebuilt builds | Environment-dependent | `build-command` and `skip-build` bypass CLI/version/optimization/fresh-output/storage validation. Callers own artifact freshness and comparable build flags |
| Optimizer storage | Environment-dependent | Pre/post write/fsync/read probes catch the reproduced persistent quota failure. They do not reserve capacity or rule out a transient failure solely during optimization |
| Reproducibility | Not yet validated universally | Five clean reference builds and five samples per seven cases were stable on one controlled host/network. This is not cross-machine/compiler/network or arbitrary-contract determinism. Failed setup attempts are retained |
| Multiple contracts | Partially validated | Structured identities avoid cross-contract collisions; tests and the migration bridge exercise multiple declarations. Identical WASM on one network/deployer can share a runtime address. Distinct arbitrary stateful multi-contract suites are not validated |
| Baseline and fixture evolution | Supported with constraints | Action fetches a base ref and uses each revision's fixture contents. Explicit IDs must exist on both sides before moving paths. New/removed cases are reported; at least one case must match. Additions/removals alone have no regression policy |
| Policy scope | Supported with constraints | Per-function rules apply to all logical contracts/cases using that name; no contract/case-specific selectors. No historical trend storage or webhook export exists |
| Historical results | Unsupported mixed-schema comparison | Schema 4 uses current audited semantics. Legacy results retain address matching only against legacy; schemas 2/3/4 cannot be mixed. Remeasure both revisions |
| CLI | Intentionally limited | Measurement JSON from prebuilt WASM only. Comparison, thresholds and GitHub reporting belong to the Action/API |
| GitHub comments | Supported with constraints | Separate consumer runs only for successful PR producers, so policy-failure reports remain artifacts/summaries. Direct comment API errors warn without failing an otherwise valid benchmark. Artifacts require retention/auth permissions. Comment upsert paginates through PR comments until reaching exhaustion or encountering an existing report marker (`src/comment.ts`); it does not disambiguate multiple marker comments or verify comment author ownership |
| Endpoint diagnostics | Shape-based redaction only | CLI/Action/transport render a sanitized endpoint: userinfo stripped, query values redacted, fragment dropped, malformed input replaced with `[invalid endpoint]`. Not general-purpose DLP: secrets embedded in the path, response bodies or unrelated text are not guaranteed to be removed. Requests still use the unchanged endpoint |
| External-project coverage | Validated within a bounded scope | [Hosted Soroban Forge proof](hosted-soroban-forge.md) covers the empty participant view in a permitted WeighInNG fork. Funded settlement, populated pagination, deposit/release and upstream adoption are not proven |

## Dependency audit

See [dependency security review](DEPENDENCY_SECURITY.md) for the dated npm audit,
resolved advisory paths, actual execution exposure and validation. Audit results
are a snapshot, not a guarantee against future advisories.
