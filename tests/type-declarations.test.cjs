const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
const consumerTsconfig = {
  compilerOptions: {
    target: 'ES2022',
    module: 'CommonJS',
    moduleResolution: 'node',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
  },
  include: ['index.ts'],
};

let tarballPath, consumerDir;

before(() => {
  const packResult = spawnSync('npm', ['pack'], { cwd: repoRoot, encoding: 'utf8', timeout: 120000 });
  assert.equal(packResult.status, 0, `npm pack failed: ${packResult.stderr}`);
  tarballPath = path.join(repoRoot, packResult.stdout.trim().split('\n').pop().trim());
  consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-types-consumer-'));
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'typed-consumer', private: true, version: '1.0.0' }),
  );
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', tarballPath], {
    cwd: consumerDir,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(install.status, 0, `npm install failed: ${install.stderr}`);
  // A Node consumer provides its own Node typings; reuse the pinned dev copy offline.
  fs.mkdirSync(path.join(consumerDir, 'node_modules/@types'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'node_modules/@types/node'), path.join(consumerDir, 'node_modules/@types/node'), 'dir');
  fs.writeFileSync(path.join(consumerDir, 'tsconfig.json'), JSON.stringify(consumerTsconfig, null, 2));
});

after(() => {
  if (tarballPath) fs.rmSync(tarballPath, { force: true });
  if (consumerDir) fs.rmSync(consumerDir, { recursive: true, force: true });
});

function compile(source, ...flags) {
  fs.writeFileSync(path.join(consumerDir, 'index.ts'), source);
  return spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--pretty', 'false', ...flags], {
    cwd: consumerDir,
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('package types entry names a declaration file included in the packed artifact', () => {
  assert.equal(pkg.types, 'dist/measurement.d.ts');
  assert.equal(pkg.main.replace(/\.js$/, '.d.ts'), pkg.types);
  const installed = path.join(consumerDir, 'node_modules/weighin');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).types, pkg.types);
  for (const file of [pkg.types, 'dist/record-schema.d.ts', 'dist/diff.d.ts']) {
    assert.ok(fs.existsSync(path.join(installed, file)), `packed declaration missing: ${file}`);
  }
});

test('published declarations omit test-only internals', () => {
  const installed = path.join(consumerDir, 'node_modules/weighin/dist');
  const declarations = fs.readdirSync(installed).filter((file) => file.endsWith('.d.ts'));
  assert.ok(declarations.length > 0);
  for (const file of declarations) {
    assert.doesNotMatch(fs.readFileSync(path.join(installed, file), 'utf8'), /_resetSimulationHelperState/, file);
  }
  // Stripping affects declarations only; the runtime module is unchanged.
  assert.equal(typeof require('../dist/simulation')._resetSimulationHelperState, 'function');
});

test('clean external TypeScript consumer compiles against the packed public API', () => {
  const result = compile(`
import {
  runMeasurement,
  metricsFromSimulation,
  toScVal,
  validateMeasurementRecords,
  inspectMeasurementRecord,
  getMeasurementRecordJsonSchema,
  MeasurementRecordValidationError,
  type ContractBenchmark,
  type FixturesSpec,
  type RunMeasurementOptions,
  type RecordValidationDiagnostic,
} from 'weighin';
import { diffBenchmarks } from 'weighin/dist/diff';

const fixtures: FixturesSpec = { contracts: [] } as unknown as FixturesSpec;
const run: (options: RunMeasurementOptions) => Promise<ContractBenchmark[]> = runMeasurement;
const records: ContractBenchmark[] = validateMeasurementRecords([]);
const diagnostics: RecordValidationDiagnostic[] = inspectMeasurementRecord({}).diagnostics;
const schema: object = getMeasurementRecordJsonSchema();
const scval = toScVal({ type: 'symbol', value: 'world' });
const isError = (error: unknown) => error instanceof MeasurementRecordValidationError && error.path.length > 0;
void [fixtures, run, records, diagnostics, schema, scval, isError, metricsFromSimulation, diffBenchmarks];
`);
  assert.equal(result.status, 0, `consumer compile failed:\n${result.stdout}${result.stderr}`);
  // Also check WeighIn's own declarations; third-party SDK declarations are not ours to fix.
  const strict = compile(fs.readFileSync(path.join(consumerDir, 'index.ts'), 'utf8'), '--skipLibCheck', 'false');
  const own = strict.stdout.split('\n').filter((line) => /error TS/.test(line) && !/^node_modules\/(?!weighin\/)/.test(line));
  assert.deepEqual(own, []);
});

test('consumer misuse of the public API is rejected by the shipped types', () => {
  const result = compile(`
import { runMeasurement, validateMeasurementRecords } from 'weighin';
const count: number = validateMeasurementRecords([]);
runMeasurement(42);
`);
  assert.notEqual(result.status, 0, 'type errors must fail compilation');
  assert.match(result.stdout, /index\.ts\(3,7\): error TS2322/);
  assert.match(result.stdout, /index\.ts\(4,16\): error TS2345/);
});

test('consumer cannot reach test-only internals through the declarations', () => {
  const result = compile(`
import { _resetSimulationHelperState } from 'weighin/dist/simulation';
_resetSimulationHelperState();
`);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /index\.ts\(2,10\): error TS2724: '"weighin\/dist\/simulation"' has no exported member named '_resetSimulationHelperState'/);
});
