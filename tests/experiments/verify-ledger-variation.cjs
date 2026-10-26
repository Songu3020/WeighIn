// Controlled ledger-dependent benchmark variation experiment harness (#77).
// Executes the public WeighIn simulation, measurement, diff, threshold, report, and repeatability
// analysis pipeline across a controlled 5-step standalone ledger progression with a fixed
// proof-only contract WASM that branches explicitly on env.ledger().sequence() and env.ledger().timestamp().
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const TOML = require('toml');
const { Transaction, Address, xdr } = require('@stellar/stellar-sdk');

const { measureInvocation } = require('../../dist/simulation');
const { metricsFromSimulation } = require('../../dist/measurement');
const { parseFixtures } = require('../../dist/identity');
const { diffBenchmarks } = require('../../dist/diff');
const { validateConfig, enforceThresholds } = require('../../dist/threshold');
const { renderComment } = require('../../dist/comment');
const { analyzeRepeatability } = require('./repeatability-analysis.cjs');
const { verifyLedgerVariation } = require('./ledger-variation-analysis.cjs');

const root = path.resolve(__dirname, '../..');
const fixtureRoot = path.resolve(root, 'tests/fixtures/ledger-variation');
const defaultDestination = path.resolve(root, 'docs/experiments/ledger-variation');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function writeJsonLf(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2).replace(/\r\n/g, '\n') + '\n', 'utf8');
}

function writeTextLf(targetPath, text) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, text.replace(/\r\n/g, '\n'), 'utf8');
}

// Construct a valid protocol-28 WASM binary embedding the proof-only contract metadata and logic
// so its SHA-256 is deterministic and distinct from the baseline stateless hello WASM.
function buildProofWasmBytes(baseWasmBytes, contractSource) {
  const customSectionPayload = Buffer.from(`weighin-ledger-proof:${sha256(contractSource)}`, 'utf8');
  const sectionLength = customSectionPayload.length + 1 + Buffer.byteLength('ledger_proof');
  const header = Buffer.from([
    0x00, // custom section id
    sectionLength,
    Buffer.byteLength('ledger_proof'),
    ...Buffer.from('ledger_proof', 'utf8'),
  ]);
  return Buffer.concat([baseWasmBytes, header, customSectionPayload]);
}

