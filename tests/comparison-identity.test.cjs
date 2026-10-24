const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StrKey } = require('@stellar/stellar-sdk');
const { parseFixtures } = require('../dist/identity');
const { diffBenchmarks } = require('../dist/diff');
const { enforceThresholds } = require('../dist/threshold');
const { renderComment } = require('../dist/comment');

const baseAddress = StrKey.encodeContract(Buffer.alloc(32, 1));
const headAddress = StrKey.encodeContract(Buffer.alloc(32, 2));
const baseHash = 'a'.repeat(64);
const headHash = 'b'.repeat(64);

function metrics(cpu = 10000) {
  return {
    cpu_instructions: { consumed: cpu, limit: 100000000 },
    memory_bytes: { consumed: 2048, limit: 41943040 },
    ledger_read_entries: { consumed: 2, limit: 100 },
    ledger_read_bytes: { consumed: 512, limit: 200000 },
    ledger_write_entries: { consumed: 0, limit: 50 },
    ledger_write_bytes: { consumed: 0, limit: 132096 },
    historical_data_read_bytes: { consumed: 0, limit: 0 },
    contract_data_hard_limit: { consumed: 128, limit: 65536 },
    tx_size_bytes: { consumed: 320, limit: 132096 },
    events_count: { consumed: 0, limit: 100 },
    event_data_bytes: { consumed: 32, limit: 16384 },
  };
}

function invocation(id = 'world', function_name = 'hello', value = 'world') {
  return { ...(id === undefined ? {} : { id }), function_name, args: [{ type: 'Symbol', value }] };
}

function fixture(invocations = [invocation()], contractId = 'greeting') {
  return {
    contracts: [{ id: contractId, wasm_path: 'contract/target/wasm32v1-none/release/contract_test.wasm', invocations }],
  };
}

// Complete measurement records, using the same public fixture resolution as
// runMeasurement. Runtime addresses/hashes deliberately differ across revisions.
function measurement(input = fixture(), options = {}) {
  const identified = parseFixtures(JSON.stringify(input), options.fixturePath ?? 'weighin-fixtures.json');
  return identified.contracts.map((contract) => ({
    schema_version: 2,
    fixture_id: identified.fixture_id,
    logical_id: contract.logical_id,
    contract_id: options.address ?? baseAddress,
    git_commit: options.commit ?? '1'.repeat(40),
    soroban_sdk_version: '25.3.1',
    timestamp: 1791396000,
    benchmarks: contract.invocations.map((fn) => ({
      function_name: fn.function_name,
      case_id: fn.case_id,
      metrics: metrics(options.cpuByCase?.[fn.case_id] ?? options.cpu ?? 10000),
      wasm_sha256: options.hash ?? baseHash,
    })),
  }));
}

function cpu(diff, index = 0) {
  return diff.contracts[0].functions[index].metrics.find((metric) => metric.key === 'cpu_instructions');
}

test('identical logical contract, fixture, function, and case pair successfully', () => {
  const diff = diffBenchmarks(measurement(), measurement());
  assert.equal(diff.contracts.length, 1);
  assert.equal(diff.contracts[0].functions.length, 1);
  assert.deepEqual(diff.newContracts, []);
  assert.deepEqual(diff.removedContracts, []);
  assert.equal(cpu(diff).delta, 0);
  assert.equal(diff.hasRegression, false);
});

test('changed WASM hash and runtime address still pair as the configured benchmark', () => {
  const base = measurement();
  const head = measurement(fixture(), { address: headAddress, hash: headHash, commit: '2'.repeat(40), cpu: 12500 });
  const diff = diffBenchmarks(base, head);
  assert.equal(diff.contracts.length, 1);
  assert.equal(diff.contracts[0].logical_id, 'id:greeting');
  assert.equal(diff.contracts[0].base_contract_id, baseAddress);
  assert.equal(diff.contracts[0].head_contract_id, headAddress);
  assert.equal(cpu(diff).delta, 2500);
  assert.deepEqual(diff.newContracts, []);
  assert.deepEqual(diff.removedContracts, []);
});

test('different logical contracts do not pair, even at the same runtime address', () => {
  const diff = diffBenchmarks(measurement(), measurement(fixture([invocation()], 'unrelated')));
  assert.equal(diff.contracts.length, 0);
  assert.equal(diff.newContracts.length, 1);
  assert.equal(diff.removedContracts.length, 1);
});

