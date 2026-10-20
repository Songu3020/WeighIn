const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const http = require('node:http');
const YAML = require('yaml');
const root = path.resolve(__dirname, '..');
const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/comment.yml'), 'utf8'));
const commentJob = workflow.jobs['post-comment'];
const steps = commentJob.steps;
const report = '<!-- weighin-comment -->\n# Resource report\nCPU instructions: 565371\n';
function git(directory, ...args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
}
// Evaluate the actual YAML guard's supported expression subset. Reject any
// unfamiliar syntax so a future workflow change cannot silently bypass coverage.
function shouldRun(condition, run) {
  const terms = condition.split(/\s*&&\s*/).map(term => {
    const match = /^github\.event\.workflow_run\.(conclusion|event)\s*==\s*'([^']+)'$/.exec(term.trim());
    assert.ok(match, `Unmodeled workflow condition: ${term}`);
    return run[match[1]] === match[2];
  });
  return terms.every(Boolean);
}
const successfulPr = { conclusion: 'success', event: 'pull_request' };
const validMetadata = { schemaVersion: 1, repository: 'WeighInNG/WeighIn', prNumber: 27, headSha: 'f'.repeat(40) };
async function execute(order, metadata = true, run = successfulPr, condition = commentJob.if, options = {}) {
  if (!shouldRun(condition, run)) return { skipped: true, executedSteps: [], calls: [] };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-comment-test-'));
  const workspace = path.join(temporary, 'workspace'), calls = [];
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', data => raw += data);
    request.on('end', () => {
      const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
      const body = raw ? JSON.parse(raw) : undefined;

      if (url.pathname === '/repos/WeighInNG/WeighIn/issues/27/comments' && request.method === 'GET') {
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        calls.push({ method: 'GET', url: request.url, page, body });
        if (options.pages) {
          const pageIndex = page - 1;
          const pageEntry = options.pages[pageIndex];
          if (pageEntry && pageEntry.status && pageEntry.status >= 400) {
            response.writeHead(pageEntry.status, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ message: pageEntry.message || 'API error' }));
            return;
          }
          const items = pageEntry ?? [];
          const headers = { 'content-type': 'application/json' };
          if (pageIndex + 1 < options.pages.length) {
            headers['link'] = `<http://${request.headers.host}${url.pathname}?page=${page + 1}>; rel="next"`;
          }
          response.writeHead(200, headers);
          response.end(JSON.stringify(items));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([]));
        return;
      }

      if (url.pathname === '/repos/WeighInNG/WeighIn/issues/27/comments' && request.method === 'POST') {
        calls.push({ method: 'POST', url: request.url, body });
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 42, body: body.body }));
        return;
      }

      const patchMatch = url.pathname.match(/^\/repos\/WeighInNG\/WeighIn\/issues\/comments\/(\d+)$/);
      if (patchMatch && request.method === 'PATCH') {
        const commentId = parseInt(patchMatch[1], 10);
        calls.push({ method: 'PATCH', url: request.url, commentId, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: commentId, body: body.body }));
        return;
      }

      response.writeHead(400); response.end('Unexpected test API request');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(workspace);
  try {
    git(workspace, 'init', '--quiet');
    git(workspace, 'config', 'user.name', 'WeighIn workflow test');
    git(workspace, 'config', 'user.email', 'workflow@example.invalid');
    for (const file of ['comment/action.yml', 'bundled/comment-action.js']) {
      const destination = path.join(workspace, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, file), destination);
    }
    git(workspace, 'add', 'comment', 'bundled'); git(workspace, 'commit', '--quiet', '-m', 'Disposable workflow test');
    let result;
    for (const step of order) {
      if (step.uses === 'actions/checkout@v4') {
        // Real cleanup performed by checkout's default clean policy.
        git(workspace, 'clean', '-ffdx'); git(workspace, 'reset', '--hard', 'HEAD');
      } else if (step.uses === 'actions/download-artifact@v4') {
        assert.equal(step.with.name, 'weighin-artifacts');
        assert.equal(step.with['run-id'], '${{ github.event.workflow_run.id }}');
        const post = order.find(step => step.uses === './comment');
        fs.writeFileSync(path.join(workspace, post.with['report-path']), report);
        if (metadata !== false) {
          const value = metadata === true ? validMetadata : metadata;
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          fs.writeFileSync(path.join(workspace, post.with['metadata-path']), text);
        }
      } else if (step.uses === './comment') {
        const action = YAML.parse(fs.readFileSync(path.join(workspace, 'comment/action.yml'), 'utf8'));
        result = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--require', path.join(root, 'tests/support/comment-transport-hook.cjs'), path.resolve(workspace, 'comment', action.runs.main)], {
            cwd: workspace, timeout: 15000,
            env: { ...process.env, GITHUB_REPOSITORY: 'WeighInNG/WeighIn', GITHUB_EVENT_PATH: '', GITHUB_API_URL: apiUrl,
              HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
              'INPUT_REPORT-PATH': step.with['report-path'], 'INPUT_METADATA-PATH': step.with['metadata-path'], 'INPUT_GITHUB-TOKEN': 'unit-test-token' },
          });
          let stdout = '', stderr = '';
          child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
          child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
        });
        assert.ifError(result.error);
      } else throw new Error(`Unmodeled workflow step: ${step.uses}`);
    }
    assert.ok(result, 'Workflow must execute the comment Action');
    return { ...result, skipped: false, executedSteps: order.map(step => step.name), calls };
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true }); }
}
test('comment workflow preserves downloaded report/metadata and sends their contents through the bundled Action', async () => {
  const result = await execute(steps);
  assert.equal(result.skipped, false);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls.map(call => call.method), ['GET', 'POST']);
  assert.equal(result.calls[1].body.body, report);
});
test('a case-insensitive repository match is accepted by the bundled consumer', async () => {
  const result = await execute(steps, { ...validMetadata, repository: 'weighinng/weighin' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls.map(call => call.method), ['GET', 'POST']);
  assert.equal(result.calls[1].body.body, report);
});
for (const [label, metadata, pattern] of [
  ['malformed JSON', '{ not json', /not valid JSON/],
  ['a JSON array', '[]', /must be a JSON object/],
  ['legacy unversioned metadata', JSON.stringify({ prNumber: 27, headSha: 'f'.repeat(40) }), /Legacy unversioned/],
  ['an unsupported schema version', JSON.stringify({ ...validMetadata, schemaVersion: 2 }), /Unsupported PR metadata schemaVersion/],
  ['a string schema version', JSON.stringify({ ...validMetadata, schemaVersion: '1' }), /Unsupported PR metadata schemaVersion/],
  ['a missing repository', JSON.stringify({ ...validMetadata, repository: undefined }), /repository is missing/],
  ['a blank repository', JSON.stringify({ ...validMetadata, repository: '  ' }), /repository is missing/],
  ['another repository', JSON.stringify({ ...validMetadata, repository: 'attacker/WeighIn' }), /does not match trusted repository/],
  ['a string PR number', JSON.stringify({ ...validMetadata, prNumber: '27' }), /prNumber must be a positive integer/],
  ['a zero PR number', JSON.stringify({ ...validMetadata, prNumber: 0 }), /prNumber must be a positive integer/],
  ['a negative PR number', JSON.stringify({ ...validMetadata, prNumber: -3 }), /prNumber must be a positive integer/],
  ['a fractional PR number', JSON.stringify({ ...validMetadata, prNumber: 1.5 }), /prNumber must be a positive integer/],
  ['a malformed SHA', JSON.stringify({ ...validMetadata, headSha: 'abc123' }), /headSha must be a 40-character hexadecimal SHA/],
  ['a non-hex SHA', JSON.stringify({ ...validMetadata, headSha: 'g'.repeat(40) }), /headSha must be a 40-character hexadecimal SHA/],
]) {
  test(`the bundled consumer rejects ${label} with zero mutation calls`, async () => {
    const result = await execute(steps, metadata);
    assert.equal(result.status, 1, `${label} unexpectedly succeeded`);
    assert.match(result.stdout + result.stderr, pattern);
    assert.deepEqual(result.calls, []);
  });
}
test('the historical download-before-checkout order deletes the report and fails before any posting request', async () => {
  const historical = [steps.find(step => step.uses === 'actions/download-artifact@v4'), steps.find(step => step.uses === 'actions/checkout@v4'), steps.find(step => step.uses === './comment')];
  const result = await execute(historical);
  assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /Report file not found/);
  assert.deepEqual(result.calls, []);
});
test('missing downloaded metadata fails before any posting request', async () => {
  const result = await execute(steps, false);
  assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /Metadata file not found/);
  assert.deepEqual(result.calls, []);
});
test('comment delivery retains trusted checkout and triggering-run artifact selection', () => {
  assert.deepEqual(workflow.on.workflow_run.workflows, ['WeighIn CI']);
  assert.deepEqual(workflow.jobs['post-comment'].permissions, { 'pull-requests': 'write', actions: 'read' });
  const checkout = steps.find(step => step.uses === 'actions/checkout@v4');
  assert.equal(checkout.with?.ref, undefined, 'Do not execute triggering PR code with comment permissions');
});

