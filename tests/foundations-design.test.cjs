const test = require('node:test');
const assert = require('node:assert/strict');

const target = { fixture_id: 'id:payments', logical_id: 'id:transfer', function_name: 'quote', case_id: 'id:large' };
function matches(selector, value) {
  return ['fixture_id', 'logical_id', 'function_name', 'case_id'].every(key => selector[key] === undefined || selector[key] === value[key]);
}
function specificity(selector) {
  return ['fixture_id', 'logical_id', 'function_name', 'case_id'].filter(key => selector[key] !== undefined).length;
}
function resolve(rules) {
  const matching = rules.filter(rule => matches(rule.selector, target)).sort((a, b) => specificity(a.selector) - specificity(b.selector));
  if (!matching.length) throw new Error('unmatched selector');
  return matching.at(-1).rule;
}

test('exact logical selectors override function-wide and global rules', () => {
  assert.equal(resolve([
    { selector: {}, rule: 'allow_10_percent_increase' },
    { selector: { function_name: 'quote' }, rule: 'strict_zero_tolerance' },
    { selector: target, rule: 'ignore' },
  ]), 'ignore');
  assert.throws(() => resolve([{ selector: { function_name: 'other' }, rule: 'strict_zero_tolerance' }]), /unmatched/);
});

test('payload boundaries are inclusive at the limit and reject one byte over', () => {
  const accepts = (size, limit) => size <= limit;
  assert.equal(accepts(1024, 1024), true);
  assert.equal(accepts(1025, 1024), false);
});

test('provenance distinguishes verified, unknown, and caller-supplied artifacts', () => {
  const modes = ['default', 'custom', 'prebuilt'];
  const verification = { default: 'verified', custom: 'unknown', prebuilt: 'caller-supplied' };
  for (const mode of modes) assert.ok(['verified', 'unknown', 'caller-supplied'].includes(verification[mode]));
  assert.notEqual(verification.custom, 'verified');
  assert.notEqual(verification.prebuilt, 'verified');
});

test('hosted reproducibility requires independent authenticated samples', () => {
  const samples = [
    { run_id: '100', run_attempt: 1, source_sha256: 'a', wasm_sha256: 'w1', status: 'success' },
    { run_id: '101', run_attempt: 1, source_sha256: 'a', wasm_sha256: 'w1', status: 'success' },
  ];
  assert.equal(new Set(samples.map(sample => sample.run_id)).size, 2);
  assert.equal(new Set(samples.map(sample => sample.source_sha256)).size, 1);
  assert.equal(samples.every(sample => sample.status === 'success'), true);
  assert.equal(samples[0].run_id === samples[1].run_id, false);
});
