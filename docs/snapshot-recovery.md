# Bounded snapshot-read recovery

## Observed problem

The [Stage 4 failed warm-up](experiments/repeatability/attempt-4-captive-core/failure.json)
returned JSON-RPC error -32603 from `getLedgerEntries`, with captive core HTTP 404.
The [same request later succeeded three times](experiments/repeatability/attempt-4-captive-core/failed-request-recheck.json).
This establishes an observed transient read failure, without establishing its
underlying captive-core cause. The adapter previously aborted immediately.

## Small repair

`src/simulation.ts` retains typed RPC failure information internally. Only the
observed method/code/message combination permits retry. The exact message is
documented in [native measurement](native-measurement.md). This intentionally
excludes HTTP 404 from the public endpoint and unrelated internal RPC failures.

Up to three matching failures per invocation trigger warnings and delays of 250,
500 and 1000 ms. The adapter then restarts the capture from `simulateTransaction`,
discarding partial batches. These retries consume the existing 30-capture budget.
All rows must still match the new simulation's ledger; header/config checks,
discovered-key expansion and native transaction-data/return/event parity remain.
Persistent failures return an error, never a successful or zero-valued result.
There are no new inputs, result fields, schema versions or threshold rules.

The native helper uses a version-1 machine failure envelope on stdout for
recoverable misses (`status: "uncaptured"`, with canonical LedgerKey XDR) and
for fatal input, protocol, incomplete-state, and host failures. Human-readable
diagnostics remain on stderr. The adapter rejects unknown envelopes, malformed
or duplicate keys, and recovery that discovers no new key; the old stderr
marker is retained only as a bounded compatibility path for executable
overrides that predate the envelope.

Before a present snapshot row is accepted, the adapter reconstructs the
canonical identity from LedgerEntryData and compares it with the requested
LedgerKey. Account, trustline, offer, data, claimable-balance, contract-data
(including durability), contract-code, config-setting, and TTL identities are
checked. A missing row remains a valid absence; a present row of the wrong
type or identity fails closed before native measurement.

An explicitly absent row (`xdr: null`) states that the key does not exist, so it
carries only its `key`. The native helper rejects an absent row that also sets
`extension_xdr`, `last_modified` or `live_until`, naming the contradictory
fields, instead of silently discarding that metadata; `live_until: null` is
treated as unset. This check runs before the archived-state check, so a stale
`live_until` on an absent row is reported as a contradiction. The adapter
already sends absent rows as `{ key, xdr: null }`, so valid absent-key
discovery is unchanged.

## Evidence

Ten controlled behavior tests use real saved RPC/native records, with deliberate
transport and ledger alterations clearly labeled as test data. They exercise:

- recovery after one and three matching failures;
- exhaustion on the fourth failure with no helper/measurement result;
- failed later batches discarding earlier successful rows;
- unrelated codes/messages and HTTP errors failing immediately;
- identical errors from other RPC methods remaining fatal;
- malformed rows, wrong headers and parity disagreements failing closed;
- ledger drift retaining its guard and the 30-capture budget remaining bounded;
- parity failure after recovery remaining fatal.

See `tests/snapshot-recovery.test.cjs` and the
[controlled test log](experiments/snapshot-recovery/controlled-tests.log).
The first test-development run failed because test scenario options were shadowed
by transport parameters; those mocks ignored injected faults. Renaming the test
parameters corrected the harness, and all ten tests passed. No live data changed.

The [live verification](experiments/snapshot-recovery/verification.json) reran
five cycles of reference hello plus six IO/event cases: **35 genuine successful
measurements**, stable values for all eight supported metrics and zero strict
policy violations. Three unavailable names were explicitly ignored and remain
null. Previously verified WASMs were reused; this is not another clean-build proof.
RPC/deployment/native execution/diff/policies were real. Observers only recorded
IO; no errors or measurement values were injected in the live experiment.

**No matching transient error occurred in the live rerun.** Automatic recovery is
proven by controlled tests; it was not observed on a naturally failing network
during this rerun. The exact historical error is the source of the narrow rule.

Raw [RPC](experiments/snapshot-recovery/rpc.json),
[native inputs/outputs](experiments/snapshot-recovery/native.json),
[runs](experiments/snapshot-recovery/runs.json),
[environment](experiments/snapshot-recovery/environment.json), process/warning
logs, WASMs, fixtures, producer snapshot and checksums are saved alongside the
verification. Private deployer seeds stay in temporary files.
The [SHA256 manifest](experiments/snapshot-recovery/manifest.json) identifies
the captured files and the tested repository source snapshot.

Final gates passed: `npm ci`, `npm test` (111 tests), `npm run test:native`
(15 tests), build, bundle, package dry-run, native format and diff checks. See
[commands/exits](experiments/snapshot-recovery/validation.json) and
[package inclusion](experiments/snapshot-recovery/package-inclusion.json).
No lint/typecheck scripts exist; build/bundle check TypeScript. Existing npm audit
findings remain one moderate/four high. A sandbox package recheck encountered
child-spawn EPERM; elevated execution passed. The helper binary stayed unchanged,
the private-seed scan passed and the proof container was stopped.

## Reproduce

Provision the pinned protocol-28 quickstart network on localhost port 18000,
Rust 1.95.0 and the native helper as described in [repeatability](repeatability.md).
Then run:

```bash
npm ci
npm run build
npm run build:helper
node --test tests/snapshot-recovery.test.cjs
node tests/experiments/verify-snapshot-recovery.cjs /tmp/weighin-stage4b-evidence
npm test
npm run test:native
npm run bundle
```

Use a new destination for each live attempt. The harness reuses the checksum-verified
Stage 4 WASMs, funds a local account and creates/reuses the native SAC. Stop the
owned local container after capturing evidence. Reproducing the live check does
not guarantee reproducing the transient error itself.

## Remaining limits

This handles one observed failure shape, not all network errors. The underlying
RPC/captive-core issue is not repaired. Unknown errors and persistent failures
continue to fail closed. Linux x64/protocol-28 fixture scope remains. Subsequent [hosted CI](EVIDENCE.md), [fixture migration](fixture-migration.md) and
[local external-project proof](external-soroban-forge.md) are separate evidence;
hosted external-project CI remains unverified.
