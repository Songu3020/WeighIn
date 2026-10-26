const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '..');

/**
 * Reviewable exception list for optional/conditional outputs across Action entry points.
 * Document any output that is intentionally not emitted on every execution path.
 */
const CONDITIONAL_OUTPUT_EXCEPTIONS = {
  'action.yml': [],
  'comment/action.yml': [],
};

function extractRuntimeInputsAndOutputs(sourceCode) {
  const inputs = new Set();
  const outputs = new Set();

  // Match any *.getInput("input-name") or parseOptionalBooleanInput("input-name")
  const inputMatches = sourceCode.matchAll(/(?:\.getInput|parseOptionalBooleanInput)\s*\(\s*["']([^"']+)["']/g);
  for (const m of inputMatches) {
    inputs.add(m[1]);
  }

  // Match any *.setOutput("output-name")
  const outputMatches = sourceCode.matchAll(/\.setOutput\s*\(\s*["']([^"']+)["']/g);
  for (const m of outputMatches) {
    outputs.add(m[1]);
  }

  return { inputs: Array.from(inputs).sort(), outputs: Array.from(outputs).sort() };
}

describe('Action Input and Output Parity (#169)', () => {
  const mainActionYaml = yaml.parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8'));
  const commentActionYaml = yaml.parse(fs.readFileSync(path.join(root, 'comment/action.yml'), 'utf8'));

  const mainSource = fs.readFileSync(path.join(root, 'src/action.ts'), 'utf8');
  const commentSource = fs.readFileSync(path.join(root, 'src/comment-action.ts'), 'utf8');

  const bundledMain = fs.readFileSync(path.join(root, 'bundled/index.js'), 'utf8');
  const bundledComment = fs.readFileSync(path.join(root, 'bundled/comment-action.js'), 'utf8');

  test('Main Action entry point (action.yml) matches runtime wiring exactly', () => {
    const declaredInputs = Object.keys(mainActionYaml.inputs || {}).sort();
    const declaredOutputs = Object.keys(mainActionYaml.outputs || {}).sort();

    const runtime = extractRuntimeInputsAndOutputs(mainSource);
    const bundled = extractRuntimeInputsAndOutputs(bundledMain);

    // Parity between action.yml and src/action.ts
    assert.deepEqual(runtime.inputs, declaredInputs, 'Declared inputs in action.yml must match src/action.ts inputs');
    assert.deepEqual(bundled.inputs, declaredInputs, 'Declared inputs in action.yml must match bundled/index.js inputs');

    // Parity between action.yml outputs and src/action.ts outputs
    const expectedOutputs = [...declaredOutputs].filter(
      out => !CONDITIONAL_OUTPUT_EXCEPTIONS['action.yml'].includes(out),
    );
    assert.deepEqual(runtime.outputs, expectedOutputs, 'Declared outputs in action.yml must match runtime core.setOutput calls');
    assert.deepEqual(bundled.outputs, expectedOutputs, 'Declared outputs in action.yml must match bundled core.setOutput calls');
  });

  test('Comment Action entry point (comment/action.yml) matches runtime wiring exactly', () => {
    const declaredInputs = Object.keys(commentActionYaml.inputs || {}).sort();
    const declaredOutputs = Object.keys(commentActionYaml.outputs || {}).sort();

    const runtime = extractRuntimeInputsAndOutputs(commentSource);
    const bundled = extractRuntimeInputsAndOutputs(bundledComment);

    assert.deepEqual(runtime.inputs, declaredInputs, 'Declared inputs in comment/action.yml must match src/comment-action.ts');
    assert.deepEqual(bundled.inputs, declaredInputs, 'Declared inputs in comment/action.yml must match bundled/comment-action.js');

    assert.deepEqual(runtime.outputs, declaredOutputs, 'Comment action emits no unexpected outputs');
    assert.deepEqual(bundled.outputs, declaredOutputs, 'Bundled comment action emits no unexpected outputs');
  });

  test('Main Action default values for omitted inputs are well-formed and consistent', () => {
    const inputs = mainActionYaml.inputs;
    assert.equal(inputs['fixtures-path'].default, 'weighin-fixtures.json');
    assert.equal(inputs['config-path'].default, 'weighin.toml');
    assert.equal(inputs['rpc-url'].default, 'http://localhost:8000/rpc');
    assert.equal(inputs['skip-build'].default, 'false');

    // Required inputs must not have empty defaults that mask omission
    assert.equal(inputs['fixtures-path'].required, true);
  });

  test('Unsupported or malformed inputs are rejected predictably', () => {
    const { parseOptionalBooleanInput } = require('../dist/build-selection');

    // Valid boolean values
    process.env['INPUT_SKIP-BUILD'] = 'true';
    assert.equal(parseOptionalBooleanInput('skip-build', false), true);

    process.env['INPUT_SKIP-BUILD'] = 'false';
    assert.equal(parseOptionalBooleanInput('skip-build', true), false);

    // Omitted returns default
    delete process.env['INPUT_SKIP-BUILD'];
    assert.equal(parseOptionalBooleanInput('skip-build', false), false);
    assert.equal(parseOptionalBooleanInput('skip-build', true), true);

    // Unsupported non-boolean inputs are rejected
    process.env['INPUT_SKIP-BUILD'] = 'not-a-boolean';
    assert.throws(
      () => parseOptionalBooleanInput('skip-build', false),
      /Input does not meet YAML 1\.2 "Core Schema" specification/,
    );
    delete process.env['INPUT_SKIP-BUILD'];
  });
});
