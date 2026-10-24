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
const TEST_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

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

const cp = require("node:child_process");
const { EventEmitter } = require("node:events");
const { metricsFromSimulation } = require("../dist/measurement");
const nativeRecord = require("../docs/experiments/repeatability/completed/run-1-native.json")[0];

// Replay captured responses through the public measurement entry point.
// RPC transport is isolated here; these tests do not claim a live measurement.
async function replay(t, response, options = {}) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-simulation-test-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keypair = Keypair.random();
  fs.writeFileSync(path.join(dir, "key"), keypair.secret(), { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, "contract.wasm"),
    TEST_WASM,
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
    .update(TEST_WASM)
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
  const accountKey = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: keypair.xdrPublicKey() }),
  ).toXDR("base64");

  const counts = options.counts ?? {
    simulate: 0,
    getNetwork: 0,
    getLedgerEntries: 0,
    getLedgers: 0,
  };
  if (options.counts) {
    options.counts.simulate = 0;
    options.counts.getNetwork = 0;
    options.counts.getLedgerEntries = 0;
    options.counts.getLedgers = 0;
  }
  let activeSimulationLedger = null;

  t.mock.method(globalThis, "fetch", async (url, fetchOptions) => {
    const req = JSON.parse(fetchOptions.body);
    if (options.onRequest) {
      const custom = await options.onRequest(req);
      if (custom !== undefined) return custom;
    }
    if (req.method === "getNetwork") {
      counts.getNetwork++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            passphrase: "Standalone Network ; February 2017",
            protocolVersion: 28,
          },
        }),
      );
    }
    if (req.method === "simulateTransaction") {
      counts.simulate++;
      if (options.onSimulate) {
        const res = options.onSimulate(counts.simulate, req);
        const sim = JSON.parse(await res.clone().text())?.result;
        if (sim?.latestLedger) activeSimulationLedger = sim.latestLedger;
        return res;
      }
      const rawResult = response?.raw ? response.raw.result : response;
      if (rawResult?.latestLedger)
        activeSimulationLedger = rawResult.latestLedger;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: req.id, result: rawResult }),
      );
    }
    if (req.method === "getLedgerEntries") {
      counts.getLedgerEntries++;
      const keys = req.params?.keys || [];
      const rawResult = response?.raw ? response.raw.result : response;
      const ledger =
        options.ledgerSeq ??
        (activeSimulationLedger ?? (rawResult?.latestLedger ?? 100));
      const entries = nativeRecord.input.entries
        .filter((row) => keys.includes(row.key))
        .map((row) => ({
          key: row.key,
          xdr: row.xdr,
          extXdr: row.extension_xdr,
          lastModifiedLedgerSeq: ledger,
        }));
      if (keys.includes(accountKey)) {
        entries.push({
          key: accountKey,
          xdr: accountValue.toXDR("base64"),
          extXdr: "",
          lastModifiedLedgerSeq: ledger,
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            latestLedger: ledger,
            entries,
          },
        }),
      );
    }
    if (req.method === "getLedgers") {
      counts.getLedgers++;
      const rawResult = response?.raw ? response.raw.result : response;
      const ledger =
        options.ledgerSeq ??
        (activeSimulationLedger ?? (rawResult?.latestLedger ?? 100));
      const header = xdr.LedgerHeader.fromXDR(
        nativeRecord.input.header_xdr,
        "base64",
      );
      header.ledgerSeq(ledger);
      header.ledgerVersion(28);
      const headerHash = crypto
        .createHash("sha256")
        .update(header.toXDR())
        .digest();
      const history = new xdr.LedgerHeaderHistoryEntry({
        hash: headerHash,
        header,
        ext: new xdr.LedgerHeaderHistoryEntryExt(0),
      });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            ledgers: [
              { sequence: ledger, headerXdr: history.toXDR("base64") },
            ],
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }),
    );
  });

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

  const helperPath =
    options.helperPath ??
    (options.useValidHelper ? process.execPath : path.join(dir, "missing-helper"));
  return runMeasurement({
    fixturesPath: path.join(dir, "fixtures.json"),
    fixtureId: "fixtures.json",
    keyFile: path.join(dir, "key"),
    gitCommit: "test-replay",
    sdkVersion: "25.3.1",
    helperPath,
  });
}

