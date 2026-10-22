const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  Account,
  Address,
  Keypair,
  StrKey,
  hash,
  rpc,
  xdr,
} = require("@stellar/stellar-sdk");
const { isContractDeployed, runMeasurement } = require("../dist/measurement");
const base = require("./fixtures/stage1b/base-simulation.json");
const head = require("./fixtures/stage1b/head-simulation.json");
const control = require("./fixtures/stage1b/control-simulation.json");
const leeway = require("./fixtures/stage1b/base-leeway.json");

test("the live unchanged control has identical transaction resource fields", () => {
  assert.deepEqual(control.parsed.resources, base.parsed.resources);
});

test("the same live invocation has a different instruction budget when leeway changes", () => {
  assert.equal(
    leeway.request.params.transaction,
    base.request.params.transaction,
  );
  assert.equal(leeway.request.params.resourceConfig.instructionLeeway, 5000000);
  const initial = rpc
    .parseRawSimulation(base.raw.result)
    .transactionData.build()
    .resources();
  const adjusted = rpc
    .parseRawSimulation(leeway.raw.result)
    .transactionData.build()
    .resources();
  assert.equal(initial.instructions(), 320219);
  assert.equal(adjusted.instructions(), 5270219);
  assert.equal(adjusted.writeBytes(), initial.writeBytes());
  assert.equal(leeway.raw.result.cost, undefined);
});

for (const [revision, capture] of [
  ["base", base],
  ["head", head],
]) {
  test(`${revision}: captured successful RPC response survives SDK parsing without compute consumption`, () => {
    const parsed = rpc.parseRawSimulation(capture.raw.result);
    assert.equal(rpc.Api.isSimulationSuccess(parsed), true);
    assert.deepEqual(Object.keys(parsed), capture.parsed.keys);
    assert.equal(
      parsed.transactionData.build().toXDR("base64"),
      capture.raw.result.transactionData,
    );
    assert.equal(parsed.cost, undefined);
    assert.equal(capture.raw.result.cost, undefined);
    const resources = parsed.transactionData.build().resources();
    assert.ok(
      resources.instructions() > 0,
      "A submission budget exists even though consumption is absent",
    );
    assert.equal(resources.memoryBytes, undefined);
    assert.deepEqual(
      parsed.events.map((e) => e.event().type().name),
      ["diagnostic", "diagnostic"],
    );
  });
}

test("captured raw and SDK parsed IO resource values agree exactly", () => {
  for (const capture of [base, head]) {
    const rawResources = xdr.SorobanTransactionData.fromXDR(
      capture.raw.result.transactionData,
      "base64",
    ).resources();
    const sdkResources = rpc
      .parseRawSimulation(capture.raw.result)
      .transactionData.build()
      .resources();
    for (const method of ["instructions", "diskReadBytes", "writeBytes"]) {
      assert.equal(sdkResources[method](), rawResources[method]());
    }
    assert.equal(
      sdkResources.footprint().readOnly().length,
      rawResources.footprint().readOnly().length,
    );
    assert.equal(
      sdkResources.footprint().readWrite().length,
      rawResources.footprint().readWrite().length,
    );
  }
});

function calculateContractId(deployerAddress, salt) {
  const addressSc = Address.fromString(deployerAddress).toScAddress();
  const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: addressSc,
      salt,
    }),
  );
  const networkId = hash(Buffer.from("Standalone Network ; February 2017"));
  const hashIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: preimage,
    }),
  );
  const contractIdBytes = hash(hashIdPreimage.toXDR());
  return StrKey.encodeContract(contractIdBytes);
}

test("deployment probe accepts the SDK-parsed ledger entry XDR objects", async () => {
  const keypair = Keypair.random();
  const contractId = calculateContractId(
    keypair.publicKey(),
    crypto.createHash("sha256").update("sdk-ledger-entry-test").digest(),
  );
  const contractAddress = Address.fromString(contractId).toScAddress();
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddress,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const entry = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: contractAddress,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvBool(true),
    }),
  );
  const server = {
    getLedgerEntries: async () => ({
      entries: [{ key: ledgerKey, val: entry }],
    }),
  };

  assert.equal(await isContractDeployed(server, contractId), true);
});

// Replay captured responses through the public measurement entry point.
// RPC transport is isolated here; these tests do not claim a live measurement.
async function replay(t, response) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-simulation-test-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keypair = Keypair.random();
  fs.writeFileSync(path.join(dir, "key"), keypair.secret(), { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "contract.wasm"),
    Buffer.from("test-only-wasm"),
  );
  fs.writeFileSync(
    path.join(dir, "fixtures.json"),
    JSON.stringify({
      contracts: [
        {
          id: "greeting",
          wasm_path: "contract.wasm",
          invocations: [
            {
              id: "world",
              function_name: "hello",
              args: [{ type: "Symbol", value: "world" }],
            },
          ],
        },
      ],
    }),
  );
  const wasmHash = crypto
    .createHash("sha256")
    .update(Buffer.from("test-only-wasm"))
    .digest();
  const salt = crypto.createHash("sha256").update(wasmHash).digest();
  const contractId = calculateContractId(keypair.publicKey(), salt);
  const contractAddress = Address.fromString(contractId).toScAddress();
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddress,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const existingEntry = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: contractAddress,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvBool(true),
    }),
  );
  // Account readiness now reads raw RPC instead of SDK getAccount, which masks errors.
  const rows =
    require("../docs/experiments/fixture-migration/bridge/rpc.json").flatMap(
      (c) => c.raw.result?.entries || [],
    );
  const accountRow = rows.find((e) => {
    try {
      return (
        xdr.LedgerEntryData.fromXDR(e.xdr, "base64").switch().name === "account"
      );
    } catch {
      return false;
    }
  });
  const accountValue = xdr.LedgerEntryData.fromXDR(accountRow.xdr, "base64");
  accountValue.account().accountId(keypair.xdrPublicKey());
  t.mock.method(
    globalThis,
    "fetch",
    async (url, options) =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(options.body).id,
          result: {
            latestLedger: 100,
            entries: [
              {
                key: JSON.parse(options.body).params.keys[0],
                xdr: accountValue.toXDR("base64"),
              },
            ],
          },
        }),
      ),
  );
  t.mock.method(
    rpc.Server.prototype,
    "getAccount",
    async () => new Account(keypair.publicKey(), "1"),
  );
  t.mock.method(rpc.Server.prototype, "getLedgerEntries", async () => ({
    entries: [
      {
        key: ledgerKey.toXDR("base64"),
        xdr: existingEntry.toXDR("base64"),
      },
    ],
  }));
  t.mock.method(
    rpc.Server.prototype,
    "simulateTransaction",
    async () => response,
  );
  return runMeasurement({
    fixturesPath: path.join(dir, "fixtures.json"),
    fixtureId: "fixtures.json",
    keyFile: path.join(dir, "key"),
    gitCommit: "test-replay",
    sdkVersion: "25.3.1",
    helperPath: path.join(dir, "missing-helper"),
  });
}