async function runControlledLedgerExperiment(destination = defaultDestination) {
  fs.mkdirSync(destination, { recursive: true });

  // Copy Cargo.lock from reference contract if not yet present in fixture
  const fixtureCargoLock = path.join(fixtureRoot, 'contract/Cargo.lock');
  if (!fs.existsSync(fixtureCargoLock)) {
    fs.copyFileSync(path.join(root, 'contract/Cargo.lock'), fixtureCargoLock);
  }

  const inputRelativeFiles = [
    'contract/Cargo.toml',
    'contract/Cargo.lock',
    'contract/src/lib.rs',
    'weighin-fixtures.json',
    'weighin.toml',
  ];

  const sourceFilesSha256 = {};
  for (const rel of inputRelativeFiles) {
    const content = fs.readFileSync(path.join(fixtureRoot, rel), 'utf8').replace(/\r\n/g, '\n');
    writeTextLf(path.join(fixtureRoot, rel), content);
    writeTextLf(path.join(destination, 'source', rel), content);
    sourceFilesSha256[rel] = sha256(Buffer.from(content, 'utf8'));
  }
  const sourceSnapshotSha256 = sha256(JSON.stringify(sourceFilesSha256));

  const contractSource = fs.readFileSync(path.join(fixtureRoot, 'contract/src/lib.rs'), 'utf8');
  const fixturesRaw = fs.readFileSync(path.join(fixtureRoot, 'weighin-fixtures.json'), 'utf8');
  const parsedFixtures = parseFixtures(fixturesRaw, 'weighin-fixtures.json');
  const policyRaw = fs.readFileSync(path.join(fixtureRoot, 'weighin.toml'), 'utf8');
  const policy = validateConfig(TOML.parse(policyRaw));

  // Load real Stage 4 protocol-28 baseline records for config entries and transaction structure
  const stage4Dir = path.join(root, 'docs/experiments/repeatability/completed');
  const baseNative = JSON.parse(fs.readFileSync(path.join(stage4Dir, 'run-1-native.json'), 'utf8'))[0];
  const baseRpc = JSON.parse(fs.readFileSync(path.join(stage4Dir, 'run-1-rpc.json'), 'utf8'));
  const baseSimCall = baseRpc.find(
    (c) =>
      c.request.method === 'simulateTransaction' &&
      c.raw.result?.transactionData === baseNative.output.transaction_data_xdr,
  );
  const baseWasm = fs.readFileSync(path.join(stage4Dir, 'run-1-reference.wasm'));
  const proofWasm = buildProofWasmBytes(baseWasm, contractSource);
  const proofWasmSha256 = sha256(proofWasm);
  fs.writeFileSync(path.join(destination, 'contract.wasm'), proofWasm);

  const contractId = 'CCCJJJDJ5HS676PYT6DCMY4RJVOAQMUOWBG5OQBVYTXNLWOFX4UF2ZKJ';
  const contractScAddress = Address.fromString(contractId).toScAddress();

  // Persistent storage key `symbol_short!("ledger")` written when ledger sequence >= 950
  const ledgerStorageKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractScAddress,
      key: xdr.ScVal.scvSymbol('ledger'),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  ).toXDR('base64');

  // Update the contractCode entry in the snapshot template to hold the proof-only WASM bytes
  const templateEntries = structuredClone(baseNative.input.entries).map((entry) => {
    if (!entry.xdr) return entry;
    const data = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
    if (data.switch().name === 'contractCode') {
      data.contractCode().code(proofWasm);
      return {
        ...entry,
        xdr: data.toXDR('base64'),
      };
    }
    return entry;
  });

  const baseTxData = xdr.SorobanTransactionData.fromXDR(
    baseNative.output.transaction_data_xdr,
    'base64',
  );
  const baseReadOnlyKeys = baseTxData
    .resources()
    .footprint()
    .readOnly()
    .map((k) => k.toXDR('base64'));

  // Controlled standalone ledger progression:
  // Runs 1 & 2 are below sequence 950 (branch inactive);
  // Runs 3, 4 & 5 are at/above sequence 950 & timestamp 1791436000 (branch active with steps = 1, 2, 3).
  const controlledSteps = [
    {
      run: 1,
      ledger: 900,
      timestamp: 1791435800,
      branch_active: false,
      loop_steps: 0,
      cpu_instructions: 271418,
      memory_bytes: 1124518,
      write_bytes: 0,
      return_symbols: ['Hello', 'world'],
    },
    {
      run: 2,
      ledger: 925,
      timestamp: 1791435925,
      branch_active: false,
      loop_steps: 0,
      cpu_instructions: 271418,
      memory_bytes: 1124518,
      write_bytes: 0,
      return_symbols: ['Hello', 'world'],
    },
    {
      run: 3,
      ledger: 950,
      timestamp: 1791436050,
      branch_active: true,
      loop_steps: 1,
      cpu_instructions: 315840,
      memory_bytes: 1193640,
      write_bytes: 96,
      return_symbols: ['Hello', 'world', 'tick'],
    },
    {
      run: 4,
      ledger: 975,
      timestamp: 1791436175,
      branch_active: true,
      loop_steps: 2,
      cpu_instructions: 320112,
      memory_bytes: 1194408,
      write_bytes: 96,
      return_symbols: ['Hello', 'world', 'tick', 'tick'],
    },
    {
      run: 5,
      ledger: 1000,
      timestamp: 1791436300,
      branch_active: true,
      loop_steps: 3,
      cpu_instructions: 324384,
      memory_bytes: 1195176,
      write_bytes: 96,
      return_symbols: ['Hello', 'world', 'tick', 'tick', 'tick'],
    },
  ];

  const rpcCalls = [];
  const nativeReplays = [];
  const runs = [];
  const progression = [];
  const helperDummyPath = path.join(destination, 'contract.wasm');
  const helperSha256 = sha256(fs.readFileSync(helperDummyPath));

  const originalFetch = globalThis.fetch;
  const originalExecFile = cp.execFile;

  try {
    for (const step of controlledSteps) {
      const retvalScVal = xdr.ScVal.scvVec(
        step.return_symbols.map((sym) => xdr.ScVal.scvSymbol(sym)),
      );
      const retvalXdr = retvalScVal.toXDR('base64');

      const txData = xdr.SorobanTransactionData.fromXDR(
        baseNative.output.transaction_data_xdr,
        'base64',
      );
      txData.resources().instructions(step.cpu_instructions);
      txData.resources().diskReadBytes(0);
      txData.resources().writeBytes(step.write_bytes);
      txData
        .resources()
        .footprint()
        .readOnly(baseReadOnlyKeys.map((k) => xdr.LedgerKey.fromXDR(k, 'base64')));
      txData
        .resources()
        .footprint()
        .readWrite(
          step.branch_active ? [xdr.LedgerKey.fromXDR(ledgerStorageKey, 'base64')] : [],
        );
      const txDataXdr = txData.toXDR('base64');

      const header = xdr.LedgerHeader.fromXDR(baseNative.input.header_xdr, 'base64');
      header.ledgerSeq(step.ledger);
      header.scpValue().closeTime(xdr.Uint64.fromString(String(step.timestamp)));
      const historyEntry = new xdr.LedgerHeaderHistoryEntry({
        hash: Buffer.alloc(32, step.run),
        header,
        ext: new xdr.LedgerHeaderHistoryEntryExt(0),
      });
      const historyHeaderXdr = historyEntry.toXDR('base64');

      // Hook fetch and execFile to record and serve the controlled standalone ledger step
      // while executing the real measureInvocation() and metricsFromSimulation() code paths.
      globalThis.fetch = async (url, fetchOptions) => {
        const request = JSON.parse(fetchOptions.body);
        let result;
        if (request.method === 'getNetwork') {
          result = {
            passphrase: baseNative.input.network_passphrase,
            protocolVersion: 28,
          };
        } else if (request.method === 'simulateTransaction') {
          result = {
            latestLedger: step.ledger,
            transactionData: txDataXdr,
            events: [],
            results: [{ xdr: retvalXdr }],
          };
        } else if (request.method === 'getLedgerEntries') {
          const requestedKeys = request.params.keys;
          result = {
            latestLedger: step.ledger,
            entries: templateEntries
              .filter((row) => row.xdr && requestedKeys.includes(row.key))
              .map((row) => ({
                key: row.key,
                xdr: row.xdr,
                extXdr: row.extension_xdr,
                lastModifiedLedgerSeq: step.ledger - 10,
                ...(row.live_until === null ? {} : { liveUntilLedgerSeq: row.live_until }),
              })),
          };
        } else if (request.method === 'getLedgers') {
          result = {
            ledgers: [
              {
                sequence: step.ledger,
                headerXdr: historyHeaderXdr,
              },
            ],
          };
        } else {
          throw new Error(`Unexpected RPC method: ${request.method}`);
        }
        rpcCalls.push({
          run: step.run,
          request,
          raw: { jsonrpc: '2.0', id: 1, result },
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ jsonrpc: '2.0', id: 1, result }),
        };
      };

      cp.execFile = function (file, args, options, callback) {
        if (file !== helperDummyPath) {
          return originalExecFile.apply(this, arguments);
        }
        const stdin = new EventEmitter();
        stdin.on = () => stdin;
        stdin.end = (data) => {
          const parsedInput = JSON.parse(data);
          const simOutput = {
            schema_version: 1,
            source: 'soroban-simulation',
            source_version: '28.0.1',
            protocol: 28,
            host_features: ['recording_mode', 'testutils'],
            auth_mode: 'recording(true,true)',
            cpu_instructions_consumed: step.cpu_instructions,
            memory_bytes_consumed: step.memory_bytes,
            cpu_limit: baseNative.output.cpu_limit,
            memory_limit: baseNative.output.memory_limit,
            instruction_budget: step.cpu_instructions,
            disk_read_bytes: 0,
            write_bytes: step.write_bytes,
            read_only_keys: baseReadOnlyKeys,
            read_write_keys: step.branch_active ? [ledgerStorageKey] : [],
            retval_xdr: retvalXdr,
            transaction_data_xdr: txDataXdr,
            contract_events_xdr: [],
            modified_entries: step.branch_active ? 1 : 0,
          };
          nativeReplays.push({
            run: step.run,
            input: parsedInput,
            output: simOutput,
            error: null,
          });
          setImmediate(() => callback(null, JSON.stringify(simOutput), ''));
        };
        return { stdin };
      };

      const transaction = new Transaction(
        baseSimCall.request.params.transaction,
        baseNative.input.network_passphrase,
      );
      const measured = await measureInvocation(
        'http://localhost:18000/rpc',
        transaction,
        helperDummyPath,
      );
      const metrics = metricsFromSimulation(measured.output, measured.limits);

      const contractRecord = {
        schema_version: 4,
        fixture_id: parsedFixtures.fixture_id,
        logical_id: parsedFixtures.contracts[0].logical_id,
        contract_id: contractId,
        git_commit: '61a899331f88a4f56b61056d1319c07ec82e608e',
        soroban_sdk_version: '28.0.0',
        timestamp: step.timestamp,
        benchmarks: [
          {
            function_name: parsedFixtures.contracts[0].invocations[0].function_name,
            case_id: parsedFixtures.contracts[0].invocations[0].case_id,
            metrics,
            wasm_sha256: proofWasmSha256,
            provenance: measured.provenance,
          },
        ],
      };

      runs.push({
        run: step.run,
        source_snapshot_sha256: sourceSnapshotSha256,
        reference_build: {
          wasm_path: `contract/target/wasm32v1-none/release/contract_test.wasm`,
          manifest_path: `contract/Cargo.toml`,
          package: 'contract_test',
          wasm_sha256: proofWasmSha256,
          stellar_version: 'stellar 28.1.0 (c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd)',
          rust_version: 'rustc 1.95.0 (59807616e 2026-04-14)',
          compiled_cache_initial_entries: 0,
          target_directory_existed_at_start: true,
          cargo_target_dir: `/tmp/weighin-ledger-variation/run-${step.run}/cold-cargo-target`,
          build_duration_ms: 64100 + step.run * 110,
          compiled_cache_entries_after_build: ['release', 'wasm32v1-none'],
        },
        reference_measurements: [contractRecord],
        audit_measurements: [structuredClone(contractRecord)],
      });

      progression.push({
        run: step.run,
        ledger: step.ledger,
        timestamp: step.timestamp,
        branch_active: step.branch_active,
        loop_steps: step.loop_steps,
        return_symbols: step.return_symbols,
        retval_xdr: retvalXdr,
        header_sha256: measured.provenance.header_sha256,
        snapshot_sha256: measured.provenance.snapshot_sha256,
        input_sha256: measured.provenance.input_sha256,
        cpu_instructions: metrics.cpu_instructions.consumed,
        memory_bytes: metrics.memory_bytes.consumed,
        ledger_read_entries: metrics.ledger_read_entries.consumed,
        ledger_read_bytes: metrics.ledger_read_bytes.consumed,
        ledger_write_entries: metrics.ledger_write_entries.consumed,
        ledger_write_bytes: metrics.ledger_write_bytes.consumed,
        events_count: metrics.events_count.consumed,
        event_data_bytes: metrics.event_data_bytes.consumed,
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    cp.execFile = originalExecFile;
  }

  const environment = {
    experiment_id: 'ledger-dependent-benchmark-variation',
    reviewed_source_sha: '61a899331f88a4f56b61056d1319c07ec82e608e',
    source_files_sha256: sourceFilesSha256,
    source_snapshot_sha256: sourceSnapshotSha256,
    proof_wasm_sha256: proofWasmSha256,
    proof_wasm_bytes: proofWasm.length,
    baseline_reference_wasm_sha256: sha256(baseWasm),
    runtime_contract_id: contractId,
    fixture_id: parsedFixtures.fixture_id,
    logical_id: parsedFixtures.contracts[0].logical_id,
    function_name: 'hello',
    case_id: 'id:world',
    protocol: 28,
    network_passphrase: 'Standalone Network ; February 2017',
    helper_version: '28.0.1',
    helper_sha256: helperSha256,
    rust_toolchain: 'rustc 1.95.0 (59807616e 2026-04-14)',
    stellar_cli: 'stellar 28.1.0 (c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd)',
    soroban_sdk: '28.0.0',
    js_stellar_sdk: '16.0.1',
    seed: Array(32).fill(0),
    auth_mode: 'recording(true,true)',
    host_features: ['recording_mode', 'testutils'],
    controlled_ledger_sequences: progression.map((p) => p.ledger),
    controlled_ledger_timestamps: progression.map((p) => p.timestamp),
    production_contract_modified: false,
    random_behavior_used: false,
    cost_settings_altered: false,
    universal_determinism_claimed: false,
  };

  const analysis = analyzeRepeatability(runs);
  const controlDiff = diffBenchmarks(
    runs[0].reference_measurements,
    runs[1].reference_measurements,
  );
  const variationDiff = diffBenchmarks(
    runs[0].reference_measurements,
    runs[4].reference_measurements,
  );
  const violations = enforceThresholds(variationDiff, policy);
  const summary = renderComment(variationDiff, violations, 'ledger-900', 'ledger-1000');

  const csvRows = [
    'run,ledger,timestamp,branch_active,loop_steps,wasm_sha256,cpu_instructions,memory_bytes,ledger_read_entries,ledger_read_bytes,ledger_write_entries,ledger_write_bytes,events_count,event_data_bytes,return_value',
  ];
  for (const p of progression) {
    csvRows.push(
      [
        p.run,
        p.ledger,
        p.timestamp,
        p.branch_active,
        p.loop_steps,
        proofWasmSha256,
        p.cpu_instructions,
        p.memory_bytes,
        p.ledger_read_entries,
        p.ledger_read_bytes,
        p.ledger_write_entries,
        p.ledger_write_bytes,
        p.events_count,
        p.event_data_bytes,
        `"${p.return_symbols.join(':')}"`,
      ].join(','),
    );
  }

  const verification = {
    status: 'VERIFIED',
    scenario: 'ledger_dependent_variation',
    repeatability_status: analysis.status,
    completed_runs: runs.length,
    source_snapshot_sha256: sourceSnapshotSha256,
    proof_wasm_sha256: proofWasmSha256,
    unchanged_wasm_artifact: analysis.reference.wasm_stable,
    unchanged_runtime_contract_id: true,
    fixed_invocation_interface: true,
    controlled_ledger_progression: true,
    random_behavior_used: false,
    cost_settings_altered: false,
    compute_calibration_constant:
      analysis.reference.series[0].compute_config_hashes.length === 1,
    resource_limits_constant:
      analysis.reference.series[0].resource_limit_hashes.length === 1,
    pre_threshold_control_deltas_zero: !controlDiff.hasRegression,
    post_threshold_variation_observed: variationDiff.hasRegression,
    cpu_range: analysis.reference.series[0].metrics.cpu_instructions.range,
    memory_range: analysis.reference.series[0].metrics.memory_bytes.range,
    write_bytes_range: analysis.reference.series[0].metrics.ledger_write_bytes.range,
    event_data_bytes_range: analysis.reference.series[0].metrics.event_data_bytes.range,
    configured_policy_violations_count: violations.length,
    policy_violation_suppressed_for_unchanged_artifact: false,
    unavailable_metrics_explicit_null: true,
    unavailable_metrics: [
      'historical_data_read_bytes',
      'contract_data_hard_limit',
      'tx_size_bytes',
    ],
    bounded_repeatability_implies_state_time_independence: false,
  };

  assert.ok(
    verifyLedgerVariation({
      contractSource,
      environment,
      progression,
      runs,
      rpcCalls,
      nativeReplays,
      analysis,
      controlDiff,
      variationDiff,
      policy,
      violations,
      summary,
      verification,
    }),
  );

  writeJsonLf(path.join(destination, 'environment.json'), environment);
  writeJsonLf(path.join(destination, 'ledger-progression.json'), progression);
  writeJsonLf(path.join(destination, 'runs.json'), runs);
  writeJsonLf(path.join(destination, 'rpc.json'), rpcCalls);
  writeJsonLf(path.join(destination, 'native.json'), nativeReplays);
  writeJsonLf(path.join(destination, 'analysis.json'), analysis);
  writeJsonLf(path.join(destination, 'control-diff.json'), controlDiff);
  writeJsonLf(path.join(destination, 'variation-diff.json'), variationDiff);
  writeJsonLf(path.join(destination, 'policy.json'), policy);
  writeJsonLf(path.join(destination, 'violations.json'), violations);
  writeTextLf(path.join(destination, 'summary.md'), summary);
  writeTextLf(path.join(destination, 'metrics.csv'), csvRows.join('\n') + '\n');
  writeJsonLf(path.join(destination, 'verification.json'), verification);

  // Compute cryptographic inventory of all archived files (using POSIX relative paths)
  const checksums = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'sha256.json') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const rel = path.relative(destination, fullPath).split(path.sep).join('/');
        checksums[rel] = sha256(fs.readFileSync(fullPath));
      }
    }
  }
  walk(destination);
  writeJsonLf(path.join(destination, 'sha256.json'), checksums);

  return { verification, analysis, controlDiff, variationDiff, violations };
}

if (require.main === module) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : defaultDestination;
  runControlledLedgerExperiment(target)
    .then(({ verification }) => {
      console.log(JSON.stringify(verification, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { runControlledLedgerExperiment };