test('different functions do not pair within the same logical contract', () => {
  const diff = diffBenchmarks(measurement(), measurement(fixture([invocation('world', 'goodbye')])));
  assert.equal(diff.contracts[0].functions.length, 0);
  assert.deepEqual(diff.contracts[0].newFunctions, ['goodbye']);
  assert.deepEqual(diff.contracts[0].removedFunctions, ['hello']);
});

test('multiple cases of one function compare independently even when reordered', () => {
  const base = measurement(fixture([invocation('small'), invocation('large')]), {
    cpuByCase: { 'id:small': 10000, 'id:large': 20000 },
  });
  const head = measurement(fixture([invocation('large'), invocation('small')]), {
    address: headAddress, hash: headHash, cpuByCase: { 'id:small': 9000, 'id:large': 25000 },
  });
  const diff = diffBenchmarks(base, head);
  const cases = new Map(diff.contracts[0].functions.map((fn) => [fn.case_id, fn.metrics[0].delta]));
  assert.deepEqual(cases, new Map([['id:large', 5000], ['id:small', -1000]]));
  assert.deepEqual(diff.contracts[0].newBenchmarks, []);
  assert.deepEqual(diff.contracts[0].removedBenchmarks, []);
});

test('removed case is reported even if its function still has other cases', () => {
  const diff = diffBenchmarks(measurement(fixture([invocation('small'), invocation('large')])), measurement(fixture([invocation('small')])));
  assert.deepEqual(diff.contracts[0].removedBenchmarks, [{ function_name: 'hello', case_id: 'id:large' }]);
  assert.deepEqual(diff.contracts[0].removedFunctions, []);
});

test('new case is reported even if its function already exists', () => {
  const diff = diffBenchmarks(measurement(fixture([invocation('small')])), measurement(fixture([invocation('small'), invocation('large')])));
  assert.deepEqual(diff.contracts[0].newBenchmarks, [{ function_name: 'hello', case_id: 'id:large' }]);
  assert.deepEqual(diff.contracts[0].newFunctions, []);
});

test('matched benchmark with higher CPU produces regression delta and percentage', () => {
  const diff = diffBenchmarks(measurement(), measurement(fixture(), { cpu: 12000, hash: headHash, address: headAddress }));
  assert.equal(cpu(diff).delta, 2000);
  assert.equal(cpu(diff).pct, 20);
  assert.equal(cpu(diff).regression, true);
  assert.equal(diff.hasRegression, true);
});

test('matched benchmark with lower CPU produces improvement delta and percentage', () => {
  const diff = diffBenchmarks(measurement(), measurement(fixture(), { cpu: 8000, hash: headHash, address: headAddress }));
  assert.equal(cpu(diff).delta, -2000);
  assert.equal(cpu(diff).pct, -20);
  assert.equal(cpu(diff).regression, false);
  assert.equal(diff.hasRegression, false);
});

test('multiple contracts remain independent even with the same WASM and address', () => {
  const input = fixture();
  input.contracts.push({ ...input.contracts[0], id: 'second-contract' });
  const base = measurement(input);
  const head = measurement(input, { address: headAddress, hash: headHash });
  head[1].benchmarks[0].metrics.cpu_instructions.consumed = 15000;
  const diff = diffBenchmarks(base, head);
  assert.equal(diff.contracts.length, 2);
  assert.equal(diff.contracts[0].functions[0].metrics[0].delta, 0);
  assert.equal(diff.contracts[1].functions[0].metrics[0].delta, 5000);
});

test('identical contract/case names in different fixture files do not pair', () => {
  const diff = diffBenchmarks(measurement(), measurement(fixture(), { fixturePath: 'other/weighin-fixtures.json' }));
  assert.equal(diff.contracts.length, 0);
});

test('existing fixture format derives stable identities from the full path and arguments', () => {
  const input = fixture();
  delete input.contracts[0].id;
  delete input.contracts[0].invocations[0].id;
  const base = measurement(input, { fixturePath: './weighin-fixtures.json' });
  const head = measurement(input, { address: headAddress, hash: headHash });
  assert.equal(diffBenchmarks(base, head).contracts[0].functions.length, 1);
  assert.equal(base[0].logical_id, 'wasm:contract/target/wasm32v1-none/release/contract_test.wasm');
  assert.match(base[0].benchmarks[0].case_id, /^args:/);
});