for (const [revision, capture] of [
  ["base", base],
  ["head", head],
]) {
  test(`${revision}: missing native helper fails explicitly and produces no benchmark`, async (t) => {
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
      replay(t, capture),
      /Simulation helper missing or not executable/,
    );
    assert.equal(prepare.mock.callCount(), 0);
  });
}

test("a larger transaction instruction budget cannot masquerade as measured CPU", async (t) => {
  const altered = structuredClone(head);
  const data = xdr.SorobanTransactionData.fromXDR(
    altered.raw.result.transactionData,
    "base64",
  );
  data.resources().instructions(99999999);
  altered.raw.result.transactionData = data.toXDR("base64");
  await assert.rejects(
    replay(t, altered),
    /Simulation helper missing or not executable/,
  );
});

test("legacy cost values are not trusted as an unverified consumption source", async (t) => {
  const altered = structuredClone(base);
  altered.raw.result.cost = { cpuInsns: "1234", memBytes: "5678" };
  await assert.rejects(
    replay(t, altered),
    /Simulation helper missing or not executable/,
  );
});

test("simulation errors retain their original failure reason", async (t) => {
  await assert.rejects(
    replay(
      t,
      {
        _parsed: true,
        latestLedger: 1,
        events: [],
        error: "HostError(Budget, LimitExceeded)",
      },
      { useValidHelper: true },
    ),
    /Simulation failed for hello \(id:world\): HostError\(Budget, LimitExceeded\)/,
  );
});

test("a response without transaction data fails before attempting metric extraction", async (t) => {
  await assert.rejects(
    replay(
      t,
      { _parsed: true, latestLedger: 1, events: [] },
      { useValidHelper: true },
    ),
    /Simulation did not return transaction data for hello \(id:world\)/,
  );
});

test("simulation returning invalid transaction data XDR fails with function and case context", async (t) => {
  await assert.rejects(
    replay(
      t,
      {
        latestLedger: 100,
        events: [],
        transactionData: "not-valid-xdr-base64!!!",
        results: [{ xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
      },
      { useValidHelper: true },
    ),
    /Simulation returned invalid transaction data for hello \(id:world\)/,
  );
});

test("simulation returning unsupported result shapes fails with function and case context", async (t) => {
  // Empty results array
  await assert.rejects(
    replay(
      t,
      {
        latestLedger: 100,
        events: [],
        transactionData: base.raw.result.transactionData,
        results: [],
      },
      { useValidHelper: true },
    ),
    /Simulation returned unsupported result shape for hello \(id:world\)/,
  );

  // Multiple results
  await assert.rejects(
    replay(
      t,
      {
        latestLedger: 100,
        events: [],
        transactionData: base.raw.result.transactionData,
        results: [
          { xdr: xdr.ScVal.scvVoid().toXDR("base64") },
          { xdr: xdr.ScVal.scvVoid().toXDR("base64") },
        ],
      },
      { useValidHelper: true },
    ),
    /Simulation returned unsupported result shape for hello \(id:world\)/,
  );
});

test("simulation returning invalid return value XDR fails with function and case context", async (t) => {
  await assert.rejects(
    replay(
      t,
      {
        latestLedger: 100,
        events: [],
        transactionData: base.raw.result.transactionData,
        results: [{ xdr: "not-a-valid-scval-xdr" }],
      },
      { useValidHelper: true },
    ),
    /Simulation returned unsupported result shape for hello \(id:world\): invalid return value XDR/,
  );
});

test("native simulation failure is closed: missing helper fails without metric fallback", async (t) => {
  await assert.rejects(
    replay(t, base),
    /Simulation helper missing or not executable/,
  );
});

test("local simulation disagreement with RPC fails closed", async (t) => {
  t.mock.method(cp, "execFile", (_file, _args, _childOptions, callback) => {
    const altered = structuredClone(nativeRecord.output);
    altered.retval_xdr = xdr.ScVal.scvU32(9999).toXDR("base64");
    const stdin = new EventEmitter();
    stdin.end = () => {
      setImmediate(() => callback(null, JSON.stringify(altered), ""));
    };
    return { stdin };
  });

  await assert.rejects(
    replay(t, base, { helperPath: process.execPath }),
    /Local simulation disagrees with RPC at captured ledger.*return-value disagreement/,
  );
});

const helperOutputForSim = (simResult) => {
  const data = xdr.SorobanTransactionData.fromXDR(
    simResult.transactionData,
    "base64",
  );
  const resources = data.resources();
  const output = structuredClone(nativeRecord.output);
  output.transaction_data_xdr = simResult.transactionData;
  output.retval_xdr = simResult.results[0].xdr;
  output.contract_events_xdr = [];
  output.instruction_budget = resources.instructions();
  output.disk_read_bytes = resources.diskReadBytes();
  output.write_bytes = resources.writeBytes();
  output.read_only_keys = resources
    .footprint()
    .readOnly()
    .map((k) => k.toXDR("base64"));
  output.read_write_keys = resources
    .footprint()
    .readWrite()
    .map((k) => k.toXDR("base64"));
  return output;
};

test("recapture makes fresh simulation requests and does not reuse stale preliminary result", async (t) => {
  let simAttempt = 0;
  const returnedSimulations = [];
  t.mock.method(cp, "execFile", (_file, _args, _childOptions, callback) => {
    const currentSim = returnedSimulations[returnedSimulations.length - 1];
    const output = helperOutputForSim(currentSim);
    const stdin = new EventEmitter();
    stdin.end = () => {
      setImmediate(() => callback(null, JSON.stringify(output), ""));
    };
    return { stdin };
  });

  const counts = {};
  const results = await replay(t, base, {
    counts,
    helperPath: process.execPath,
    onSimulate: (callCount, req) => {
      simAttempt++;
      const currentLedger = 1000 + simAttempt;
      const sim = {
        ...base.raw.result,
        latestLedger: currentLedger,
      };
      returnedSimulations.push(sim);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: req.id, result: sim }),
      );
    },
    onRequest: async (req) => {
      // Cause ledger drift on first attempt
      if (req.method === "getLedgerEntries" && simAttempt === 1) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              latestLedger: 1002, // Drifts from 1001
              entries: [],
            },
          }),
        );
      }
    },
  });

  assert.equal(
    simAttempt,
    2,
    "Must perform a fresh simulation on recapture attempt",
  );
  assert.equal(returnedSimulations.length, 2);
  assert.equal(returnedSimulations[0].latestLedger, 1001);
  assert.equal(returnedSimulations[1].latestLedger, 1002);
  assert.equal(results.length, 1);
  assert.equal(results[0].benchmarks[0].provenance.ledger, 1002);
});