test('comment test transport rejects non-local sockets before connecting', () => {
  const result = spawnSync(process.execPath, ['--require', path.join(root, 'tests/support/comment-transport-hook.cjs'), '-e', "require('node:net').connect(443, 'api.github.com')"], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Non-local network connection forbidden/);
});

test('successful main push skips checkout, artifact download and comment execution', async () => {
  const result = await execute(steps, false, { conclusion: 'success', event: 'push' });
  assert.deepEqual(result, { skipped: true, executedSteps: [], calls: [] });
});
test('the historical success-only guard executes on a push and fails without PR metadata', async () => {
  const result = await execute(steps, false, { conclusion: 'success', event: 'push' }, "github.event.workflow_run.conclusion == 'success'");
  assert.equal(result.skipped, false);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Metadata file not found/);
  assert.deepEqual(result.calls, []);
});
for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral']) {
  test(`${conclusion} PR CI skips all comment-job steps`, async () => {
    const result = await execute(steps, false, { conclusion, event: 'pull_request' });
    assert.deepEqual(result, { skipped: true, executedSteps: [], calls: [] });
  });
}
for (const event of ['workflow_dispatch', 'pull_request_target', undefined]) {
  test(`${event ?? 'missing event'} does not qualify for PR comment delivery`, async () => {
    const result = await execute(steps, false, { conclusion: 'success', event });
    assert.deepEqual(result, { skipped: true, executedSteps: [], calls: [] });
  });
}
test('a successful fork PR uses the same comment delivery path', async () => {
  const result = await execute(steps, true, { ...successfulPr, head_repository: { fork: true } });
  assert.equal(result.skipped, false);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.calls[1].body.body, report);
});

