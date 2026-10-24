const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const requiredPackagedEntries = [
  "dist/measurement.js",
  "dist/cli.js",
  "bundled/index.js",
  "bundled/comment-action.js",
  "native/simulation/Cargo.toml",
  "native/simulation/Cargo.lock",
  "native/simulation/src/main.rs",
  "action.yml",
];

function runPackDryRun(t) {
  const packDestination = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-pack-dry-run-"),
  );
  t.after(() => fs.rmSync(packDestination, { recursive: true, force: true }));
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--pack-destination", packDestination],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120000,
    },
  );
  return { result, packDestination };
}

test("pack using normal lifecycle and verify installed consumer public API and CLI outside repo", (t) => {
  // 1. Pack using standard npm pack lifecycle
  const packDestination = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-pack-consumer-"),
  );
  t.after(() => fs.rmSync(packDestination, { recursive: true, force: true }));
  const packResult = spawnSync(
    "npm",
    ["pack", "--pack-destination", packDestination],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120000,
    },
  );
  assert.equal(packResult.status, 0, `npm pack failed: ${packResult.stderr}`);
  const lines = packResult.stdout.trim().split("\n");
  const tarballName = lines[lines.length - 1].trim();
  const tarballPath = path.join(packDestination, tarballName);
  assert.ok(fs.existsSync(tarballPath), `Expected tarball at ${tarballPath}`);

  // 2. Create isolated consumer directory outside repository
  const consumerDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-consumer-"),
  );
  t.after(() => {
    fs.rmSync(tarballPath, { force: true });
    fs.rmSync(consumerDir, { recursive: true, force: true });
  });

  // 3. Initialize consumer and install the packed tarball
  fs.writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({
      name: "isolated-consumer",
      private: true,
      version: "1.0.0",
    }),
  );
  const installResult = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", tarballPath],
    {
      cwd: consumerDir,
      encoding: "utf8",
      timeout: 60000,
    },
  );
  assert.equal(
    installResult.status,
    0,
    `npm install failed: ${installResult.stderr}`,
  );

  const installedPkgDir = path.join(consumerDir, "node_modules/weighin");
  assert.ok(
    fs.existsSync(installedPkgDir),
    "Installed weighin package directory must exist",
  );

  // 4. Verify public API resolution stays within the installed consumer node_modules
  const resolveScript = `
    const resolved = require.resolve('weighin');
    if (!resolved.startsWith(${JSON.stringify(consumerDir)})) {
      throw new Error('Resolved outside consumer: ' + resolved);
    }
    const api = require('weighin');
    if (typeof api.runMeasurement !== 'function' || typeof api.metricsFromSimulation !== 'function' || typeof api.toScVal !== 'function') {
      throw new Error('Installed package missing expected API functions');
    }
    console.log(JSON.stringify({ resolved, hasRunMeasurement: true, hasMetricsFromSimulation: true, hasToScVal: true }));
  `;
  const resolveRun = spawnSync(process.execPath, ["-e", resolveScript], {
    cwd: consumerDir,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(
    resolveRun.status,
    0,
    `Consumer API invocation failed: ${resolveRun.stderr}`,
  );
  const resolveOutput = JSON.parse(resolveRun.stdout.trim());
  assert.ok(
    resolveOutput.resolved.includes(
      path.join(consumerDir, "node_modules/weighin"),
    ),
  );

  // 5. Verify declared CLI binary in consumer
  const binPath = path.join(consumerDir, "node_modules/.bin/weighin");
  assert.ok(
    fs.existsSync(binPath),
    "Declared bin should be linked in consumer node_modules/.bin",
  );
  const binRun = spawnSync(binPath, [path.join(consumerDir, "missing.json")], {
    cwd: consumerDir,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(binRun.status, 1, "CLI should exit 1 on missing fixture");
  assert.match(binRun.stderr, /Benchmarking failed/);
  // Ensure the error refers to the consumer-relative failure, not repo checkout
  assert.doesNotMatch(binRun.stderr, new RegExp(path.join(repoRoot, "dist")));

  // 6. Verify packaged native helper files exist in consumer
  for (const relPath of [
    "native/simulation/Cargo.toml",
    "native/simulation/Cargo.lock",
    "native/simulation/src/main.rs",
  ]) {
    assert.ok(
      fs.existsSync(path.join(installedPkgDir, relPath)),
      `Packaged native helper missing ${relPath} in consumer`,
    );
  }

  // 7. Exercise supported real measurement extraction path from the consumer installation
  const replays = require(
    path.join(
      repoRoot,
      "docs/experiments/metric-provenance/native-replays.json",
    ),
  );
  const testConsumerScript = `
    const { metricsFromSimulation } = require('weighin');
    const replay = ${JSON.stringify(replays[0])};
    const limits = {
      cpu_instructions: 400000000,
      memory_bytes: 41943040,
      footprint_entries: 64,
      disk_read_bytes: 200000,
      write_entries: 50,
      write_bytes: 132096,
      events_and_return_bytes: 16384,
    };
    const metrics = metricsFromSimulation(replay.output, limits);
    if (!metrics || typeof metrics.cpu_instructions?.consumed !== 'number' || typeof metrics.memory_bytes?.consumed !== 'number') {
      throw new Error('metricsFromSimulation returned invalid metrics in consumer');
    }
    console.log('REPLAY_OK');
  `;
  const testConsumerRun = spawnSync(
    process.execPath,
    ["-e", testConsumerScript],
    {
      cwd: consumerDir,
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(testConsumerRun.status, 0, testConsumerRun.stderr);
  assert.match(testConsumerRun.stdout, /REPLAY_OK/);
});

test("tarball validator rejects an artifact missing required packaged entries", (t) => {
  // Query pack dry run entries
  const { result: dryRun } = runPackDryRun(t);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const packInfo = JSON.parse(dryRun.stdout);
  const packedFiles = new Set(packInfo[0].files.map((f) => f.path));

  // Function to validate required packaged entries
  function validatePackagedEntries(fileSet) {
    const missing = requiredPackagedEntries.filter((req) => !fileSet.has(req));
    if (missing.length > 0) {
      throw new Error(
        `Tarball missing required entries: ${missing.join(", ")}`,
      );
    }
    return true;
  }

  // Complete file set passes
  assert.equal(validatePackagedEntries(packedFiles), true);

  // Missing entry in simulated tarball fails even if source checkout has it
  const incompleteSet = new Set(packedFiles);
  incompleteSet.delete("native/simulation/Cargo.toml");
  assert.throws(
    () => validatePackagedEntries(incompleteSet),
    /Tarball missing required entries: native\/simulation\/Cargo.toml/,
  );
});

test("distinguishes inclusion-only dry run from real installed consumer execution", (t) => {
  // Dry-run only checks inclusion list
  const { result: dryRun, packDestination } = runPackDryRun(t);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const packInfo = JSON.parse(dryRun.stdout);
  assert.ok(Array.isArray(packInfo[0].files));
  // Dry run did not write a tarball into its isolated destination.
  assert.deepEqual(fs.readdirSync(packDestination), []);
});