test("proven: stable successful path makes exactly one simulation request without SDK preliminary call", async (t) => {
  t.mock.method(cp, "execFile", (_file, _args, _childOptions, callback) => {
    const output = helperOutputForSim(base.raw.result);
    const stdin = new EventEmitter();
    stdin.end = () => {
      setImmediate(() => callback(null, JSON.stringify(output), ""));
    };
    return { stdin };
  });

  const serverSimulateSpy = t.mock.method(
    rpc.Server.prototype,
    "simulateTransaction",
    async () => {
      throw new Error("Preliminary server.simulateTransaction must NOT be called");
    },
  );

  const counts = {};
  const results = await replay(t, base, {
    counts,
    helperPath: process.execPath,
    ledgerSeq: base.raw.result.latestLedger,
  });

  // Verify exactly one simulateTransaction RPC call was made (0 preliminary + 1 authoritative)
  assert.equal(
    counts.simulate,
    1,
    "Stable successful path must make exactly one simulation request",
  );
  assert.equal(
    serverSimulateSpy.mock.callCount(),
    0,
    "Unused SDK simulateTransaction must not be called",
  );

  // Verify benchmark results, metrics, and provenance semantics are fully preserved
  assert.equal(results.length, 1);
  const benchmark = results[0].benchmarks[0];
  assert.equal(benchmark.function_name, "hello");
  assert.equal(benchmark.case_id, "id:world");
  assert.equal(benchmark.provenance.source, "soroban-simulation");
  assert.equal(benchmark.provenance.protocol, 28);
  assert.equal(benchmark.provenance.ledger, base.raw.result.latestLedger);
  assert.equal(
    benchmark.metrics.cpu_instructions.consumed,
    nativeRecord.output.cpu_instructions_consumed,
  );
  assert.equal(
    benchmark.metrics.memory_bytes.consumed,
    nativeRecord.output.memory_bytes_consumed,
  );
  assert.equal(benchmark.metrics.tx_size_bytes.availability, "unavailable");
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
    TEST_WASM,
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