test('same WASM basename in different directories does not match', () => {
  const input = fixture();
  delete input.contracts[0].id;
  const other = structuredClone(input);
  other.contracts[0].wasm_path = 'unrelated/target/wasm32v1-none/release/contract_test.wasm';
  assert.equal(diffBenchmarks(measurement(input), measurement(other)).contracts.length, 0);
});

test('explicit fixture and contract IDs preserve comparison across path changes', () => {
  const input = { ...fixture(), id: 'reference-suite' };
  const renamed = structuredClone(input);
  renamed.contracts[0].wasm_path = 'renamed/contract.wasm';
  const diff = diffBenchmarks(measurement(input), measurement(renamed, { fixturePath: 'renamed-fixtures.json', address: headAddress }));
  assert.equal(diff.contracts.length, 1);
  assert.equal(diff.contracts[0].fixture_id, 'id:reference-suite');
});

test('unconfigured cases use arguments, not invocation position', () => {
  const small = invocation();
  const large = invocation(undefined, 'hello', 'larger');
  delete small.id;
  delete large.id;
  const base = measurement(fixture([small, large]));
  const head = measurement(fixture([large, small]), { address: headAddress });
  assert.equal(diffBenchmarks(base, head).contracts[0].functions.length, 2);
  const changed = structuredClone(small);
  changed.args[0].value = 'different';
  const diff = diffBenchmarks(measurement(fixture([small])), measurement(fixture([changed])));
  assert.equal(diff.contracts[0].functions.length, 0);
  assert.equal(diff.contracts[0].newBenchmarks.length, 1);
  assert.equal(diff.contracts[0].removedBenchmarks.length, 1);
});

test('argument object key order and type capitalization do not alter default case identity', () => {
  const input = fixture([{ function_name: 'hello', args: [{ type: 'Symbol', value: 'world' }] }]);
  const reordered = fixture([{ function_name: 'hello', args: [{ value: 'world', type: 'symbol' }] }]);
  assert.equal(diffBenchmarks(measurement(input), measurement(reordered)).contracts[0].functions.length, 1);
});

test('duplicate logical contracts or cases are rejected instead of overwritten', () => {
  const input = fixture();
  input.contracts.push(structuredClone(input.contracts[0]));
  assert.throws(() => measurement(input), /Duplicate logical contract/);
  assert.throws(() => measurement(fixture([invocation(), invocation()])), /Duplicate benchmark/);
  const records = measurement();
  assert.throws(() => diffBenchmarks(records, [...records, structuredClone(records[0])]), /Duplicate logical contract/);
  records[0].benchmarks.push(structuredClone(records[0].benchmarks[0]));
  assert.throws(() => diffBenchmarks([], records), /Duplicate benchmark/);
});

test('blank explicit IDs and absolute fallback WASM paths are rejected', () => {
  assert.throws(() => measurement(fixture([invocation()], ' ')), /ID must not be blank/);
  const input = fixture();
  delete input.contracts[0].id;
  input.contracts[0].wasm_path = '/tmp/contract.wasm';
  assert.throws(() => measurement(input), /relative path or an explicit id/);
});

test('legacy measurements pair by runtime address only, and never guess a mixed-schema match', () => {
  const legacy = measurement();
  delete legacy[0].schema_version;
  delete legacy[0].fixture_id;
  delete legacy[0].logical_id;
  delete legacy[0].benchmarks[0].case_id;
  assert.equal(diffBenchmarks(legacy, structuredClone(legacy)).contracts.length, 1);
  const different = structuredClone(legacy);
  different[0].contract_id = headAddress;
  assert.equal(diffBenchmarks(legacy, different).contracts.length, 0);
  assert.equal(diffBenchmarks(legacy, measurement()).contracts.length, 0);
});