for (const [revision, capture] of [
  ["base", base],
  ["head", head],
]) {
  test(`${revision}: missing native helper fails explicitly and produces no benchmark`, async (t) => {
    const parsed = rpc.parseRawSimulation(capture.raw.result);
    const prepare = t.mock.method(
      rpc.Server.prototype,
      "prepareTransaction",
      async () => {
        throw new Error(
          "Should not prepare another transaction after unavailable compute",
        );
      },
    );
    await assert.rejects(
      replay(t, parsed),
      /Simulation helper missing or not executable/,
    );
    assert.equal(prepare.mock.callCount(), 0);
  });
}

test("a larger transaction instruction budget cannot masquerade as measured CPU", async (t) => {
  const parsed = rpc.parseRawSimulation(head.raw.result);
  parsed.transactionData.setResources(99999999, 12345, 54321);
  await assert.rejects(
    replay(t, parsed),
    /Simulation helper missing or not executable/,
  );
});

test("legacy cost values are not trusted as an unverified consumption source", async (t) => {
  const parsed = rpc.parseRawSimulation(base.raw.result);
  parsed.cost = { cpuInsns: "1234", memBytes: "5678" };
  await assert.rejects(
    replay(t, parsed),
    /Simulation helper missing or not executable/,
  );
});

test("simulation errors retain their original failure reason", async (t) => {
  await assert.rejects(
    replay(t, {
      _parsed: true,
      latestLedger: 1,
      events: [],
      error: "HostError(Budget, LimitExceeded)",
    }),
    /Simulation failed for hello: HostError\(Budget, LimitExceeded\)/,
  );
});

test("a response without transaction data fails before attempting metric extraction", async (t) => {
  await assert.rejects(
    replay(t, { _parsed: true, latestLedger: 1, events: [] }),
    /Simulation did not return transaction data for hello/,
  );
});

test("deployment probe failures do not masquerade as an absent contract", async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-deploy-probe-test-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keypair = Keypair.random();
  fs.writeFileSync(path.join(dir, "key"), keypair.secret(), { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "contract.wasm"),
    Buffer.from("test-only-wasm"),
  );
  fs.writeFileSync(
    path.join(dir, "fixtures.json"),
    JSON.stringify({
      contracts: [
        {
          id: "greeting",
          wasm_path: "contract.wasm",
          invocations: [
            {
              id: "world",
              function_name: "hello",
              args: [{ type: "Symbol", value: "world" }],
            },
          ],
        },
      ],
    }),
  );
  const rows =
    require("../docs/experiments/fixture-migration/bridge/rpc.json").flatMap(
      (c) => c.raw.result?.entries || [],
    );
  const accountRow = rows.find((e) => {
    try {
      return (
        xdr.LedgerEntryData.fromXDR(e.xdr, "base64").switch().name === "account"
      );
    } catch {
      return false;
    }
  });
  const readyKey = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: keypair.xdrPublicKey() }),
  ).toXDR("base64");
  const accountValue = xdr.LedgerEntryData.fromXDR(accountRow.xdr, "base64");
  accountValue.account().accountId(keypair.xdrPublicKey());
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          latestLedger: 100,
          entries: [{ key: readyKey, xdr: accountValue.toXDR("base64") }],
        },
      }),
    );
  });
  t.mock.method(
    rpc.Server.prototype,
    "getAccount",
    async () => new Account(keypair.publicKey(), "1"),
  );
  t.mock.method(rpc.Server.prototype, "getLedgerEntries", async () => {
    throw new Error("deployment probe transport failure");
  });
  const sendTransaction = t.mock.method(
    rpc.Server.prototype,
    "sendTransaction",
    async () => {
      throw new Error("should not send upload or create transaction");
    },
  );
  const prepareTransaction = t.mock.method(
    rpc.Server.prototype,
    "prepareTransaction",
    async () => {
      throw new Error("should not prepare upload or create transaction");
    },
  );
  await assert.rejects(
    () =>
      runMeasurement({
        fixturesPath: path.join(dir, "fixtures.json"),
        fixtureId: "fixtures.json",
        keyFile: path.join(dir, "key"),
        gitCommit: "test-deploy-probe",
        sdkVersion: "25.3.1",
        helperPath: path.join(dir, "missing-helper"),
      }),
    /Deployment probe failed for contract .*: deployment probe transport failure/,
  );
  assert.equal(sendTransaction.mock.callCount(), 0);
  assert.equal(prepareTransaction.mock.callCount(), 0);
});
