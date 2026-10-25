const { test } = require('node:test');
const assert = require('node:assert/strict');
const { enforceThresholds } = require('../dist/threshold');

function diff(consumed, availability = 'comparable') {
  const metrics = {};
  for (const key of require('../dist/diff').METRIC_KEYS) {
    const unavailable = key === 'historical_data_read_bytes' || key === 'contract_data_hard_limit' || key === 'tx_size_bytes';
    metrics[key] = { key, base: { availability: unavailable ? 'unavailable' : 'measured', consumed: unavailable ? null : 10, limit: null },
      head: { availability: unavailable || (key === 'cpu_instructions' && availability === 'unavailable') ? 'unavailable' : 'measured',
        consumed: unavailable || (key === 'cpu_instructions' && availability === 'unavailable') ? null : key === 'cpu_instructions' ? consumed : 10,
        limit: null, reason: unavailable || (key === 'cpu_instructions' && availability === 'unavailable') ? 'not available' : undefined },
      availability: unavailable || (key === 'cpu_instructions' && availability === 'unavailable') ? 'unavailable' : 'comparable',
      reason: unavailable || (key === 'cpu_instructions' && availability === 'unavailable') ? 'not available' : undefined,
      delta: unavailable || (key === 'cpu_instructions' && availability === 'unavailable') ? null : key === 'cpu_instructions' ? consumed - 10 : 0,
      pct: null, regression: key === 'cpu_instructions' && consumed > 10 };
  }
  return { contracts: [{ fixture_id: 'path:fixtures.json', logical_id: 'id:contract', contract_id: 'CA',
    base_contract_id: 'CB', head_contract_id: 'CA', base_commit: 'base', head_commit: 'head', hasRegression: false,
    newFunctions: [], removedFunctions: [], newBenchmarks: [], removedBenchmarks: [],
    functions: [{ function_name: 'run', case_id: 'args:[]', metrics: Object.values(metrics), hasRegression: false }] }],
    hasRegression: false, newContracts: [], removedContracts: [] };
}

test('absolute limits report values above the cap and pass at the cap', () => {
  const config = { limits: { global: { cpu_instructions: 50 } } };
  const violation = enforceThresholds(diff(51), config);
  assert.equal(violation.length, 1);
  assert.equal(violation[0].rule, 'absolute_limit(50)');
  assert.equal(enforceThresholds(diff(50), config).length, 0);
});

test('an absolute limit fails closed when its metric is unavailable', () => {
  const violation = enforceThresholds(diff(0, 'unavailable'), { limits: { global: { cpu_instructions: 50 } } });
  assert.equal(violation.length, 1);
  assert.equal(violation[0].delta, null);
  assert.match(violation[0].message, /unavailable/);
});

test('per-function absolute limits require a matched function', () => {
  assert.throws(() => enforceThresholds({ contracts: [], hasRegression: false, newContracts: [], removedContracts: [] },
    { limits: { functions: { missing: { cpu_instructions: 50 } } } }), /no matched BASE\/HEAD benchmark/);
});

test('global absolute limits fail closed when the comparison has no matched benchmarks', () => {
  const empty = { contracts: [], hasRegression: false, newContracts: [], removedContracts: [] };
  assert.throws(() => enforceThresholds(empty, { limits: { global: { cpu_instructions: 50 } } }),
    /global policy or limits: no matched BASE\/HEAD benchmarks/);

  const unmatchedCases = {
    contracts: [{ functions: [], newBenchmarks: [{ function_name: 'added', case_id: 'args:[]' }] }],
    hasRegression: false,
    newContracts: [],
    removedContracts: [],
  };
  assert.throws(() => enforceThresholds(unmatchedCases, { limits: { global: { cpu_instructions: 50 } } }),
    /no matched BASE\/HEAD benchmarks/);
});

test('report-only and explicitly empty global limits pass an empty comparison', () => {
  const empty = { contracts: [], hasRegression: false, newContracts: [], removedContracts: [] };
  assert.deepEqual(enforceThresholds(empty, null), []);
  assert.deepEqual(enforceThresholds(empty, {}), []);
  assert.deepEqual(enforceThresholds(empty, { limits: { global: {} } }), []);
});