test('a report on page two is updated and no new comment is created', async () => {
  const pages = [
    [{ id: 101, body: 'Discussion comment 1' }],
    [{ id: 102, body: '<!-- weighin-report -->\nOld benchmark report' }],
    [{ id: 103, body: 'Discussion comment 2' }],
  ];
  const result = await execute(steps, true, successfulPr, commentJob.if, { pages });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls.map(c => c.method), ['GET', 'GET', 'PATCH']);
  assert.deepEqual(result.calls.filter(c => c.method === 'GET').map(c => c.page), [1, 2]);
  assert.equal(result.calls[2].commentId, 102);
  assert.equal(result.calls[2].body.body, report);
});

test('lookup reaches exhaustion before creating a report when none exists', async () => {
  const pages = [
    [{ id: 201, body: 'Discussion comment 1' }],
    [{ id: 202, body: 'Discussion comment 2' }],
    [{ id: 203, body: 'Discussion comment 3' }],
  ];
  const result = await execute(steps, true, successfulPr, commentJob.if, { pages });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls.map(c => c.method), ['GET', 'GET', 'GET', 'POST']);
  assert.deepEqual(result.calls.filter(c => c.method === 'GET').map(c => c.page), [1, 2, 3]);
  assert.equal(result.calls[3].body.body, report);
});

test('empty first page followed by non-matching page then matching report updates exactly one comment', async () => {
  const pages = [
    [],
    [{ id: 301, body: 'Discussion comment 1' }],
    [{ id: 302, body: '<!-- weighin-report -->\nFound on page 3' }],
  ];
  const result = await execute(steps, true, successfulPr, commentJob.if, { pages });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls.map(c => c.method), ['GET', 'GET', 'GET', 'PATCH']);
  assert.deepEqual(result.calls.filter(c => c.method === 'GET').map(c => c.page), [1, 2, 3]);
  assert.equal(result.calls[3].commentId, 302);
  assert.equal(result.calls[3].body.body, report);
});

test('preserves existing selection behavior when multiple markers exist on the same page', async () => {
  const pages = [
    [
      { id: 401, body: '<!-- weighin-report -->\nFirst marker' },
      { id: 402, body: '<!-- weighin-report -->\nSecond marker' },
    ],
    [{ id: 403, body: '<!-- weighin-report -->\nThird marker' }],
  ];
  const result = await execute(steps, true, successfulPr, commentJob.if, { pages });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls.map(c => c.method), ['GET', 'PATCH']);
  assert.equal(result.calls[1].commentId, 401);
  assert.equal(result.calls[1].body.body, report);
});

test('an API failure during pagination stops execution and creates no comment', async () => {
  const pages = [
    [{ id: 501, body: 'Discussion comment' }],
    { status: 500, message: 'Server error from GitHub API' },
  ];
  const result = await execute(steps, true, successfulPr, commentJob.if, { pages });
  assert.equal(result.status, 1, 'API failure must cause non-zero exit');
  assert.match(result.stdout + result.stderr, /Server error from GitHub API/);
  assert.deepEqual(result.calls.map(c => c.method), ['GET', 'GET']);
});
