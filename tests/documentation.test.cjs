const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const yaml = require('yaml'), TOML = require('toml');
const { parseFixtures } = require('../dist/identity');
const { validateConfig } = require('../dist/threshold');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const mainDocs = ['README.md', 'CONTRIBUTING.md', 'docs/EVIDENCE.md', 'docs/KNOWN_LIMITATIONS.md', 'docs/architecture.md', 'docs/DEPENDENCY_SECURITY.md', 'docs/repeatability.md', 'docs/ledger-variation.md'];

test('public reviewer path resolves product documentation and retained evidence without internal notes', () => {
  for (const file of mainDocs) {
    const text = read(file);
    assert.doesNotMatch(text, /WEIGHIN_PROGRESS|DRIPS_APPEAL_CONTEXT|Drips|appeal preparation/);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^https?:/.test(target)) continue;
      assert.ok(fs.existsSync(path.resolve(root, path.dirname(file), target)), `${file}: ${target}`);
    }
  }
  assert.ok(read('README.md').includes('(docs/EVIDENCE.md)'));
  assert.ok(read('README.md').includes('(docs/KNOWN_LIMITATIONS.md)'));
  assert.ok(read('docs/EVIDENCE.md').includes('/actions/runs/37777040210'));
  assert.ok(read('README.md').includes('report and metadata paths are read from the caller\'s working directory'));
  assert.match(read('docs/architecture.md'), /independently of the caller's current working\s+directory/);
  assert.ok(read('docs/KNOWN_LIMITATIONS.md').includes('(ledger-variation.md)'));
  assert.ok(read('docs/repeatability.md').includes('(ledger-variation.md)'));
  assert.ok(read('docs/EVIDENCE.md').includes('(ledger-variation.md)'));
});


test('README fixture and policy examples parse with the current public runtime API', () => {
  const markdown = read('README.md');
  const fixtures = parseFixtures(markdown.match(/```json\n([\s\S]*?)```/)[1], 'weighin-fixtures.json');
  assert.equal(fixtures.fixture_id, 'id:greeting-suite');
  assert.equal(fixtures.contracts[0].logical_id, 'id:greeting');
  assert.equal(fixtures.contracts[0].invocations[0].case_id, 'id:world');
  assert.equal(fixtures.contracts[0].invocations[0].function_name, 'hello');
  for (const match of markdown.matchAll(/```toml\n([\s\S]*?)```/g)) assert.doesNotThrow(() => validateConfig(TOML.parse(match[1])));
});

test('documented Action inputs, outputs and workflow snippets use supported names', () => {
  const action = yaml.parse(read('action.yml'));
  const commentAction = yaml.parse(read('comment/action.yml'));
  const markdown = read('README.md');
  const documentedInputCells = new Set(
    markdown.split('\n').filter((line) => line.startsWith('|')).map((line) => line.split('|')[1].trim()),
  );
  for (const input of Object.keys(action.inputs)) assert.ok(documentedInputCells.has(`\`${input}\``), input);
  for (const output of Object.keys(action.outputs)) assert.ok(markdown.includes(`\`${output}\``), output);
  for (const match of markdown.matchAll(/```yaml\n([\s\S]*?)```/g)) {
    for (const step of yaml.parse(match[1])) for (const name of Object.keys(step.with || {})) assert.ok(action.inputs[name], name);
  }

  // Verify runtime wiring parity for both Action entry points (#169)
  const mainRuntime = fs.readFileSync(path.join(root, 'src/action.ts'), 'utf8');
  const commentRuntime = fs.readFileSync(path.join(root, 'src/comment-action.ts'), 'utf8');
  for (const input of Object.keys(action.inputs)) {
    assert.ok(
      mainRuntime.includes(`"${input}"`) || mainRuntime.includes(`'${input}'`),
      `action.yml input ${input} must be wired into src/action.ts`,
    );
  }
  for (const output of Object.keys(action.outputs)) {
    assert.ok(
      mainRuntime.includes(`setOutput("${output}"`) || mainRuntime.includes(`setOutput('${output}'`),
      `action.yml output ${output} must be emitted by src/action.ts`,
    );
  }
  for (const input of Object.keys(commentAction.inputs)) {
    assert.ok(
      commentRuntime.includes(`"${input}"`) || commentRuntime.includes(`'${input}'`),
      `comment/action.yml input ${input} must be wired into src/comment-action.ts`,
    );
  }

  const scripts = JSON.parse(read('package.json')).scripts;
  for (const file of mainDocs) for (const match of read(file).matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) assert.ok(scripts[match[1]], `${file}: ${match[1]}`);
  for (const workflow of fs.readdirSync(path.join(root, '.github/workflows'))) yaml.parse(read(`.github/workflows/${workflow}`));
});
