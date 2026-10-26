# Standalone network and deployer readiness

`getNetwork` returns metadata; it does not establish that RPC can serve ledger
reads or that Friendbot can fund accounts. Before builds, funding, or deployment,
the Action requires `getHealth` status `healthy`, the standalone network
passphrase, and protocol 28. A healthy endpoint with a different passphrase or
protocol is reported as incompatible explicitly. Account initialization then
confirms the deployer's account through raw `getLedgerEntries` before any
contract deployment or benchmark measurement.

Every owned raw JSON-RPC request validates a `2.0` response envelope, the exact
request ID, and exactly one `result` or well-formed `error`. Invalid envelopes
fail before their payload can affect readiness, funding, or measurement. HTTP
status failures, malformed responses, valid method errors, and unsupported
method result schemas remain distinct failure classes.

The raw read avoids SDK 16.0.1 `getAccountEntry`, which converts all read errors
into account-not-found errors. A successful empty ledger response means absence;
an invalid response or RPC error fails instead of triggering funding.

## Bounded funding and inclusion

Account readiness has a 120-second elapsed deadline. Each HTTP request, including
its response body, has a timeout of at most 15 seconds or the remaining deadline.
Between attempts it waits at most two seconds. HTTP 429/500/502/503/504 and
connection/timeouts are retryable. Other HTTP failures, malformed ledger data,
unrelated account entries and JSON-RPC errors fail immediately.

The same public address is used throughout. Every retry reads RPC first, so an
ambiguous funding response can recover without another funding request if the
account already exists. After an accepted funding request, only account inclusion
is polled; funding is not repeated. An existing account skips Friendbot entirely.
An accepted funding response without inclusion never counts as readiness.
The private deployer key remains in the existing private runner file.

The repository startup script checks RPC health for up to 120 seconds, then uses
the same account readiness path to fund a disposable account and confirm its RPC
inclusion. These sequential phases can take up to 240 seconds, excluding Docker
startup. It labels its disposable `stellar-quickstart` container with
`io.weighin.managed-by=weighin-start-local-network` and only replaces a matching
container carrying that ownership label. An unowned name collision is preserved
and causes an actionable error. To explicitly authorize replacing an unowned
container, set `WEIGHIN_REPLACE_UNOWNED_CONTAINER=1` for that invocation. Docker
ownership-inspection failures also stop startup without modifying the container.

The script records the container ID that `docker run` reports for the container
it starts. If readiness fails, or the script is interrupted (`SIGINT`/`SIGTERM`)
before readiness is confirmed, it prints that container's logs and then stops it
by ID; because the container runs with `--rm`, stopping it also removes it. Only
the container started by this attempt is ever stopped. A failed log capture or
stop is reported with the manual `docker rm -f <id>` command, and the script
still exits non-zero, so a cleanup problem can never turn a failed start into
success. If `docker run` does not report an ID, startup fails without touching
any container. After successful readiness the container is left running for the
caller.

Install Node dependencies and build TypeScript before running:

```bash
npm ci
npm run build
bash scripts/start-local-network.sh
```

The example external workflow polls `getHealth`; the bundled Action independently
checks its real deployer's funding/inclusion. External consumers do not need the
repository's disposable-account probe. The account deadline is not an overall
Action timeout and does not guarantee later deployment/simulation availability.
Unknown RPC failures still fail closed. This work does not expand the supported
Linux x64/protocol-28 standalone scope or change resource metrics/policy semantics.

## Verification

`tests/account-readiness.test.cjs` uses controlled HTTP responses and virtual time
to prove existing-account reuse, 502 recovery, delayed inclusion, ambiguous funding,
all temporary-status exhaustion, permanent failures, transport recovery and invalid
RPC rejection. Action subprocess tests prove unhealthy RPC and exhausted real
account initialization emit `result=fail`, empty diff and exit 1. These are
controlled behavior tests, not live measurement evidence.

The explicit live experiment runs three new pinned standalone containers through
the production startup script and real bundled Action:

```bash
npm run bundle
npm run build:helper
node tests/experiments/verify-network-readiness.cjs /tmp/weighin-network-readiness-proof
```

Docker access, official Stellar CLI 28.1.0, Rust 1.95.0/wasm32v1-none and native
helper are required. The startup script owns and cleans up only containers with
its ownership label; the experiment still refuses to start when any container
already uses the fixed name. The harness currently uses the locally verified CLI
under
`/tmp/weighin-stage3-stellar`; provision that path before rerunning. Cargo cache
reuse is optional via `WEIGHIN_EXPERIMENT_CARGO_TARGET_DIR`. Fresh containers do
not imply clean Cargo/helper builds. The experiment refuses to replace an existing
`stellar-quickstart` container, stops its owned sidecars and records raw HTTP/native
IO, container identities, source-build logs, process exits and reports. Private
seeds stay in temporary runner directories; nothing is pushed or published.

See `docs/experiments/network-readiness/` for recorded validation and live outcomes.
Subsequent [public GitHub CI verification](EVIDENCE.md) has separate producer/run
records; it does not relabel these local readiness trials.

Recorded local result (2026-10-08): three distinct fresh containers each returned
Friendbot HTTP **502 before 200** (sequences: 502/502/200, 502/200,
502/502/200). The production readiness path recovered using
the same address, confirmed its account in RPC, and then the real bundled Action
passed. Each Action compared both configured benchmark identities with CPU delta
zero under a strict CPU policy. This demonstrates naturally occurring startup
recovery on the pinned image; it does not promise failure-free network operation.
Persistent failure and malformed-response handling are covered by controlled
behavior tests. The old historical fixture bridge remains required and unchanged.

The first three-container proof is preserved under
`experiments/network-readiness/attempt-1-response-body-policy/`. Final review
then moved HTTP error classification ahead of body reading and added a stalled
403-body test. All gates and fresh-container trials were repeated with the final
bundle rather than treating earlier captures as proof of changed code.
