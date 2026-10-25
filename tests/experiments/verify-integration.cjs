// Explicit live proof, excluded from npm test. Uses production measurement and
// actual native meters. Requires genuine prebuilt BASE/HEAD WASMs and local RPC.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { runMeasurement } = require('../../dist/measurement');
const { diffBenchmarks } = require('../../dist/diff');
const { enforceThresholds } = require('../../dist/threshold');
const { renderComment } = require('../../dist/comment');
const [baseWasm, headWasm, outputDirectory] = process.argv.slice(2);
if (!outputDirectory) throw new Error('Usage: node tests/experiments/verify-integration.cjs BASE_WASM HEAD_WASM OUTPUT_DIR');
const output = path.resolve(outputDirectory);
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-integrated-'));
const originalFetch = globalThis.fetch;
const captures = [];
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (args[1]?.method === 'POST') {
    const request = JSON.parse(args[1].body);
    captures.push({ request, raw: await response.clone().json() });
    fs.writeFileSync(path.join(output, 'rpc-captures.json'), JSON.stringify(captures, null, 2) + '\n');
  }
  return response;
};
const rpcUrl = process.env.WEIGHIN_EXPERIMENT_RPC_URL || 'http://localhost:18000/rpc';
const write = (name, data) => fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
function child(command, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { env, cwd }); let stdout = '', stderr = '';
    process.stdout.on('data', data => { stdout += data; }); process.stderr.on('data', data => { stderr += data; });
    process.on('error', reject); process.on('close', status => resolve({ status, stdout, stderr }));
  });
}
function workspace(label, wasm) {
  const dir = path.join(temporary, label); fs.mkdirSync(path.join(dir, 'contract'), { recursive: true });
  fs.copyFileSync(wasm, path.join(dir, 'contract/contract.wasm'));
  fs.writeFileSync(path.join(dir, 'contract/Cargo.toml'), '[package]\nname="experiment"\nversion="0.0.0"\n');
  fs.writeFileSync(path.join(dir, 'contract/Cargo.lock'), 'name = "soroban-sdk"\nversion = "25.3.1"\n');
  fs.writeFileSync(path.join(dir, 'fixtures.json'), JSON.stringify({ id: 'integration-suite', contracts: [{ id: 'greeting', wasm_path: 'contract/contract.wasm', invocations: [{ id: 'world', function_name: 'hello', args: [{ type: 'Symbol', value: 'world' }] }] }] }));
  return dir;
}
async function main() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
      const body = await response.json(); if (body.result?.status === 'healthy') break;
    } catch {}
    if (attempt === 59) throw new Error('RPC not healthy');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const baseDir = workspace('base', baseWasm), headDir = workspace('head', headWasm);
  const keyFile = path.join(temporary, 'deployer.key');
  const measure = dir => runMeasurement({ fixturesPath: path.join(dir, 'fixtures.json'), fixtureId: 'fixtures.json', gitCommit: path.basename(dir), sdkVersion: '25.3.1', keyFile, rpcUrl });
  // Deploy both before taking the comparison measurements; invocation writes are simulated only.
  await measure(baseDir); await measure(headDir);
  const base = await measure(baseDir), control = await measure(baseDir), head = await measure(headDir);
  write('base', base); write('control', control); write('head', head);
  const controlDiff = diffBenchmarks(base, control), regression = diffBenchmarks(base, head);
  const cpuPolicy = { thresholds: { functions: { hello: { cpu_instructions: 'strict_zero_tolerance' } } } };
  assert.deepEqual(enforceThresholds(controlDiff, cpuPolicy), []);
  assert.equal(controlDiff.hasRegression, false);
  assert.equal(regression.contracts.length, 1);
  assert.notEqual(base[0].contract_id, head[0].contract_id);
  assert.notEqual(base[0].benchmarks[0].wasm_sha256, head[0].benchmarks[0].wasm_sha256);
  const cpu = regression.contracts[0].functions[0].metrics.find(metric => metric.key === 'cpu_instructions');
  assert.ok(cpu.delta > 0);
  const violations = enforceThresholds(regression, cpuPolicy); assert.equal(violations.length, 1);
  write('control-diff', controlDiff); write('regression-diff', regression); write('violations', violations);
  fs.writeFileSync(path.join(output, 'report.md'), renderComment(regression, violations, 'temporary-base', 'temporary-head'));
  // Public CLI measures and serializes schema 4 using the same production adapter.
  const cliFile = path.join(temporary, 'cli-results.json');
  const cli = await child(process.execPath, [path.resolve(__dirname, '../../dist/cli.js'), 'fixtures.json', '--output', cliFile, '--rpc-url', rpcUrl], process.env, headDir);
  write('cli-process', cli); assert.equal(cli.status, 0, cli.stderr);
  const cliResults = JSON.parse(fs.readFileSync(cliFile)); assert.equal(cliResults[0].schema_version, 5); write('cli-results', cliResults);
  const failedOutput = path.join(temporary, 'missing-helper-results.json');
  const failure = await child(process.execPath, [path.resolve(__dirname, '../../dist/cli.js'), 'fixtures.json', '--output', failedOutput, '--rpc-url', rpcUrl], { ...process.env, WEIGHIN_HELPER_PATH: path.join(temporary, 'missing-helper') }, headDir);
  write('cli-missing-helper-process', failure);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /missing or not executable/);
  assert.equal(fs.existsSync(failedOutput), false);
  const action = [];
  for (const [label, directory, policy, expected, failureMode] of [
    ['control', baseDir, '[thresholds.functions.hello]\ncpu_instructions="strict_zero_tolerance"\n', 0],
    ['regression', headDir, '[thresholds.functions.hello]\ncpu_instructions="strict_zero_tolerance"\n', 1],
    ['unavailable', baseDir, '[thresholds.functions.hello]\nhistorical_data_read_bytes="strict_zero_tolerance"\n', 1],
    ...['checkout', 'worktree', 'build', 'missing-fixtures', 'measurement'].map(mode =>
      [`baseline-${mode}`, baseDir, '[thresholds.functions.hello]\ncpu_instructions="strict_zero_tolerance"\n', 1, mode]),
    ['invalid-policy', baseDir, '[thresholds.functions.hello]\ncpu_instructions="typo"\n', 1, 'invalid-policy'],
  ]) {
    fs.writeFileSync(path.join(directory, 'weighin.toml'), policy);
    const runnerTemp = path.join(temporary, `action-${label}`); fs.mkdirSync(runnerTemp);
    fs.copyFileSync(keyFile, path.join(runnerTemp, 'weighin-deployer.key'));
    fs.chmodSync(path.join(runnerTemp, 'weighin-deployer.key'), 0o600);
    const summary = path.join(output, `action-${label}-summary.md`); fs.writeFileSync(summary, '');
    const outputs = path.join(output, `action-${label}-outputs.txt`); fs.writeFileSync(outputs, '');
    const env = { ...process.env, TMPDIR: runnerTemp, GITHUB_WORKSPACE: directory, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary,
      'INPUT_FIXTURES-PATH': 'fixtures.json', 'INPUT_CONFIG-PATH': 'weighin.toml', 'INPUT_RPC-URL': rpcUrl,
      'INPUT_GITHUB-TOKEN': '', 'INPUT_BASE-REF': 'main', WEIGHIN_EXPERIMENT_BASE_DIR: baseDir, WEIGHIN_EXPERIMENT_FAILURE: failureMode || '', WEIGHIN_EXPERIMENT_CAPTURE_FILE: path.join(output, `action-${label}-rpc.json`) };
    const result = await child(process.execPath, ['--require', path.resolve(__dirname, 'action-local-hook.cjs'), path.resolve(__dirname, '../../bundled/index.js')], env, directory);
    write(`action-${label}-process`, result);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    const fields = fs.readFileSync(outputs, 'utf8'); assert.ok(fields.includes(expected ? 'fail' : 'pass'));
    const report = fs.readFileSync(summary, 'utf8');
    if (failureMode) {
      assert.match(report, /comparison failed/); assert.match(report, /No passing comparison/);
      assert.ok(!fields.includes('no-baseline'));
    } else { assert.ok(report.includes('Unavailable')); assert.ok(report.includes('id:greeting')); }
    if (label === 'regression') assert.match(report, /CPU Instructions.*increased/);
    if (label === 'unavailable') assert.match(report, /unavailable; cannot evaluate/);
    action.push({ label, expected_exit: expected, actual_exit: result.status });
  }
  const summary = { status: 'INTEGRATED_MEASUREMENT_PROOF_PASS', control_delta: 0, cpu_base: cpu.base.consumed,
    cpu_head: cpu.head.consumed, cpu_delta: cpu.delta, cpu_pct: cpu.pct, threshold_violations: violations.length,
    cli_measurement_exit: cli.status, cli_missing_helper_exit: failure.status, action_exit_checks: action, real_network_and_native_measurement: true,
    contract_build_and_checkout_stubbed_for_action: true, public_github_ci_run_proven: false };
  write('verification', summary); console.log(JSON.stringify(summary, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
