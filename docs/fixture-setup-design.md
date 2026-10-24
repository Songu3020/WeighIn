# Committed fixture setup and typed dependency design

> **Implementation status.** Named dependency planning (§2) and typed
> committed-return bindings (§3) are implemented for fixture contracts by
> issues #213 and #215: `depends_on`, the `binding` argument form, and the
> setup/measurement split in `runMeasurement` (`src/setup-plan.ts`). The
> implementation differs from this design where noted: ties in the topological
> order keep fixture declaration order rather than sorting by id, so existing
> independent fixtures deploy exactly as before; and bindings support
> `field`/`index` selectors that are validated against the decoded value. See
> the [setup plan proof](setup-plan.md).

This document is the design and bounded feasibility proof for issues #39, #56,
and #57. It does not add a production deployment graph, constructor executor,
asset-contract deployer, generic expression language, or public-network setup.

## 1. Setup lifecycle and measurement boundary (#39)

Every revision/scenario is evaluated in an owned disposable standalone network.
The setup phase is separate from the measured invocation:

1. Resolve the fixture's stable logical identities before any RPC or transaction.
2. Create a disposable deployer account and record its public key; the secret
   remains outside the evidence directory.
3. Build the exact WASM and record its SHA-256, toolchain, SDK, protocol, and
   source snapshot.
4. Upload each required WASM in dependency order. Wait for a successful,
   included transaction and record its hash and inclusion ledger.
5. Create each contract instance with the deterministic deployment salt. Wait
   for successful inclusion and record the instance ID and receipt.
6. Resolve committed setup returns and bindings, then verify the expected
   initialized storage entries through a separate RPC read.
7. Only after all setup receipts and reads are confirmed, simulate the measured
   invocation. Setup transaction resources are never included in benchmark
   consumption.

An uncertain, timed-out, rejected, or partially included setup produces an
incomplete scenario and cannot produce a passing benchmark. A later invocation
must not run against a setup whose receipt, ledger inclusion, WASM hash, or
state snapshot is missing.

### Isolation and identity

The stable comparison identity is:

`[fixture_id, logical_contract_id, function_name, case_id]`

It is independent of runtime addresses, generated return values, deployment
salts, and setup receipts. A scenario namespace is the tuple
`[revision_sha, scenario_id, logical_contract_id]`; BASE and HEAD use separate
disposable environments even when the same WASM deterministically produces the
same address. Within one environment, the deployment salt is derived from the
logical ID and WASM hash. Therefore identical logical ID + identical WASM can
reuse an address, while a changed WASM produces a different address. This is an
identity rule for the experiment, not an assertion that arbitrary networks
reuse state.

State belongs to one scenario namespace. It is never copied between revisions.
The evidence records the namespace, deployer, salt, contract ID, setup receipts,
ledger snapshots, and relevant state keys so a reviewer can detect accidental
cross-scenario reuse.

### Failure and cleanup

The setup state machine has these terminal outcomes: `committed`, `rejected`,
`timeout`, `not_found_after_send`, `partial_setup`, and `cancelled`. Only
`committed` may proceed to measurement. A submitted transaction whose final
status cannot be confirmed is `not_found_after_send`, not success. Failed
scenarios retain sanitized process/RPC receipts and are excluded from measured
series; disposable networks and deployer accounts are then discarded.

Authorization is explicit: setup uses the scenario deployer signer, and every
operation declares its required signer. Existing independent fixtures remain
backward-compatible because a fixture with no dependencies follows the same
setup boundary with an empty dependency list. Constructor arguments, standard
asset-contract deployment, and alternate authorization schemes remain named
extensions rather than silently supported behavior.

## 2. Named dependency planning (#56)

The design input is a declarative plan, not a runtime parser yet. Each entry has
an immutable `deployment_id`, owned artifact, and named dependency references:

```json
{
  "deployment_id": "callee",
  "artifact": { "wasm_sha256": "...", "owner": "callee.wasm" },
  "depends_on": []
}
```

The planner validates that IDs are unique, every dependency exists, and the
graph is acyclic. It emits a deterministic topological order, breaking ties by
`deployment_id`. Missing references and cycles are rejected before any side
effect. Artifact ownership is explicit: a deployment may only use the artifact
declared by that deployment. Deployment-instance identity is separate from the
logical deployment ID and is scoped to the revision/scenario namespace above.

For a caller/callee pair, the callee is deployed first. Its committed setup
return is placed in a typed binding. The caller's setup or measured invocation
consumes that binding through a typed argument reference, never by interpolating
an address into a string. The concrete bounded example is recorded in
`docs/experiments/fixture-setup-design/example.json`.

Cleanup receipts are ordered in reverse topological order when a disposable
environment supports explicit cleanup. Cleanup failure is retained as an
environment warning and never relabeled as a successful setup. Existing
independent contracts retain their current single-node behavior.

## 3. Typed committed-return bindings (#57)

A binding has a name, source deployment, source receipt, typed selector, and
scope. The prototype supports selecting a top-level typed ScVal return and
passing it as a later argument. Its lifetime is one revision/scenario setup
plan; it cannot leak into another revision or scenario.

Supported prototype types are `address`, `bool`, `string`, `symbol`, integer
types, bytes, and explicitly shaped vec/map values. The selected XDR must
decode to the declared type. No lossy coercion, string conversion, secret
logging, or implicit address parsing is allowed. Nested selectors are deferred
until a reviewed selector schema is added; the prototype rejects them rather
than guessing.

Bindings are validated before side effects for duplicate names, forward
references, cycles, missing sources, incompatible declared types, and missing
committed receipts. Runtime failures remain distinct: a committed setup return
that cannot be decoded or does not match the declared type fails the scenario
before the dependent operation. Logical case identity continues to use stable
fixture declarations, while BASE/HEAD reports compare binding declarations and
diagnose changed committed values separately from resource metrics.

Sensitive values are represented by hashes and type metadata in normal logs;
raw XDR is retained only in a restricted evidence directory when the experiment
explicitly requires it.

## Bounded local feasibility walkthrough

This is a bounded local design proof, not a production command:

```bash
npm ci
npm run build
npm run typecheck
node --test tests/fixture-setup-design.test.cjs
```

The prototype validates the two-contract plan, deterministic ordering, committed
receipt gate, and typed XDR address selection against the pinned JavaScript SDK.
The real network submission walkthrough remains a follow-up feasibility run; it
must build two temporary contracts, submit callee setup, wait for the inclusion
receipt, read initialized persistent storage through RPC, and then use the
committed typed callee address in a separately simulated caller read. It must
save sanitized receipts, XDR, hashes, source/tool identities, and process
outcomes, and must not use setup transaction consumption as benchmark
consumption.

The checked-in example and validation test are deterministic design fixtures;
they are not presented as live network evidence. A live run must use the pinned
toolchain/network and preserve its raw captures before the design is treated as
production-ready.
