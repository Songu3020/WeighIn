// Deterministic tests for fixture setup dependencies (#213) and typed
// setup-result bindings (#215). The RPC transport is fully controlled: no live
// network or native helper is exercised. The live two-WASM proof is retained
// under docs/experiments/setup-plan.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Account, Address, Keypair, rpc, xdr } = require("@stellar/stellar-sdk");
const { parseFixtures } = require("../dist/identity");
const {
  planSetupOrder,
  dependentsOf,
  resolveBinding,
} = require("../dist/setup-plan");
const {
  runMeasurement,
  calculateContractId,
  buildInvocationTransaction,
} = require("../dist/measurement");

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const CALLEE_WASM = Buffer.from([...MAGIC, 0x00, 0x01, 0x61]);
const CALLER_WASM = Buffer.from([...MAGIC, 0x00, 0x01, 0x62]);
const hash = (n) => String(n).repeat(64);

function fixtures(contracts) {
  return parseFixtures(
    JSON.stringify({ id: "setup-suite", contracts }),
    "fixtures.json",
  );
}
const contract = (id, extra = {}) => ({
  id,
  wasm_path: `${id}.wasm`,
  invocations: [{ id: "case", function_name: "run", args: [] }],
  ...extra,
});
const order = (spec) =>
  planSetupOrder(spec.fixture_id, spec.contracts).map((c) => c.logical_id);

test("independent contracts keep fixture declaration order", () => {
  assert.deepEqual(
    order(fixtures([contract("b"), contract("a"), contract("c")])),
    ["id:b", "id:a", "id:c"],
  );
});

test("dependencies deploy first in a deterministic topological order", () => {
  const spec = fixtures([
    contract("app", { depends_on: ["token", "oracle"] }),
    contract("oracle", { depends_on: ["token"] }),
    contract("token"),
    contract("unrelated"),
  ]);
  assert.deepEqual(order(spec), [
    "id:token",
    "id:oracle",
    "id:app",
    "id:unrelated",
  ]);
  assert.deepEqual(order(spec), order(spec));
});

for (const [label, contracts, message] of [
  [
    "an unknown dependency",
    [contract("a", { depends_on: ["missing"] })],
    /depends on unknown contract id "missing"/,
  ],
  [
    "a path-identified dependency",
    [
      contract("a", { depends_on: ["b"] }),
      { wasm_path: "b.wasm", invocations: [{ function_name: "x", args: [] }] },
    ],
    /unknown contract id "b"/,
  ],
  [
    "a duplicate dependency",
    [contract("a", { depends_on: ["b", "b"] }), contract("b")],
    /lists dependency "b" more than once/,
  ],
  [
    "a self dependency",
    [contract("a", { depends_on: ["a"] })],
    /cannot depend on itself/,
  ],
  [
    "a cycle",
    [
      contract("a", { depends_on: ["b"] }),
      contract("b", { depends_on: ["c"] }),
      contract("c", { depends_on: ["a"] }),
    ],
    /dependency cycle among id:a, id:b, id:c/,
  ],
  [
    "a binding to a contract that is not a declared dependency",
    [
      contract("a", {
        invocations: [
          {
            id: "x",
            function_name: "run",
            args: [{ type: "address", binding: { contract: "b" } }],
          },
        ],
      }),
      contract("b"),
    ],
    /argument 0 binds "b", which is not a declared dependency/,
  ],
]) {
  test(`setup planning rejects ${label}`, () => {
    assert.throws(() => order(fixtures(contracts)), message);
  });
}

test("binding declarations are schema-validated with field/index selectors only", () => {
  const withArg = (arg) => () =>
    fixtures([
      contract("a", { invocations: [{ function_name: "run", args: [arg] }] }),
    ]);
  assert.doesNotThrow(
    withArg({
      type: "Address",
      binding: { contract: "b", select: [{ field: "addr" }, { index: 2 }] },
    }),
  );
  assert.throws(
    withArg({
      type: "address",
      binding: { contract: "b", select: [{ index: -1 }] },
    }),
    /select\.0\.index/,
  );
  assert.throws(
    withArg({
      type: "address",
      binding: { contract: "b", select: [{ index: 1.5 }] },
    }),
    /select\.0/,
  );
  assert.throws(
    withArg({
      type: "address",
      binding: { contract: "b", select: [{ field: "" }] },
    }),
    /select\.0/,
  );
  assert.throws(
    withArg({
      type: "address",
      binding: { contract: "b", select: [{ key: "x" }] },
    }),
    /select\.0/,
  );
  assert.throws(
    withArg({ type: "address", binding: { contract: "b", path: "$.x" } }),
    /Unrecognized key/,
  );
  assert.throws(
    withArg({ type: "address", binding: { contract: "b" }, value: "C..." }),
    /Unrecognized key/,
  );
  assert.throws(
    withArg({ type: "timepoint", binding: { contract: "b" } }),
    /args\.0\.type/,
  );
});

