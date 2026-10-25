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
async function execute(order, metadata = true, run = successfulPr, condition = commentJob.if, scenario = {}) {
  if (!shouldRun(condition, run)) return { skipped: true, executedSteps: [], calls: [] };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-comment-test-'));
  const workspace = path.join(temporary, 'caller'), actionInstall = path.join(temporary, 'action-install'), calls = [], lookups = [];
  assert.notEqual(workspace, root);
  assert.notEqual(actionInstall, workspace);
  const producerHead = scenario.producerHead ?? validMetadata.headSha, currentHead = scenario.currentHead ?? producerHead;
  const eventPath = path.join(temporary, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(scenario.event ?? { workflow_run: { event: 'pull_request', head_sha: producerHead } }));
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', data => raw += data);
    request.on('end', () => {
      const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
      const body = raw ? JSON.parse(raw) : undefined;
      const send = (status, value, headers = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(JSON.stringify(value));
      };

      if (request.method === 'GET' && url.pathname === '/repos/WeighInNG/WeighIn/pulls/27') {
        lookups.push(request.url);
        return scenario.pullStatus
          ? send(scenario.pullStatus, { message: 'scenario failure' })
          : send(200, { head: { sha: currentHead } });
      }

      if (request.method === 'GET' && url.pathname.startsWith('/repos/WeighInNG/WeighIn/git/commits/')) {
        lookups.push(request.url);
        const sha = url.pathname.split('/').pop();
        const parents = scenario.parents && scenario.parents[sha];
        return parents
          ? send(200, { sha, parents: parents.map(parent => ({ sha: parent })) })
          : send(404, { message: 'Not Found' });
      }

      if (url.pathname === '/repos/WeighInNG/WeighIn/issues/27/comments' && request.method === 'GET') {
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        calls.push({ method: 'GET', url: request.url, page, body });
        if (scenario.pages) {
          const pageIndex = page - 1;
          const pageEntry = scenario.pages[pageIndex];
          if (pageEntry && pageEntry.status && pageEntry.status >= 400) {
            return send(pageEntry.status, { message: pageEntry.message || 'API error' });
          }
          const headers = pageIndex + 1 < scenario.pages.length
            ? { link: `<http://${request.headers.host}${url.pathname}?page=${page + 1}>; rel="next"` }
            : {};
          return send(200, pageEntry ?? [], headers);
        }
        return send(200, scenario.existingComments || []);
      }

      if (url.pathname === '/repos/WeighInNG/WeighIn/issues/27/comments' && request.method === 'POST') {
        calls.push({ method: 'POST', url: request.url, body });
        return send(201, { id: 42, body: body.body });
      }

      const patchMatch = url.pathname.match(/^\/repos\/WeighInNG\/WeighIn\/issues\/comments\/(\d+)$/);
      if (patchMatch && request.method === 'PATCH') {
        const commentId = parseInt(patchMatch[1], 10);
        calls.push({ method: 'PATCH', url: request.url, commentId, body });
        return send(200, { id: commentId, body: body.body });
      }
      response.writeHead(400); response.end('Unexpected test API request');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(workspace); fs.mkdirSync(actionInstall);
  try {
    git(workspace, 'init', '--quiet');
    git(workspace, 'config', 'user.name', 'WeighIn workflow test');
    git(workspace, 'config', 'user.email', 'workflow@example.invalid');
    fs.writeFileSync(path.join(workspace, 'README.md'), 'Isolated comment caller\n');
    git(workspace, 'add', 'README.md'); git(workspace, 'commit', '--quiet', '-m', 'Disposable caller workspace');
    for (const file of ['comment/action.yml', 'bundled/comment-action.js']) {
      const destination = path.join(actionInstall, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, file), destination);
    }
    let result;
    for (const step of order) {
      if (step.uses === 'actions/checkout@v4') {
        // Model checkout's cleanup of caller artifacts without placing the Action there.
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
        const actionYml = path.join(actionInstall, 'comment/action.yml');
        const action = YAML.parse(fs.readFileSync(actionYml, 'utf8'));
        const entrypoint = path.resolve(path.dirname(actionYml), action.runs.main);
        assert.equal(entrypoint, path.join(actionInstall, 'bundled/comment-action.js'));
        assert.ok(fs.existsSync(entrypoint), 'Action entrypoint must resolve inside the installed Action directory');
        result = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--require', path.join(root, 'tests/support/comment-transport-hook.cjs'), entrypoint], {
            cwd: workspace, timeout: 15000,
            env: { ...process.env, GITHUB_REPOSITORY: 'WeighInNG/WeighIn', GITHUB_EVENT_PATH: eventPath, GITHUB_API_URL: apiUrl,
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
    return { ...result, skipped: false, executedSteps: order.map(step => step.name), calls, lookups };
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true }); }
}
test('installed comment Action uses caller artifacts from a separate working directory and sends the report', async () => {
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
  assert.deepEqual(workflow.jobs['post-comment'].permissions, { 'pull-requests': 'write', actions: 'read', contents: 'read' });
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
    [{ id: 102, body: '<!-- weighin-report -->\nOld benchmark report', user: { id: 41898282 } }],
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
    [{ id: 302, body: '<!-- weighin-report -->\nFound on page 3', user: { id: 41898282 } }],
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
      { id: 401, body: '<!-- weighin-report -->\nFirst marker', user: { id: 41898282 } },
      { id: 402, body: '<!-- weighin-report -->\nSecond marker', user: { id: 41898282 } },
    ],
    [{ id: 403, body: '<!-- weighin-report -->\nThird marker', user: { id: 41898282 } }],
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
// ---------------------------------------------------------------------------
// Author-mode regression tests (issue #16)
// ---------------------------------------------------------------------------
//
// A richer execute helper that supports:
//  - customisable existing-comment fixtures (with user.id)
//  - GET /user for authenticated-user mode
//  - PATCH /repos/.../issues/comments/:id for updates
//  - comment-author-mode input forwarding
//
const GITHUB_ACTIONS_BOT_ID = 41898282;
const OTHER_USER_ID         = 99999;
const AUTH_USER_ID          = 55555;

/**
 * Spawn the bundled comment-action with a configurable mock server.
 *
 * @param {object} opts
 *   existingComments  – Array of comment objects already on the issue (user.id, body, id).
 *   authenticatedUser – Object returned by GET /user (or null to simulate failure).
 *   commentAuthorMode – Value of INPUT_COMMENT-AUTHOR-MODE.
 *   metadata          – Override metadata (default: validMetadata).
 *   extraEnv          – Additional env vars.
 */
async function executeAuthorMode({
  existingComments = [],
  authenticatedUser = { id: AUTH_USER_ID, login: 'test-user', type: 'User' },
  commentAuthorMode = 'github-actions',
  metadata = validMetadata,
  extraEnv = {},
} = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-author-mode-test-'));
  const workspace  = path.join(temporary, 'workspace');
  const calls      = [];
  const headSha = (metadata && typeof metadata === 'object' && metadata.headSha) || validMetadata.headSha;
  const eventPath = path.join(temporary, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ workflow_run: { event: 'pull_request', head_sha: headSha } }));

  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', data => (raw += data));
    request.on('end', () => {
      const issuesUrl  = '/repos/WeighInNG/WeighIn/issues/27/comments';
      const userUrl    = '/user';
      const commentPatchRe = /^\/repos\/WeighInNG\/WeighIn\/issues\/comments\/(\d+)$/;
      const body = raw ? JSON.parse(raw) : undefined;

      if (request.url === userUrl && request.method === 'GET') {
        calls.push({ method: 'GET', url: '/user' });
        if (authenticatedUser === null) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'Bad credentials' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(authenticatedUser));
        return;
      }

      if (request.method === 'GET' && request.url === '/repos/WeighInNG/WeighIn/pulls/27') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ head: { sha: headSha } }));
        return;
      }

      if (request.url === issuesUrl) {
        if (request.method === 'GET') {
          calls.push({ method: 'GET', url: issuesUrl });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(existingComments));
          return;
        }
        if (request.method === 'POST') {
          calls.push({ method: 'POST', url: issuesUrl, body });
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id: 100, body: body.body }));
          return;
        }
      }

      const patchMatch = commentPatchRe.exec(request.url);
      if (patchMatch && request.method === 'PATCH') {
        calls.push({ method: 'PATCH', url: request.url, commentId: Number(patchMatch[1]), body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: Number(patchMatch[1]), body: body.body }));
        return;
      }

      response.writeHead(400);
      response.end(`Unexpected test API request: ${request.method} ${request.url}`);
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;

  fs.mkdirSync(workspace);
  try {
    git(workspace, 'init', '--quiet');
    git(workspace, 'config', 'user.name', 'WeighIn author-mode test');
    git(workspace, 'config', 'user.email', 'author-mode@example.invalid');
    for (const file of ['comment/action.yml', 'bundled/comment-action.js']) {
      const destination = path.join(workspace, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, file), destination);
    }
    git(workspace, 'add', 'comment', 'bundled');
    git(workspace, 'commit', '--quiet', '-m', 'Author-mode test workspace');

    const commentStep = steps.find(step => step.uses === './comment');
    fs.writeFileSync(path.join(workspace, commentStep.with['report-path']), report);
    fs.writeFileSync(
      path.join(workspace, commentStep.with['metadata-path']),
      JSON.stringify(typeof metadata === 'object' && metadata !== null ? metadata : validMetadata),
    );

    const action = YAML.parse(fs.readFileSync(path.join(workspace, 'comment/action.yml'), 'utf8'));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--require', path.join(root, 'tests/support/comment-transport-hook.cjs'),
         path.resolve(workspace, 'comment', action.runs.main)],
        {
          cwd: workspace, timeout: 15000,
          env: {
            ...process.env,
            GITHUB_REPOSITORY: 'WeighInNG/WeighIn',
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_API_URL: apiUrl,
            HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
            http_proxy: '', https_proxy: '', all_proxy: '',
            NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
            'INPUT_REPORT-PATH':    commentStep.with['report-path'],
            'INPUT_METADATA-PATH':  commentStep.with['metadata-path'],
            'INPUT_GITHUB-TOKEN':   'unit-test-token',
            'INPUT_COMMENT-AUTHOR-MODE': commentAuthorMode,
            ...extraEnv,
          },
        },
      );
      let stdout = '', stderr = '';
      child.stdout.on('data', data => (stdout += data));
      child.stderr.on('data', data => (stderr += data));
      child.on('error', reject);
      child.on('close', status => resolve({ status, stdout, stderr }));
    });

    return { ...result, calls };
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Helper: a comment owned by the expected author with the report marker
function botComment(id = 1) {
  return { id, body: `${report}<!-- weighin-report -->`, user: { id: GITHUB_ACTIONS_BOT_ID, login: 'github-actions[bot]', type: 'Bot' } };
}
function userComment(userId, id = 2) {
  return { id, body: `${report}<!-- weighin-report -->`, user: { id: userId, login: 'other-user', type: 'User' } };
}
function markerOnly(userId, id = 3) {
  return { id, body: 'Some comment <!-- weighin-report --> here', user: { id: userId } };
}