test('partial version 2 identities fail rather than falling back to runtime address', () => {
  const records = measurement();
  delete records[0].logical_id;
  assert.throws(() => diffBenchmarks(records, measurement()), /Version 2\/3\/4\/5 results require/);
  const missingCase = measurement();
  delete missingCase[0].benchmarks[0].case_id;
  assert.throws(() => diffBenchmarks(missingCase, measurement()), /Version 2\/3\/4\/5 results require/);
});

test('strict threshold sees a changed-WASM regression and identifies its logical case', () => {
  const diff = diffBenchmarks(measurement(), measurement(fixture(), { cpu: 12000, address: headAddress, hash: headHash }));
  const violations = enforceThresholds(diff, { thresholds: { global: { fail_on_any_regression: true } } });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].logical_id, 'id:greeting');
  assert.equal(violations[0].case_id, 'id:world');
  assert.equal(violations[0].metric, 'cpu_instructions');
  assert.equal(violations[0].delta, 2000);
});

test('reports show logical identity, both runtime addresses, independent cases, and additions/removals', () => {
  const base = measurement(fixture([invocation('small'), invocation('removed')]));
  const head = measurement(fixture([invocation('small'), invocation('new')]), { cpu: 12000, address: headAddress, hash: headHash });
  const diff = diffBenchmarks(base, head);
  const violations = enforceThresholds(diff, { thresholds: { functions: { hello: { cpu_instructions: 'strict_zero_tolerance' } } } });
  const report = renderComment(diff, violations, 'main', '2'.repeat(40));
  for (const value of ['path:weighin-fixtures.json', 'id:greeting', 'hello / id:small', baseAddress, headAddress, 'hello / id:new', 'hello / id:removed', '+2,000']) {
    assert.ok(report.includes(value), `Report must identify ${value}`);
  }
  assert.match(report, /New benchmarks/);
  assert.match(report, /Removed benchmarks/);
});

// ---------------------------------------------------------------------------
// Unknown declaration field rejection and valid payload passthrough
// ---------------------------------------------------------------------------

test('misspelled optional id at any declaration level throws rather than falling back', () => {
  // Fixture root: "idenitifer" is not "id" — must reject, not fall back to path: identity
  assert.throws(
    () => parseFixtures(
      JSON.stringify({
        idenitifer: 'my-suite',
        contracts: [{ wasm_path: 'contract.wasm', invocations: [{ function_name: 'hello', args: [] }] }],
      }),
      'weighin-fixtures.json',
    ),
    (err) => { assert.match(err.message, /idenitifer/); return true; },
  );

  // Contract: "iD" is not "id" — must reject, not fall back to wasm: identity
  assert.throws(
    () => parseFixtures(
      JSON.stringify({
        contracts: [{ iD: 'my-contract', wasm_path: 'contract.wasm', invocations: [{ function_name: 'hello', args: [] }] }],
      }),
      'weighin-fixtures.json',
    ),
    (err) => { assert.match(err.message, /iD/); return true; },
  );

  // Invocation: "iD" is not "id" — must reject, not fall back to args: identity
  assert.throws(
    () => parseFixtures(
      JSON.stringify({
        contracts: [{
          wasm_path: 'contract.wasm',
          invocations: [{ iD: 'my-case', function_name: 'hello', args: [] }],
        }],
      }),
      'weighin-fixtures.json',
    ),
    (err) => { assert.match(err.message, /iD/); return true; },
  );
});

test('vec and map payloads with valid typed-argument contents parse successfully', () => {
  const vecFixture = JSON.stringify({
    contracts: [{
      wasm_path: 'contract.wasm',
      invocations: [{
        function_name: 'hello',
        args: [{ type: 'vec', value: [{ type: 'symbol', value: 'a' }] }],
      }],
    }],
  });
  const vecResult = parseFixtures(vecFixture, 'weighin-fixtures.json');
  assert.ok(vecResult.contracts[0], 'vec fixture should parse to a contract');

  const mapFixture = JSON.stringify({
    contracts: [{
      wasm_path: 'contract.wasm',
      invocations: [{
        function_name: 'hello',
        args: [{
          type: 'map',
          value: [{ key: { type: 'u32', value: 1 }, value: { type: 'string', value: 'x' } }],
        }],
      }],
    }],
  });
  const mapResult = parseFixtures(mapFixture, 'weighin-fixtures.json');
  assert.ok(mapResult.contracts[0], 'map fixture should parse to a contract');
});
