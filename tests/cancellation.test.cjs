const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureAccountReady } = require("../dist/account");
const { measureInvocation } = require("../dist/simulation");
const { runMeasurement } = require("../dist/measurement");
const { Keypair, TransactionBuilder, Networks, Operation } = require("@stellar/stellar-sdk");

test("ensureAccountReady rejects immediately when pre-aborted signal is passed", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller requested abort"));

  const keypair = Keypair.random();
  await assert.rejects(
    ensureAccountReady("http://localhost:8000/rpc", keypair.publicKey(), controller.signal),
    /caller requested abort/,
  );
});

test("ensureAccountReady aborts promptly during in-flight fetch", async () => {
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    // Check that signal is passed to fetch
    assert.ok(options?.signal, "fetch must receive a combined cancellation signal");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("ok")), 5000);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("fetch aborted by signal"));
      });
    });
  };

  try {
    const keypair = Keypair.random();
    const readyPromise = ensureAccountReady("http://localhost:8000/rpc", keypair.publicKey(), controller.signal);

    // Abort after a short delay while fetch is in-flight
    setTimeout(() => controller.abort(new Error("cancelled during fetch")), 20);

    const start = Date.now();
    await assert.rejects(readyPromise, /cancelled during fetch/);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `Expected prompt abort (<1000ms), took ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ensureAccountReady aborts promptly during retry delay without waiting full backoff", async () => {
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;

  let attempts = 0;
  globalThis.fetch = async (url) => {
    attempts++;
    // Return transient 503 so it enters the retry sleep loop
    return new Response("Service Unavailable", { status: 503 });
  };

  try {
    const keypair = Keypair.random();
    const readyPromise = ensureAccountReady("http://localhost:8000/rpc", keypair.publicKey(), controller.signal);

    // Abort shortly after the first failed attempt enters retry sleep (normally 2000ms)
    setTimeout(() => controller.abort(new Error("cancelled during backoff")), 50);

    const start = Date.now();
    await assert.rejects(readyPromise, /cancelled during backoff/);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `Expected prompt interruption of retry delay (<1000ms), took ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("measureInvocation rejects immediately when signal is pre-aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("pre-aborted simulation"));

  const keypair = Keypair.random();
  const tx = new TransactionBuilder(
    {
      accountId: () => keypair.publicKey(),
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    },
    { fee: "100", networkPassphrase: Networks.TESTNET },
  )
    .addOperation(
      Operation.invokeContractFunction({
        contract: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        function: "test",
        args: [],
      }),
    )
    .setTimeout(30)
    .build();

  await assert.rejects(
    measureInvocation("http://localhost:8000/rpc", tx, "/dummy/helper", { signal: controller.signal }),
    /pre-aborted simulation/,
  );
});

test("measureInvocation interrupts captive-core transient read backoff delay promptly", async () => {
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    if (body.method === "getNetwork") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { passphrase: Networks.TESTNET, protocolVersion: 28 } }));
    }
    const calls = require("../docs/experiments/repeatability/completed/run-1-rpc.json");
    const replay = require("../docs/experiments/repeatability/completed/run-1-native.json")[0];
    const saved = calls.find(
      (c) =>
        c.request.method === "simulateTransaction" &&
        c.raw.result?.transactionData === replay.output.transaction_data_xdr,
    );
    if (body.method === "simulateTransaction") {
      return new Response(JSON.stringify({ ...saved.raw, jsonrpc: "2.0", id: body.id }));
    }
    if (body.method === "getLedgerEntries") {
      // Simulate transient captive-core 404 error
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32603,
            message: "could not query captive core: http request failed with non-200 status code (404)",
          },
        }),
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
  };

  try {
    const keypair = Keypair.random();
    const tx = new TransactionBuilder(
      {
        accountId: () => keypair.publicKey(),
        sequenceNumber: () => "1",
        incrementSequenceNumber: () => {},
      },
      { fee: "100", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(
        Operation.invokeContractFunction({
          contract: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
          function: "test",
          args: [],
        }),
      )
      .setTimeout(30)
      .build();

    const measurePromise = measureInvocation("http://localhost:8000/rpc", tx, "/dummy/helper", {
      signal: controller.signal,
    });

    // Abort during the transient read backoff delay (normally 250ms+)
    setTimeout(() => controller.abort(new Error("cancelled during ledger read backoff")), 40);

    const start = Date.now();
    await assert.rejects(measurePromise, /cancelled during ledger read backoff/);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `Expected prompt abort of delay, took ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runMeasurement retains supplied keyFile and produces no successful benchmarks when cancelled", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-cancel-test-"));
  const keyFile = path.join(temporary, "persistent.key");
  const fixturesFile = path.join(temporary, "fixtures.json");
  fs.writeFileSync(keyFile, Keypair.random().secret());
  fs.writeFileSync(
    fixturesFile,
    JSON.stringify({
      contracts: [
        {
          wasm_path: "contract.wasm",
          invocations: [{ function_name: "test", args: [] }],
        },
      ],
    }),
  );

  const controller = new AbortController();
  controller.abort(new Error("caller aborted runMeasurement"));

  try {
    await assert.rejects(
      runMeasurement({
        fixturesPath: fixturesFile,
        gitCommit: "abc1234",
        sdkVersion: "28.0.0",
        keyFile,
        signal: controller.signal,
      }),
      /caller aborted runMeasurement/,
    );

    // Verify key file was preserved and not cleaned up
    assert.ok(fs.existsSync(keyFile), "caller-supplied reusable keyFile must be retained");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("simulateSnapshot terminates child process and rejects promptly when signal is aborted", async () => {
  const { simulateSnapshot } = require("../dist/simulation");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-cancel-child-"));
  // Create a helper mock script that sleeps indefinitely
  const mockHelper = path.join(temporary, "mock-helper.sh");
  fs.writeFileSync(mockHelper, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });

  const controller = new AbortController();
  const mockInput = {
    schema_version: 1,
    header_xdr: "AAAA",
    network_passphrase: "test",
    host_function_xdr: "BBBB",
    source_account_xdr: "CCCC",
    entries: [],
    instruction_leeway: 0,
    seed: Array(32).fill(0),
  };

  try {
    const promise = simulateSnapshot(mockInput, mockHelper, controller.signal);
    setTimeout(() => controller.abort(new Error("caller aborted helper execution")), 30);

    const start = Date.now();
    await assert.rejects(
      promise,
      /caller aborted helper execution|Simulation helper execution cancelled/,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `Expected prompt child kill (<1000ms), took ${elapsed}ms`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