test("bound case identity is the declared reference, not a runtime address", () => {
  const spec = fixtures([
    contract("callee"),
    contract("caller", {
      depends_on: ["callee"],
      invocations: [
        {
          function_name: "run",
          args: [{ type: "Address", binding: { contract: "callee" } }],
        },
      ],
    }),
  ]);
  assert.equal(
    spec.contracts[1].invocations[0].case_id,
    'args:[{"type":"address","binding":{"contract":"callee"}}]',
  );
});

test("dependentsOf aborts exactly the transitive dependents of a failed prerequisite", () => {
  const spec = fixtures([
    contract("token"),
    contract("oracle", { depends_on: ["token"] }),
    contract("app", { depends_on: ["oracle"] }),
    contract("unrelated"),
  ]);
  const planned = planSetupOrder(spec.fixture_id, spec.contracts);
  assert.deepEqual(
    dependentsOf(planned[0], planned).map((c) => c.logical_id),
    ["id:oracle", "id:app"],
  );
  assert.deepEqual(dependentsOf(planned[3], planned), []);
});

// ---------------------------------------------------------------------------
// Typed binding resolution
// ---------------------------------------------------------------------------

const CONTRACT = "CC227UDF6WBLRTOKKVRIJN7BGSBK67ZGV6IDARJ2AMATGSQ7UZNBZHSB";
const addressVal = () => Address.fromString(CONTRACT).toScVal();
const structured = xdr.ScVal.scvMap([
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("admin"), val: addressVal() }),
  new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol("ids"),
    val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(7), xdr.ScVal.scvU32(9)]),
  }),
  new xdr.ScMapEntry({
    key: xdr.ScVal.scvString("label"),
    val: xdr.ScVal.scvString("pool"),
  }),
]);
const result = (value) => ({
  logical_id: "id:factory",
  contract_id: CONTRACT,
  source: "created",
  return_xdr: value === undefined ? undefined : value.toXDR("base64"),
});

test("a root address binding passes the committed ScVal through unchanged", () => {
  const value = resolveBinding(
    { contract: "factory" },
    "address",
    result(addressVal()),
  );
  assert.equal(value.toXDR("base64"), addressVal().toXDR("base64"));
});

test("field and index selectors reach nested typed values", () => {
  const ids = resolveBinding(
    { contract: "factory", select: [{ field: "ids" }, { index: 1 }] },
    "u32",
    result(structured),
  );
  assert.equal(ids.u32(), 9);
  const admin = resolveBinding(
    { contract: "factory", select: [{ field: "admin" }] },
    "address",
    result(structured),
  );
  assert.equal(Address.fromScVal(admin).toString(), CONTRACT);
  const label = resolveBinding(
    { contract: "factory", select: [{ field: "label" }] },
    "string",
    result(structured),
  );
  assert.equal(label.str().toString(), "pool");
  const whole = resolveBinding(
    { contract: "factory", select: [{ field: "ids" }] },
    "vec",
    result(structured),
  );
  assert.equal(whole.vec().length, 2);
});

for (const [label, binding, type, value, message] of [
  [
    "a missing field",
    { select: [{ field: "owner" }] },
    "address",
    structured,
    /field "owner" does not exist at \$/,
  ],
  [
    "an out-of-range index",
    { select: [{ field: "ids" }, { index: 2 }] },
    "u32",
    structured,
    /index 2 is out of range at \$\.ids \(length 2\)/,
  ],
  [
    "an index into a non-vec",
    { select: [{ index: 0 }] },
    "address",
    addressVal(),
    /\$ is scvAddress, not a vec/,
  ],
  [
    "a field of a non-map",
    { select: [{ field: "ids" }, { field: "x" }] },
    "u32",
    structured,
    /\$\.ids is scvVec, not a map/,
  ],
  [
    "a declared type mismatch",
    { select: [{ field: "label" }] },
    "symbol",
    structured,
    /\$\.label is scvString, but the argument declares symbol/,
  ],
  [
    "an address read as bytes",
    {},
    "bytes",
    addressVal(),
    /\$ is scvAddress, but the argument declares bytes/,
  ],
]) {
  test(`binding resolution fails explicitly for ${label}`, () => {
    assert.throws(
      () =>
        resolveBinding(
          { contract: "factory", ...binding },
          type,
          result(value),
        ),
      message,
    );
  });
}

