const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const yaml = require('yaml'), TOML = require('toml');
const { parseFixtures } = require('../dist/identity');
const { validateConfig } = require('../dist/threshold');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const mainDocs = ['README.md', 'CONTRIBUTING.md', 'docs/EVIDENCE.md', 'docs/KNOWN_LIMITATIONS.md', 'docs/architecture.md', 'docs/DEPENDENCY_SECURITY.md', 'docs/repeatability.md', 'docs/ledger-variation.md'];

const {
  validateAllMaintainedDocs,
  validateMarkdownFile,
  getAnchors,
  FROZEN_EVIDENCE_EXCLUSIONS,
} = require('../scripts/check-markdown-links.cjs');

test('all active local Markdown links and heading anchors resolve across maintained docs', () => {
  const { docs, allErrors } = validateAllMaintainedDocs();
  assert.ok(docs.length >= 8, `Expected maintained docs to be scanned, found ${docs.length}`);
  if (allErrors.length > 0) {
    const formatted = allErrors.map(e => `${e.source}: [${e.link}] -> ${e.error}`).join('\n');
    assert.fail(`Broken markdown links or heading anchors detected:\n${formatted}`);
  }
});

test('link and anchor validator excludes frozen evidence and fails broken targets or missing anchors', () => {
  assert.ok(FROZEN_EVIDENCE_EXCLUSIONS.includes('docs/experiments'));

  // Test anchor extractor on markdown sample
  const sampleMd = '# Main Title\n\n## First Section\n\n### Nested Item\n\n<a id="custom-target"></a>\n';
  const tempFile = path.join(root, 'node_modules', '.tmp-anchor-test.md');
  fs.writeFileSync(tempFile, sampleMd, 'utf8');
  try {
    const anchors = getAnchors(path.relative(root, tempFile));
    assert.ok(anchors.has('main-title'));
    assert.ok(anchors.has('first-section'));
    assert.ok(anchors.has('nested-item'));
    assert.ok(anchors.has('custom-target'));
    assert.ok(!anchors.has('non-existent-heading'));
  } finally {
    fs.rmSync(tempFile, { force: true });
  }

  // Test validator fails on broken target file without network access
  const brokenTargetDoc = path.join(root, 'node_modules', '.tmp-broken-link.md');
  fs.writeFileSync(brokenTargetDoc, '[Broken link](./non_existent_file.md)\n', 'utf8');
  try {
    const errs = validateMarkdownFile(path.relative(root, brokenTargetDoc));
    assert.equal(errs.length, 1);
    assert.match(errs[0].error, /Target file does not exist/);
  } finally {
    fs.rmSync(brokenTargetDoc, { force: true });
  }

  // Test validator fails on non-existent anchor in existing target
  const brokenAnchorDoc = path.join(root, 'node_modules', '.tmp-broken-anchor.md');
  fs.writeFileSync(brokenAnchorDoc, '[Missing anchor](../README.md#this-anchor-definitely-does-not-exist)\n', 'utf8');
  try {
    const errs = validateMarkdownFile(path.relative(root, brokenAnchorDoc));
    assert.equal(errs.length, 1);
    assert.match(errs[0].error, /Anchor #this-anchor-definitely-does-not-exist not found/);
  } finally {
    fs.rmSync(brokenAnchorDoc, { force: true });
  }
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
  for (const input of Object.keys(action.inputs)) assert.ok(markdown.includes(`| \`${input}\` |`), input);
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
