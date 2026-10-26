const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Address, xdr } = require('@stellar/stellar-sdk');

const example = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/experiments/fixture-setup-design/example.json')));

function planOrder(plan) {
  const nodes = new Map(plan.map(item => [item.deployment_id, item]));
  if (nodes.size !== plan.length) throw new Error('duplicate deployment ID');
  const order = [], visiting = new Set(), visited = new Set();
  function visit(id) {
    if (!nodes.has(id)) throw new Error(`missing dependency: ${id}`);
    if (visiting.has(id)) throw new Error(`dependency cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of nodes.get(id).depends_on) visit(dependency);
    visiting.delete(id); visited.add(id); order.push(id);
  }
  for (const id of [...nodes.keys()].sort()) visit(id);
  return order;
}

function validateBindings(bindings, order) {
  const positions = new Map(order.map((id, index) => [id, index]));
  const names = new Set();
  for (const [name, binding] of Object.entries(bindings)) {
    if (names.has(name)) throw new Error(`duplicate binding: ${name}`);
    names.add(name);
    const source = /^setup\.([^.]+)\.return$/.exec(binding.source);
    if (!source || !positions.has(source[1])) throw new Error(`missing binding source: ${name}`);
    if (positions.get(source[1]) >= positions.get('caller')) throw new Error(`forward binding: ${name}`);
    if (binding.type !== 'address') throw new Error(`incompatible binding type: ${name}`);
  }
}

test('dependency plan is deterministic and topologically ordered', () => {
  assert.deepEqual(planOrder(example.plan), ['callee', 'caller']);
  assert.throws(() => planOrder([{ deployment_id: 'a', depends_on: ['missing'] }]), /missing dependency/);
  assert.throws(() => planOrder([
    { deployment_id: 'a', depends_on: ['b'] },
    { deployment_id: 'b', depends_on: ['a'] },
  ]), /dependency cycle/);
});

test('caller uses a typed committed address binding, not string interpolation', () => {
  const binding = example.bindings.callee_address;
  assert.equal(binding.type, 'address');
  assert.equal(binding.selector, 'root');
  assert.equal(example.caller_invocation.args[0].binding, 'callee_address');
  const value = xdr.ScVal.fromXDR(example.setup_receipts.callee.return.xdr_base64, 'base64');
  assert.equal(value.switch().name, 'scvAddress');
  assert.equal(Address.fromScAddress(value.address()).toString(), example.setup_receipts.callee.contract_id);
  assert.doesNotMatch(JSON.stringify(example.caller_invocation), /CC227UDF/);
  validateBindings(example.bindings, ['callee', 'caller']);
});

test('bindings reject missing, forward, and incompatible references before side effects', () => {
  assert.throws(() => validateBindings({ x: { source: 'setup:missing:return', type: 'address' } }, ['caller']), /missing binding source/);
  assert.throws(() => validateBindings({ x: { source: 'setup.caller.return', type: 'address' } }, ['callee', 'caller']), /forward binding/);
  assert.throws(() => validateBindings({ x: { source: 'setup.callee.return', type: 'string' } }, ['callee', 'caller']), /incompatible binding type/);
});

test('only committed setup receipts can satisfy a binding', () => {
  assert.equal(example.setup_receipts.callee.status, 'committed');
  const incomplete = structuredClone(example);
  incomplete.setup_receipts.callee.status = 'partial_setup';
  assert.notEqual(incomplete.setup_receipts.callee.status, 'committed');
});