test("binding resolution fails explicitly without a committed return", () => {
  assert.throws(
    () => resolveBinding({ contract: "factory" }, "address", undefined),
    /no committed setup result/,
  );
  assert.throws(
    () => resolveBinding({ contract: "factory" }, "address", result(undefined)),
    /returned no value/,
  );
  assert.throws(
    () =>
      resolveBinding({ contract: "factory" }, "address", {
        ...result(addressVal()),
        return_xdr: "not-xdr",
      }),
    /not valid ScVal XDR/,
  );
});

test("a measurement path without setup results rejects bound arguments", async (t) => {
  t.mock.method(
    rpc.Server.prototype,
    "getAccount",
    async (address) => new Account(address, "1"),
  );
  const source = Keypair.random().publicKey();
  await assert.rejects(
    buildInvocationTransaction({
      server: new rpc.Server("http://controlled.invalid/rpc", {
        allowHttp: true,
      }),
      sourceAccount: source,
      contractId: CONTRACT,
      invocation: {
        function_name: "run",
        args: [{ type: "address", binding: { contract: "callee" } }],
      },
      rpcUrl: "http://controlled.invalid/rpc",
    }),
    /Setup bindings are not available in this measurement path/,
  );
});

// ---------------------------------------------------------------------------
// Plan execution through runMeasurement against a controlled RPC
// ---------------------------------------------------------------------------

function contractIdFor(deployer, wasm) {
  const wasmHash = crypto.createHash("sha256").update(wasm).digest();
  return calculateContractId(
    deployer.publicKey(),
    crypto.createHash("sha256").update(wasmHash).digest(),
  );
}

