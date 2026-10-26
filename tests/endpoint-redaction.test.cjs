// Controlled endpoint diagnostics tests. No live network: a require hook
// intercepts fetch, records the exact URL each entry point passes to the
// transport, and returns a deterministic failure. Synthetic credential values
// must never appear in stdout/stderr while the transport still receives the
// unchanged endpoint.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const hook = path.join(__dirname, "support", "endpoint-transport-hook.cjs");

const credentials = {
  user: "synthetic-credential-user",
  pass: "synthetic-credential-pass",
  query: "synthetic-credential-query",
  fragment: "synthetic-credential-fragment",
};
const secretUrl = `http://${credentials.user}:${credentials.pass}@127.0.0.1:8000/rpc?api_key=${credentials.query}&api_key=${credentials.query}#${credentials.fragment}`;
const sanitizedUrl =
  "http://127.0.0.1:8000/rpc?api_key=REDACTED&api_key=REDACTED";
const credentialPattern = /synthetic-credential/;

function assertNoCredentials(text) {
  assert.doesNotMatch(text, credentialPattern);
}

function runEntry(args, env = {}, cwd) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-endpoint-"));
  const capture = path.join(directory, "capture.jsonl");
  const result = spawnSync(process.execPath, ["--require", hook, ...args], {
    cwd: cwd ?? directory,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, WEIGHIN_ENDPOINT_CAPTURE: capture, ...env },
  });
  assert.ifError(result.error);
  const calls = fs.existsSync(capture)
    ? fs
        .readFileSync(capture, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { result, calls, directory };
}

test("CLI prints a sanitized RPC URL and never the credentials", () => {
  const { result } = runEntry([
    path.join(root, "dist", "cli.js"),
    "missing-fixtures.json",
    "--rpc-url",
    secretUrl,
  ]);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.ok(output.includes(`RPC URL:  ${sanitizedUrl}`), output);
  assertNoCredentials(output);
});

test("CLI reports a malformed endpoint as a safe placeholder", () => {
  const malformed = `not a url ${credentials.query}`;
  const { result } = runEntry([
    path.join(root, "dist", "cli.js"),
    "missing-fixtures.json",
    "--rpc-url",
    malformed,
  ]);
  const output = result.stdout + result.stderr;
  assert.ok(output.includes("RPC URL:  [invalid endpoint]"));
  assertNoCredentials(output);
});

test("CLI transport receives the unchanged endpoint while failures stay redacted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-fixtures-"));
  const fixtures = path.join(directory, "fixtures.json");
  fs.writeFileSync(
    path.join(directory, "dummy.wasm"),
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  );
  fs.writeFileSync(
    fixtures,
    JSON.stringify({
      contracts: [
        {
          wasm_path: "dummy.wasm",
          invocations: [{ function_name: "hello", args: [] }],
        },
      ],
    }),
  );
  const { result, calls } = runEntry(
    [path.join(root, "dist", "cli.js"), fixtures, "--rpc-url", secretUrl],
    {},
    directory,
  );
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.ok(output.includes(sanitizedUrl));
  assertNoCredentials(output);
  assert.ok(calls.length > 0, "transport must receive the readiness request");
  assert.ok(calls.every((call) => call.url === secretUrl));
});

test("the bundled Action reports a sanitized endpoint and sends the unchanged URL", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-action-endpoint-"),
  );
  const { result, calls } = runEntry(
    [path.join(root, "bundled", "index.js")],
    {
      WEIGHIN_ENDPOINT_MODE: "json-error",
      GITHUB_WORKSPACE: workspace,
      GITHUB_REPOSITORY: "WeighInNG/WeighIn",
      "INPUT_FIXTURES-PATH": "weighin-fixtures.json",
      "INPUT_RPC-URL": secretUrl,
    },
    workspace,
  );
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.ok(output.includes(`RPC URL:    ${sanitizedUrl}`));
  assert.ok(output.includes(`Checking RPC health at ${sanitizedUrl} ...`));
  assertNoCredentials(output);
  assert.ok(calls.length > 0, "transport must receive the health request");
  assert.ok(calls.every((call) => call.url === secretUrl));
});

test("malformed endpoints render a safe placeholder instead of the raw value", () => {
  const { sanitizeEndpoint, redactEndpointSecrets } = require("../dist/endpoint");
  assert.equal(sanitizeEndpoint(secretUrl), sanitizedUrl);
  assert.equal(
    sanitizeEndpoint(`not a url ${credentials.query}`),
    "[invalid endpoint]",
  );
  assert.match(
    redactEndpointSecrets(`failure at ${secretUrl}`, secretUrl),
    /api_key=REDACTED&api_key=REDACTED/,
  );
  const malformed = `not a url ${credentials.query}`;
  assertNoCredentials(redactEndpointSecrets(`failed: ${malformed}`, malformed));
});

test("account readiness transport errors never expose endpoint credentials", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { ensureAccountReady } = require("../dist/account");
  const { Keypair } = require("@stellar/stellar-sdk");
  const publicKey = Keypair.random().publicKey();
  const oldFetch = global.fetch;
  const oldNow = Date.now;
  const oldTimeout = global.setTimeout;
  const calls = [];
  let elapsed = 0;
  global.fetch = async (url) => {
    calls.push(url);
    throw new TypeError(`fetch failed for ${secretUrl}`);
  };
  Date.now = () => elapsed;
  global.setTimeout = (callback, delay, ...args) => {
    elapsed += delay;
    return setImmediate(callback, ...args);
  };
  try {
    await assert.rejects(
      ensureAccountReady(secretUrl, publicKey),
      (error) => {
        assertNoCredentials(error.message);
        assert.match(error.message, /transport failure at http:\/\/127\.0\.0\.1:8000/);
        return true;
      },
    );
    assert.ok(calls.length > 0);
    assert.ok(calls.every((url) => url === secretUrl));
  } finally {
    global.fetch = oldFetch;
    Date.now = oldNow;
    global.setTimeout = oldTimeout;
  }
});

test("simulation transport errors never expose endpoint credentials", async () => {
  const { measureInvocation } = require("../dist/simulation");
  const {
    Account,
    TransactionBuilder,
    Operation,
    Networks,
    Keypair,
  } = require("@stellar/stellar-sdk");
  const account = new Account(Keypair.random().publicKey(), "0");
  const transaction = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "1" }))
    .setTimeout(30)
    .build();
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return new Response("controlled failure", {
      status: 400,
      statusText: "Bad Request",
    });
  };
  try {
    await assert.rejects(
      measureInvocation(secretUrl, transaction, __filename),
      (error) => {
        assertNoCredentials(error.message);
        assert.match(error.message, /RPC getNetwork: HTTP 400 at http:\/\/127\.0\.0\.1:8000/);
        return true;
      },
    );
    assert.deepEqual(calls, [secretUrl]);
  } finally {
    global.fetch = oldFetch;
  }
});