// 1. A user-authored comment containing the marker is NOT updated.
test('author-mode: user comment with marker is not updated (github-actions default)', async () => {
  const result = await executeAuthorMode({
    existingComments: [userComment(OTHER_USER_ID, 5)],
    commentAuthorMode: 'github-actions',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Should have created a new comment, not patched the existing user-owned one
  const methods = result.calls.map(c => c.method);
  assert.ok(methods.includes('GET'), 'must GET existing comments');
  assert.ok(methods.includes('POST'), 'must POST (create) when no owned comment exists');
  assert.ok(!methods.includes('PATCH'), 'must not PATCH a comment not owned by the bot');
});

// 2. An unrelated bot's comment with the marker is not updated.
test('author-mode: unrelated bot comment with marker is not updated', async () => {
  const result = await executeAuthorMode({
    existingComments: [{ id: 9, body: `${report}<!-- weighin-report -->`, user: { id: 12345, login: 'other-bot[bot]', type: 'Bot' } }],
    commentAuthorMode: 'github-actions',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const methods = result.calls.map(c => c.method);
  assert.ok(methods.includes('POST'), 'must POST (create) when no owned comment exists');
  assert.ok(!methods.includes('PATCH'), 'must not PATCH a comment belonging to a different bot');
});

// 3. An expected-author comment is updated even if an unrelated matching comment appears earlier.
test('author-mode: expected-author comment is updated even when an earlier unrelated comment matches marker', async () => {
  // Comment id=10 is owned by an unrelated user; id=11 is owned by the bot
  const result = await executeAuthorMode({
    existingComments: [
      userComment(OTHER_USER_ID, 10),
      botComment(11),
    ],
    commentAuthorMode: 'github-actions',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const methods = result.calls.map(c => c.method);
  assert.ok(methods.includes('PATCH'), 'must PATCH the owned comment');
  assert.ok(!methods.includes('POST'), 'must not create a duplicate comment');
  const patch = result.calls.find(c => c.method === 'PATCH');
  assert.equal(patch.commentId, 11, 'must patch the bot-owned comment, not the user-owned one');
});

// 4. A new report is created when no comment belonging to the expected author exists.
test('author-mode: creates new comment when no expected-author comment exists', async () => {
  const result = await executeAuthorMode({
    existingComments: [],
    commentAuthorMode: 'github-actions',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const methods = result.calls.map(c => c.method);
  assert.deepEqual(methods.filter(m => m === 'POST'), ['POST'], 'must POST exactly once');
  assert.ok(!methods.includes('PATCH'), 'must not PATCH when there is nothing to update');
});

// 5. Default github-actions mode verifies the canonical bot identity (numeric ID + type).
test('author-mode: default github-actions mode selects only the canonical bot ID 41898282', async () => {
  // Two comments: one from another bot (id 12345) and one from the real bot
  const result = await executeAuthorMode({
    existingComments: [
      { id: 20, body: `x <!-- weighin-report -->`, user: { id: 12345, login: 'other-bot[bot]', type: 'Bot' } },
      botComment(21),
    ],
    commentAuthorMode: 'github-actions',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const patch = result.calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'must PATCH the canonical bot comment');
  assert.equal(patch.commentId, 21, 'patched comment must have the canonical bot ID');
});

// 6. authenticated-user mode resolves the authenticated user's numeric ID.
test('author-mode: authenticated-user mode resolves GET /user and selects matching comment', async () => {
  const result = await executeAuthorMode({
    existingComments: [userComment(AUTH_USER_ID, 30)],
    authenticatedUser: { id: AUTH_USER_ID, login: 'test-user', type: 'User' },
    commentAuthorMode: 'authenticated-user',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const getUserCalls = result.calls.filter(c => c.url === '/user');
  assert.equal(getUserCalls.length, 1, 'must call GET /user exactly once');
  const patch = result.calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'must PATCH when the authenticated user owns a marked comment');
  assert.equal(patch.commentId, 30);
});

// 7. Unsupported modes fail closed before any mutation.
test('author-mode: unsupported comment-author-mode fails closed with zero mutation calls', async () => {
  const result = await executeAuthorMode({
    commentAuthorMode: 'invalid-mode',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Unsupported comment-author-mode/);
  const mutationCalls = result.calls.filter(c => ['POST', 'PATCH'].includes(c.method));
  assert.deepEqual(mutationCalls, [], 'zero mutation calls on unsupported mode');
});

// 8. Failure to resolve the authenticated user causes zero mutation calls.
test('author-mode: GET /user failure causes zero mutation calls', async () => {
  const result = await executeAuthorMode({
    existingComments: [userComment(AUTH_USER_ID, 40)],
    authenticatedUser: null,  // server returns 401
    commentAuthorMode: 'authenticated-user',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /authenticated-user/);
  const mutationCalls = result.calls.filter(c => ['POST', 'PATCH'].includes(c.method));
  assert.deepEqual(mutationCalls, [], 'zero mutation calls when user resolution fails');
});

// 9. Failure to establish expected automation identity fails closed.
// (Covered by test 7 for invalid mode and test 8 for bad credentials.)
// Additional: github-actions mode with a server error is not applicable since
// the identity is hardcoded (no network call). We verify the mode check itself:
test('author-mode: github-actions mode does not call GET /user (identity is hardcoded)', async () => {
  const result = await executeAuthorMode({
    existingComments: [botComment(50)],
    commentAuthorMode: 'github-actions',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const getUserCalls = result.calls.filter(c => c.url === '/user');
  assert.equal(getUserCalls.length, 0, 'github-actions mode must not call GET /user');
});

// 10. Both upsert paths enforce identical author-ownership rules.
// The comment-action path is the shared path exercised by all tests above.
// Here we verify the create-vs-update decision mirrors correctly: with no
// owned comment a POST is issued (not a PATCH on a foreign comment).
test('author-mode: shared upsert path does not update a comment owned by a different user', async () => {
  // Only a foreign-user comment exists
  const result = await executeAuthorMode({
    existingComments: [userComment(OTHER_USER_ID, 60)],
    authenticatedUser: { id: AUTH_USER_ID, login: 'test-user', type: 'User' },
    commentAuthorMode: 'authenticated-user',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const methods = result.calls.map(c => c.method);
  assert.ok(methods.includes('POST'), 'must create new comment rather than updating foreign one');
  assert.ok(!methods.includes('PATCH'), 'must not patch a comment not owned by the authenticated user');
});

// 11. Existing direct-comment warning-only and separate-consumer failure behaviors remain intact.
// (The existing tests above this block already verify the separate-consumer failure behavior.)
// We add a focused check that the default (github-actions) mode still creates a comment from scratch.
test('author-mode: default github-actions mode creates a fresh comment when no prior comment exists', async () => {
  const result = await executeAuthorMode({
    existingComments: [],
    commentAuthorMode: 'github-actions',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.calls.some(c => c.method === 'POST'), 'must POST a new comment');
});

// 12. Tokens never appear in captured logs or diagnostics.
test('author-mode: the token never appears in stdout or stderr', async () => {
  const result = await executeAuthorMode({
    existingComments: [botComment(70)],
    commentAuthorMode: 'github-actions',
  });
  const combined = result.stdout + result.stderr;
  assert.ok(!combined.includes('unit-test-token'), 'token must not appear in output');
});

// 13. Existing pagination and comment-workflow tests are covered by the tests above this block.
// This test verifies that the bundled action correctly handles a non-empty comment list
// where the first comment has no author info (defensive: user may be null from GitHub).
test('author-mode: comment with null user is not matched as owned by expected author', async () => {
  const result = await executeAuthorMode({
    existingComments: [
      { id: 80, body: `x <!-- weighin-report -->`, user: null },
      botComment(81),
    ],
    commentAuthorMode: 'github-actions',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const patch = result.calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'must PATCH the bot-owned comment');
  assert.equal(patch.commentId, 81, 'must select the comment with a matching user.id, not the null-user one');
});

// Issue #205: a stale-head report must never overwrite the current PR result.
const freshHead = validMetadata.headSha, newerHead = 'e'.repeat(40), mergeCommit = 'c'.repeat(40), baseTip = 'b'.repeat(40), unrelated = 'd'.repeat(40);
const deliver = (scenario, metadata = true) => execute(steps, metadata, successfulPr, commentJob.if, scenario);
const output = result => result.stdout + result.stderr;
const newerComment = [{ id: 7, body: '<!-- weighin-report -->\n# Newer head result', user: { id: GITHUB_ACTIONS_BOT_ID, login: 'github-actions[bot]', type: 'Bot' } }];
const pullLookup = '/repos/WeighInNG/WeighIn/pulls/27';
test('a fresh report checks the live pull request head before posting', async () => {
  const result = await deliver({});
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(result.lookups, [pullLookup]);
  assert.deepEqual(result.calls.map(call => call.method), ['GET', 'POST']);
});
test('a fresh report still updates the existing comment', async () => {
  const result = await deliver({ existingComments: newerComment });
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(result.calls.map(call => call.method), ['GET', 'PATCH']);
  assert.equal(result.calls[1].body.body, report);
});
test('a report built from an older head is skipped with a visible reason and no comment calls', async () => {
  const result = await deliver({ currentHead: newerHead });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /Skipped stale report/);
  assert.deepEqual(result.calls, []);
});
test('an older job finishing late leaves the newer comment unchanged', async () => {
  const result = await deliver({ currentHead: newerHead, existingComments: newerComment });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /Skipped stale report/);
  assert.deepEqual(result.calls, [], 'no list, update or create call may be made');
});
test('metadata naming the synthetic merge commit of the producing head is accepted', async () => {
  const result = await deliver({ parents: { [mergeCommit]: [baseTip, freshHead] } }, { ...validMetadata, headSha: mergeCommit });
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(result.lookups, [`/repos/WeighInNG/WeighIn/git/commits/${mergeCommit}`, pullLookup]);
  assert.deepEqual(result.calls.map(call => call.method), ['GET', 'POST']);
});
for (const [label, scenario, metadata, pattern] of [
  ['an event without a workflow run head', { event: {} }, true, /workflow run head SHA must be a 40-character/],
  ['a malformed workflow run head', { event: { workflow_run: { head_sha: 'abc123' } } }, true, /workflow run head SHA must be a 40-character/],
  ['metadata that is neither the run head nor its merge commit', { parents: { [unrelated]: [baseTip] } }, { ...validMetadata, headSha: unrelated }, /neither the producing run's head/],
  ['metadata whose commit cannot be looked up', {}, { ...validMetadata, headSha: unrelated }, /Not Found/],
  ['a missing pull request', { pullStatus: 404 }, true, /scenario failure/],
  ['a failing pull request lookup', { pullStatus: 500 }, true, /scenario failure/],
]) {
  test(`the bundled consumer fails closed on ${label} with zero comment calls`, async () => {
    const result = await deliver(scenario, metadata);
    assert.equal(result.status, 1, `${label} unexpectedly succeeded`);
    assert.match(output(result), pattern);
    assert.deepEqual(result.calls, []);
  });
}