function scenario(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-setup-plan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deployer = Keypair.random();
  fs.writeFileSync(path.join(dir, "key"), deployer.secret(), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "callee.wasm"), CALLEE_WASM);
  fs.writeFileSync(path.join(dir, "caller.wasm"), CALLER_WASM);
  const ids = {
    callee: contractIdFor(deployer, CALLEE_WASM),
    caller: contractIdFor(deployer, CALLER_WASM),
  };
  // The dependent caller is declared first to prove the plan reorders it.
  fs.writeFileSync(
    path.join(dir, "fixtures.json"),
    JSON.stringify({
      id: "cross-contract",
      contracts: [
        {
          id: "caller",
          wasm_path: "caller.wasm",
          depends_on: ["callee"],
          invocations: [
            {
              id: "nested",
              function_name: "run",
              args: [
                {
                  type: "address",
                  binding: {
                    contract: "callee",
                    ...(options.select ? { select: options.select } : {}),
                  },
                },
                { type: "u32", value: 1 },
              ],
            },
          ],
        },
        {
          id: "callee",
          wasm_path: "callee.wasm",
          invocations: [
            {
              id: "once",
              function_name: "work",
              args: [{ type: "u32", value: 1 }],
            },
          ],
        },
      ],
    }),
  );

  const events = [];
  const created = [];
  const simulated = [];
  let sends = 0;
  let pendingCreate;
  t.mock.method(console, "log", () => {});
  t.mock.method(
    require("../dist/account"),
    "ensureAccountReady",
    async () => {},
  );
  t.mock.method(
    rpc.Server.prototype,
    "getAccount",
    async (address) => new Account(address, "1"),
  );
  t.mock.method(rpc.Server.prototype, "getLedgerEntries", async () => ({
    entries: [],
  }));
  t.mock.method(rpc.Server.prototype, "prepareTransaction", async (tx) => {
    const op = tx.operations[0];
    if (
      op.type === "invokeHostFunction" &&
      op.func.switch().name === "hostFunctionTypeCreateContractV2"
    ) {
      const salt = op.func
        .createContractV2()
        .contractIdPreimage()
        .fromAddress()
        .salt();
      pendingCreate = Object.keys(ids).find((name) => {
        const wasm = name === "callee" ? CALLEE_WASM : CALLER_WASM;
        const wasmHash = crypto.createHash("sha256").update(wasm).digest();
        return crypto
          .createHash("sha256")
          .update(wasmHash)
          .digest()
          .equals(salt);
      });
      events.push(`create:${pendingCreate}`);
    } else {
      events.push("upload");
    }
    return { sign() {} };
  });
  t.mock.method(rpc.Server.prototype, "sendTransaction", async () => {
    sends++;
    if (options.failSend === sends)
      return { status: "ERROR", hash: hash(sends) };
    return { status: "PENDING", hash: hash(sends) };
  });
  t.mock.method(rpc.Server.prototype, "getTransaction", async () => {
    if (events.at(-1)?.startsWith("create:")) {
      created.push(pendingCreate);
      if (options.noReturn) return { status: "SUCCESS" };
      return {
        status: "SUCCESS",
        returnValue: Address.fromString(ids[pendingCreate]).toScVal(),
      };
    }
    return { status: "SUCCESS" };
  });
  t.mock.method(rpc.Server.prototype, "simulateTransaction", async (tx) => {
    const invoke = tx.operations[0].func.invokeContract();
    simulated.push({
      contract: Address.fromScAddress(invoke.contractAddress()).toString(),
      function_name: invoke.functionName().toString(),
      args: invoke.args(),
    });
    events.push(`simulate:${invoke.functionName().toString()}`);
    throw new Error("reached invocation");
  });
  t.mock.method(
    require("../dist/simulation"),
    "resolveSimulationHelper",
    async () => "/fake/helper",
  );
  t.mock.method(
    require("../dist/simulation"),
    "measureInvocation",
    async (_rpcUrl, tx) => {
      const invoke = tx.operations[0].func.invokeContract();
      simulated.push({
        contract: Address.fromScAddress(invoke.contractAddress()).toString(),
        function_name: invoke.functionName().toString(),
        args: invoke.args(),
      });
      events.push(`simulate:${invoke.functionName().toString()}`);
      throw new Error("reached invocation");
    },
  );

  return {
    ids,
    events,
    created,
    simulated,
    sends: () => sends,
    run: () =>
      runMeasurement({
        fixturesPath: path.join(dir, "fixtures.json"),
        fixtureId: "fixtures.json",
        keyFile: path.join(dir, "key"),
        gitCommit: "test-setup-plan",
        sdkVersion: "16.0.1",
        rpcUrl: "http://controlled.invalid/rpc",
        helperPath: path.join(dir, "missing-helper"),
      }),
  };
}

test("the plan deploys the dependency first, once each, before any measured invocation", async (t) => {
  const { events, created, sends, run } = scenario(t);
  await assert.rejects(run(), /reached invocation/);
  assert.deepEqual(events, [
    "upload",
    "create:callee",
    "upload",
    "create:caller",
    "simulate:run",
  ]);
  assert.deepEqual(created, ["callee", "caller"]);
  assert.equal(sends(), 4, "each deployment is submitted exactly once per run");
});

test("the dependent invocation receives the committed callee address as a typed ScVal", async (t) => {
  const { ids, simulated, run } = scenario(t);
  await assert.rejects(run(), /reached invocation/);
  const [call] = simulated;
  assert.equal(call.contract, ids.caller);
  assert.notEqual(
    ids.caller,
    ids.callee,
    "two different WASMs produce two instances",
  );
  assert.equal(call.args[0].switch().name, "scvAddress");
  assert.equal(Address.fromScVal(call.args[0]).toString(), ids.callee);
  assert.equal(call.args[1].u32(), 1);
});

test("a failed prerequisite aborts its dependents before they are submitted or measured", async (t) => {
  const { events, sends, simulated, run } = scenario(t, { failSend: 1 });
  await assert.rejects(run(), (error) => {
    assert.match(error.message, /WASM upload submission was rejected/);
    assert.match(
      error.message,
      /Setup of id:callee failed; aborted dependents: id:caller/,
    );
    return true;
  });
  assert.equal(sends(), 1);
  assert.deepEqual(events, ["upload"]);
  assert.deepEqual(simulated, []);
});

test("a failed dependent create stops before measurement and aborts no other contract", async (t) => {
  const { created, simulated, run } = scenario(t, { failSend: 4 });
  await assert.rejects(run(), (error) => {
    assert.match(error.message, /contract creation submission was rejected/);
    assert.doesNotMatch(error.message, /aborted dependents/);
    return true;
  });
  assert.deepEqual(created, ["callee"]);
  assert.deepEqual(simulated, []);
});

test("a malformed binding path fails explicitly before the dependent invocation", async (t) => {
  const { simulated, run } = scenario(t, { select: [{ index: 0 }] });
  await assert.rejects(
    run(),
    /Cannot resolve binding to "callee": \$ is scvAddress, not a vec/,
  );
  assert.deepEqual(
    simulated.map((call) => call.function_name),
    [],
  );
});

test("a committed create without a return value cannot satisfy a binding", async (t) => {
  const { simulated, run } = scenario(t, { noReturn: true });
  await assert.rejects(
    run(),
    /the committed setup of id:callee returned no value/,
  );
  assert.deepEqual(simulated, []);
});

test("invalid dependency plans are rejected before any key file or network side effect", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-setup-plan-invalid-"),
  );
  try {
    const keyFile = path.join(dir, "key");
    fs.writeFileSync(
      path.join(dir, "fixtures.json"),
      JSON.stringify({
        contracts: [
          contract("a", { depends_on: ["b"] }),
          contract("b", { depends_on: ["a"] }),
        ],
      }),
    );
    await assert.rejects(
      runMeasurement({
        fixturesPath: path.join(dir, "fixtures.json"),
        fixtureId: "fixtures.json",
        gitCommit: "x",
        sdkVersion: "0",
        keyFile,
        rpcUrl: "http://controlled.invalid/rpc",
      }),
      /Invalid setup plan in path:fixtures\.json: dependency cycle among id:a, id:b/,
    );
    assert.equal(fs.existsSync(keyFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the README dependency example parses and deploys the bound dependency first", () => {
  const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");
  const example = [...readme.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .find((block) => block.includes('"depends_on"'));
  assert.ok(example, "README documents a depends_on fixture");
  const spec = parseFixtures(example, "weighin-fixtures.json");
  assert.deepEqual(order(spec), ["id:token", "id:pool"]);
  assert.deepEqual(spec.contracts[0].invocations[0].args[0], {
    type: "address",
    binding: { contract: "token" },
  });
});

test("retained live proof shows two WASMs deployed in order with a real bound cross-contract call", () => {
  const directory = path.join(__dirname, "../docs/experiments/setup-plan");
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
  const sha = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  for (const [file, expected] of Object.entries(read("sha256.json")))
    assert.equal(sha(path.join(directory, file)), expected, file);

  const proof = read("verification.json");
  assert.equal(proof.status, "LIVE_SETUP_PLAN_PROOF_PASS");
  for (const [check, passed] of Object.entries(proof.checks))
    assert.equal(passed, true, check);
  const nested = path.join(__dirname, "../docs/experiments/nested-invocation");
  assert.equal(
    sha(path.join(nested, "nested-callee.wasm")),
    proof.wasm_sha256.callee,
  );
  assert.equal(
    sha(path.join(nested, "nested-caller.wasm")),
    proof.wasm_sha256.caller,
  );
  assert.notEqual(proof.wasm_sha256.callee, proof.wasm_sha256.caller);

  const receipts = read("setup-receipts.json");
  assert.deepEqual(
    receipts.setup_order.map((step) => step.artifact),
    ["callee", "callee", "caller", "caller"],
  );
  const [calleeReturn] = receipts.committed_returns;
  assert.equal(
    Address.fromScVal(
      xdr.ScVal.fromXDR(calleeReturn.return_xdr, "base64"),
    ).toString(),
    proof.runtime_contract_ids.callee,
  );

  const { simulation, native_footprint } = read("caller-invocation.json");
  assert.equal(simulation.contract_id, proof.runtime_contract_ids.caller);
  assert.equal(
    simulation.args_xdr[0],
    calleeReturn.return_xdr,
    "the committed return is passed unchanged",
  );
  assert.ok(
    native_footprint.instances.includes(proof.runtime_contract_ids.callee),
  );
  assert.ok(
    native_footprint.storage.some(
      (entry) =>
        entry.contract === proof.runtime_contract_ids.callee &&
        entry.key === "counter",
    ),
  );

  const probes = read("failure-probes.json");
  assert.match(
    probes.malformed_binding_path.error,
    /\$ is scvAddress, not a vec/,
  );
  assert.deepEqual(probes.malformed_binding_path.simulated, []);
  assert.match(
    probes.failed_prerequisite.error,
    /Setup of id:callee failed; aborted dependents: id:caller/,
  );
  assert.deepEqual(probes.failed_prerequisite.submissions, []);
});
