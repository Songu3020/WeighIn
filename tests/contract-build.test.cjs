const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const exec = require('@actions/exec');
const { buildContracts } = require('../dist/build');

async function scenario(options, verify) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-build-test-'));
  const original = exec.exec, originalFlush = fs.fsyncSync, originalRead = fs.readFileSync;
  let buildReturned = false;
  fs.fsyncSync = descriptor => {
    if (options.failedStorage && (!options.failAfterBuild || buildReturned))
      throw Object.assign(new Error('injected temporary-storage quota exceeded'), { code: 'EDQUOT' });
    return originalFlush(descriptor);
  };
  fs.readFileSync = (file, ...args) => {
    if (options.corruptStorage && path.basename(String(file)) === '.weighin-storage-probe')
      return Buffer.from('truncated temporary file');
    return originalRead(file, ...args);
  };
  const commands = [];
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 1, 0]);
  const names = options.names || ['hello-contract'];
  const packages = options.packages ? options.packages(directory) : names.map((name, index) => {
    const manifest_path = path.join(directory, `crate${index}`, 'Cargo.toml');
    fs.mkdirSync(path.dirname(manifest_path), { recursive: true }); fs.writeFileSync(manifest_path, '[package]');
    const targetName = options.targetNames?.[index] || name;
    const targets = [{ name: targetName, crate_types: ['cdylib'] }];
    if (options.multipleCdylibTargets)
      targets.push({ name: `${targetName}-other`, crate_types: ['cdylib'] });
    return { id: `pkg${index}`, name, manifest_path, targets };
  });
  fs.writeFileSync(path.join(directory, 'Cargo.toml'), '[workspace]');
  const fixtures = path.join(directory, 'fixtures.json');
  const destinations = options.paths || names.map(name => `target/wasm32v1-none/release/${name.replaceAll('-', '_')}.wasm`);
  fs.writeFileSync(fixtures, JSON.stringify({ contracts: destinations.map((wasm_path, i) => ({ id: `contract${i}`, wasm_path, invocations: [{ function_name: 'hello', args: [] }] })) }));
  for (const destination of destinations) {
    fs.mkdirSync(path.dirname(path.join(directory, destination)), { recursive: true });
    fs.writeFileSync(path.join(directory, destination), 'stale artifact');
  }
  exec.exec = async (command, args, config) => {
    commands.push({ command, args, env: config.env, cwd: config.cwd });
    const emit = text => config.listeners.stdout(Buffer.from(text));
    if (command === 'rustc') emit(typeof options.rust === 'function' ? options.rust(config.cwd, config.env) : (options.rust || 'rustc 1.95.0'));
    else if (command === 'cargo') {
      if (options.cargoMetadataRaw !== undefined) {
        const raw = typeof options.cargoMetadataRaw === 'function' ? options.cargoMetadataRaw(directory) : options.cargoMetadataRaw;
        emit(typeof raw === 'string' ? raw : JSON.stringify(raw));
      } else {
        const manifestIndex = args.indexOf('--manifest-path');
        const manifestArg = manifestIndex !== -1 ? args[manifestIndex + 1] : null;
        const relevantPackages = packages.filter(p => !manifestArg || p.manifest_path === manifestArg || path.dirname(p.manifest_path) === path.dirname(manifestArg));
        const selected = relevantPackages.length > 0 ? relevantPackages : packages;
        emit(JSON.stringify({ workspace_members: selected.map(pkg => pkg.id), packages: selected, ...(options.cargoMetadataExtra || {}) }));
      }
    }
    else if (command === 'stellar' && args[0] === '--version') {
      if (options.missingCli) throw new Error('stellar executable not found');
      emit(options.stellar || 'stellar 28.1.0');
    } else if (command === 'stellar') {
      if (options.buildFailure) throw new Error('actual build failed');
      if (options.skippedOptimization) config.listeners.stderr(Buffer.from('Optimization skipped'));
      if (!options.missingOutput) {
        const packageName = args[args.indexOf('--package') + 1];
        const pkg = packages.find(candidate => candidate.name === packageName);
        const targetName = pkg.targets.find(target => target.crate_types.includes('cdylib')).name;
        fs.writeFileSync(path.join(args[args.indexOf('--out-dir') + 1], `${targetName.replaceAll('-', '_')}.wasm`), options.badWasm ? 'invalid' : wasm);
      }
      buildReturned = true;
    } else throw new Error('Unexpected command');
    return 0;
  };
  try { await verify({ fixtures, directory, commands, wasm, destinations }); }
  finally { exec.exec = original; fs.fsyncSync = originalFlush; fs.readFileSync = originalRead; fs.rmSync(directory, { recursive: true, force: true }); }
}

test('modern optimized build replaces stale configured WASM with fresh selected-package output', async () => scenario({}, async ({ fixtures, directory, commands, wasm, destinations }) => {
  const results = await buildContracts(fixtures, directory, '1.95.0');
  assert.deepEqual(fs.readFileSync(path.join(directory, destinations[0])), wasm);
  assert.equal(results[0].package, 'hello-contract'); assert.match(results[0].wasm_sha256, /^[a-f0-9]{64}$/);
  const build = commands.find(command => command.command === 'stellar' && command.args[0] === 'contract');
  assert.ok(build.args.includes('--locked')); assert.ok(build.args.includes('--optimize=true'));
  assert.ok(commands.every(command => command.env.RUSTUP_TOOLCHAIN === '1.95.0'));
  assert.equal(commands.some(command => command.args.includes('wasm32-unknown-unknown')), false);
}));
test('Cargo cdylib target name selects and reads WASM independently of package name', async () => scenario({
  names: ['cargo-package-name'],
  targetNames: ['library-target-name'],
  paths: ['artifacts/library_target_name.wasm'],
}, async ({ fixtures, directory, commands, destinations, wasm }) => {
  const results = await buildContracts(fixtures, directory);
  assert.deepEqual(fs.readFileSync(path.join(directory, destinations[0])), wasm);
  assert.equal(results[0].package, 'cargo-package-name');
  const build = commands.find(command => command.command === 'stellar' && command.args[0] === 'contract');
  assert.equal(build.args[build.args.indexOf('--package') + 1], 'cargo-package-name');
}));
test('multiple cdylib targets in one package fail before compilation', async () => scenario({
  multipleCdylibTargets: true,
}, async ({ fixtures, directory, commands }) => {
  await assert.rejects(buildContracts(fixtures, directory), /ambiguous multiple cdylib targets/);
  assert.ok(!commands.some(command => command.command === 'stellar' && command.args[0] === 'contract'));
}));
test('multiple workspace contracts select independent packages; repeated package aliases build once', async () => scenario({ names: ['first', 'second'], paths: ['artifacts/first.wasm', 'artifacts/second.wasm', 'other/first.wasm'] }, async ({ fixtures, directory, commands }) => {
  const results = await buildContracts(fixtures, directory);
  assert.deepEqual(results.map(result => result.package), ['first', 'second', 'first']);
  assert.equal(commands.filter(command => command.command === 'stellar' && command.args[0] === 'contract').length, 2);
}));
test('temporary migration alias receives the same fresh WASM from one modern build', async () => scenario({paths:[
  'target/wasm32v1-none/release/hello_contract.wasm',
  'target/wasm32-unknown-unknown/release/hello_contract.wasm',
]},async({fixtures,directory,commands,destinations,wasm})=>{
  const results=await buildContracts(fixtures,directory,'1.95.0');
  assert.equal(results.length,2);assert.equal(results[0].wasm_sha256,results[1].wasm_sha256);
  for(const destination of destinations)assert.deepEqual(fs.readFileSync(path.join(directory,destination)),wasm);
  const builds=commands.filter(command=>command.command==='stellar'&&command.args[0]==='contract');
  assert.equal(builds.length,1);assert.ok(builds[0].args.includes('--optimize=true'));
  assert.equal(commands.some(command=>command.args.includes('wasm32-unknown-unknown')),false);
}));
test('ambiguous Cargo packages are rejected before building', async () => scenario({ names: ['same', 'same'], paths: ['artifacts/same.wasm'] }, async ({ fixtures, directory, commands }) => {
  await assert.rejects(buildContracts(fixtures, directory), /exactly one.*found 2/);
  assert.ok(!commands.some(command => command.args[0] === 'contract'));
}));
test('unknown artifact basename is rejected before building any package', async () => scenario({ paths: ['artifacts/unrelated.wasm'] }, async ({ fixtures, directory }) => {
  await assert.rejects(buildContracts(fixtures, directory), /exactly one.*found 0/);
}));
for (const [label, options, expected] of [
  ['missing CLI', { missingCli: true }, /not found/],
  ['obsolete Rust', { rust: 'rustc 1.83.0' }, /Rust 1.84/],
  ['obsolete CLI', { stellar: 'stellar 25.2.0' }, /Stellar CLI 28.1/],
  ['failed build', { buildFailure: true }, /actual build failed/],
  ['missing output despite stale destination', { missingOutput: true }, /ENOENT/],
  ['invalid WASM output', { badWasm: true }, /valid WASM/],
  ['optimization skipped', { skippedOptimization: true }, /optimization support/],
]) test(`build fails explicitly for ${label}`, async () => scenario(options, async ({ fixtures, directory }) => {
  await assert.rejects(buildContracts(fixtures, directory), expected);
}));
test('every declared contract must have a manifest, even when another one is valid', async () => scenario({}, async ({ fixtures, directory }) => {
  const spec = JSON.parse(fs.readFileSync(fixtures));
  spec.contracts.push({ id: 'missing', wasm_path: 'isolated/no-manifest/other.wasm', invocations: [{ function_name: 'hello', args: [] }] });
  fs.rmSync(path.join(directory, 'Cargo.toml'), { force: true });
  fs.writeFileSync(fixtures, JSON.stringify(spec));
  await assert.rejects(buildContracts(fixtures, directory), /No Cargo.toml/);
}));


test('both revisions use verified isolated CLI temporary storage without changing caller environment', async () => scenario({}, async ({ fixtures, directory, commands }) => {
  const callerEnvironment = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  await buildContracts(fixtures, directory, '1.95.0');
  await buildContracts(fixtures, directory, '1.95.0');
  const builds = commands.filter(c => c.command === 'stellar' && c.args[0] === 'contract');
  assert.equal(builds.length, 2);
  assert.notEqual(builds[0].env.TMPDIR, builds[1].env.TMPDIR);
  for (const build of builds) {
    const dir = build.args[build.args.indexOf('--out-dir') + 1];
    assert.equal(build.env.TMPDIR, dir);
    assert.equal(build.env.TEMP, dir); assert.equal(build.env.TMP, dir);
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.equal(fs.existsSync(dir), false, 'Owned build directory must be cleaned');
  }
  assert.deepEqual({ TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }, callerEnvironment);
}));
for (const [label, options, afterBuild] of [
  ['storage flush fails before optimization', { failedStorage: true }, false],
  ['storage contents are truncated before optimization', { corruptStorage: true }, false],
  ['storage flush fails after successful CLI exit', { failedStorage: true, failAfterBuild: true }, true],
]) test(label, async () => scenario(options, async ({ fixtures, directory, commands, destinations }) => {
  const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('weighin-build-')).sort();
  await assert.rejects(buildContracts(fixtures, directory), /Build temporary storage is unusable.*refusing to accept optimizer output/);
  assert.equal(commands.some(c => c.command === 'stellar' && c.args[0] === 'contract'), afterBuild);
  assert.equal(fs.readFileSync(path.join(directory, destinations[0]), 'utf8'), 'stale artifact');
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('weighin-build-')).sort(), before);
}));
test('missing caller temporary-storage directory fails visibly before optimization', async () => scenario({}, async ({ fixtures, directory, commands }) => {
  const previous = process.env.TMPDIR;
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  const missingPath = path.join(directory, 'missing-temp');
  process.env.TMPDIR = missingPath;
  process.env.TEMP = missingPath;
  process.env.TMP = missingPath;
  try { await assert.rejects(buildContracts(fixtures, directory), /Cannot create build temporary storage/); }
  finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP; else process.env.TMP = previousTmp;
  }
  assert.equal(commands.some(c => c.command === 'stellar' && c.args[0] === 'contract'), false);
}));

test('buildContracts requires an explicit workspace root in the builder API', async () => {
  await assert.rejects(buildContracts('fixtures.json'), /Workspace root is required/);
  await assert.rejects(buildContracts('fixtures.json', ''), /Workspace root is required/);
  await assert.rejects(buildContracts('fixtures.json', '   '), /Workspace root is required/);
  await assert.rejects(buildContracts('fixtures.json', '/nonexistent/workspace/root'), /Workspace root does not exist/);
});

test('rejects destination traversal escape before any commands or writes', async () => scenario({}, async ({ fixtures, directory, commands }) => {
  const spec = JSON.parse(fs.readFileSync(fixtures));
  spec.contracts[0].wasm_path = '../../outside.wasm';
  fs.writeFileSync(fixtures, JSON.stringify(spec));
  await assert.rejects(buildContracts(fixtures, directory), /escapes workspace root/);
  assert.equal(commands.filter(c => c.command === 'stellar' && c.args[0] === 'contract').length, 0);
}));

test('rejects destination symlink escape before any commands or writes', async () => scenario({}, async ({ fixtures, directory, commands }) => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-outside-dest-'));
  const symlinkDir = path.join(directory, 'symlink-dest');
  try {
    fs.symlinkSync(outsideDir, symlinkDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    fs.rmSync(outsideDir, { recursive: true, force: true });
    return;
  }
  const spec = JSON.parse(fs.readFileSync(fixtures));
  spec.contracts[0].wasm_path = 'symlink-dest/sub/hello_contract.wasm';
  fs.writeFileSync(fixtures, JSON.stringify(spec));
  try {
    await assert.rejects(buildContracts(fixtures, directory), /escapes workspace root/);
    assert.equal(commands.filter(c => c.command === 'stellar' && c.args[0] === 'contract').length, 0);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}));

test('manifest search stops at workspace root and does not ascend to filesystem root', async () => scenario({}, async ({ fixtures, directory, commands }) => {
  fs.rmSync(path.join(directory, 'Cargo.toml'), { force: true });
  fs.rmSync(path.join(directory, 'crate0', 'Cargo.toml'), { force: true });
  await assert.rejects(buildContracts(fixtures, directory), /No Cargo.toml found/);
  assert.equal(commands.filter(c => c.command === 'cargo' || (c.command === 'stellar' && c.args[0] === 'contract')).length, 0);
}));

test('rejects Cargo manifest symlink escaping workspace root', async () => scenario({}, async ({ fixtures, directory }) => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-outside-manifest-'));
  fs.writeFileSync(path.join(outsideDir, 'Cargo.toml'), '[workspace]');
  fs.rmSync(path.join(directory, 'Cargo.toml'), { force: true });
  let created = false;
  try {
    fs.symlinkSync(path.join(outsideDir, 'Cargo.toml'), path.join(directory, 'Cargo.toml'));
    created = true;
  } catch (err) {
    if (process.platform === 'win32') {
      const originalRealpath = fs.realpathSync;
      fs.realpathSync = (p, options) => {
        if (p === path.join(directory, 'Cargo.toml')) {
          return path.join(outsideDir, 'Cargo.toml');
        }
        return originalRealpath(p, options);
      };
      fs.writeFileSync(path.join(directory, 'Cargo.toml'), '[workspace]');
      try {
        await assert.rejects(buildContracts(fixtures, directory), /escapes workspace root/);
      } finally {
        fs.realpathSync = originalRealpath;
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
      return;
    }
    throw err;
  }
  try {
    await assert.rejects(buildContracts(fixtures, directory), /escapes workspace root/);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}));

test('nested legitimate Cargo workspaces within workspace root are supported', async () => scenario({}, async ({ directory, wasm }) => {
  const nestedDir = path.join(directory, 'nested', 'workspace');
  const crateDir = path.join(nestedDir, 'crate');
  fs.mkdirSync(crateDir, { recursive: true });
  fs.writeFileSync(path.join(nestedDir, 'Cargo.toml'), '[workspace]');
  fs.writeFileSync(path.join(crateDir, 'Cargo.toml'), '[package]');
  const nestedFixtures = path.join(nestedDir, 'fixtures.json');
  fs.writeFileSync(nestedFixtures, JSON.stringify({
    contracts: [{
      id: 'nested-contract',
      wasm_path: 'crate/target/wasm32v1-none/release/hello_contract.wasm',
      invocations: [{ function_name: 'hello', args: [] }],
    }],
  }));
  const results = await buildContracts(nestedFixtures, directory, '1.95.0');
  assert.equal(results.length, 1);
  assert.equal(results[0].package, 'hello-contract');
  assert.deepEqual(fs.readFileSync(path.join(nestedDir, 'crate/target/wasm32v1-none/release/hello_contract.wasm')), wasm);
}));

test('conflicting build destinations with incompatible packages are rejected before building', async () => scenario({
  packages: directory => {
    const dir0 = path.join(directory, 'crate0');
    const dir1 = path.join(directory, 'crate1');
    fs.mkdirSync(path.join(dir0, 'target/wasm32v1-none/release'), { recursive: true });
    fs.writeFileSync(path.join(dir0, 'Cargo.toml'), '[package]');
    fs.mkdirSync(dir1, { recursive: true });
    fs.writeFileSync(path.join(dir1, 'Cargo.toml'), '[package]');
    const targetAlias = path.join(dir1, 'target_alias');
    try {
      fs.symlinkSync(path.join(dir0, 'target'), targetAlias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Fallback if symlink fails
      fs.mkdirSync(path.join(targetAlias, 'wasm32v1-none/release'), { recursive: true });
    }
    return [
      { id: 'pkg0', name: 'common-contract', manifest_path: path.join(dir0, 'Cargo.toml'), targets: [{ name: 'common_contract', crate_types: ['cdylib'] }] },
      { id: 'pkg1', name: 'common-contract', manifest_path: path.join(dir1, 'Cargo.toml'), targets: [{ name: 'common_contract', crate_types: ['cdylib'] }] },
    ];
  },
  paths: [
    'crate0/target/wasm32v1-none/release/common_contract.wasm',
    'crate1/target_alias/wasm32v1-none/release/common_contract.wasm',
  ],
}, async ({ fixtures, directory, commands }) => {
  await assert.rejects(buildContracts(fixtures, directory), /Conflicting build destinations:.*already claimed by package/);
  assert.ok(!commands.some(command => command.args[0] === 'contract'));
}));

test('intentional repeated declarations with the same destination and package succeed', async () => scenario({
  names: ['hello-contract'],
  paths: [
    'target/wasm32v1-none/release/hello_contract.wasm',
    'target/wasm32v1-none/release/./hello_contract.wasm',
  ],
}, async ({ fixtures, directory, destinations, wasm }) => {
  const results = await buildContracts(fixtures, directory, '1.95.0');
  assert.equal(results.length, 2);
  assert.equal(results[0].package, 'hello-contract');
  assert.equal(results[1].package, 'hello-contract');
  assert.deepEqual(fs.readFileSync(path.join(directory, destinations[0])), wasm);
}));

test('foreign workspace members in Cargo metadata are rejected with actionable error', async () => scenario({
  cargoMetadataRaw: directory => ({
    packages: [{ id: 'pkg0', name: 'hello-contract', manifest_path: path.join(directory, 'crate0', 'Cargo.toml'), targets: [{ name: 'hello_contract', crate_types: ['cdylib'] }] }],
    workspace_members: ['pkg0', 'foreign-crate-id'],
  }),
}, async ({ fixtures, directory, commands }) => {
  await assert.rejects(buildContracts(fixtures, directory), /foreign workspace member foreign-crate-id not found in packages list/);
  assert.ok(!commands.some(c => c.args[0] === 'contract'));
}));

test('unusable manifest_path in Cargo metadata is rejected before building', async () => scenario({
  cargoMetadataRaw: {
    packages: [{ id: 'pkg0', name: 'hello-contract', manifest_path: '/nonexistent/path/Cargo.toml', targets: [{ name: 'hello_contract', crate_types: ['cdylib'] }] }],
    workspace_members: ['pkg0'],
  },
}, async ({ fixtures, directory, commands }) => {
  await assert.rejects(buildContracts(fixtures, directory), /has unusable manifest_path \/nonexistent\/path\/Cargo.toml: file does not exist/);
  assert.ok(!commands.some(c => c.args[0] === 'contract'));
}));

test('malformed targets in Cargo metadata are rejected before building', async () => scenario({
  cargoMetadataRaw: directory => ({
    packages: [{ id: 'pkg0', name: 'hello-contract', manifest_path: path.join(directory, 'crate0', 'Cargo.toml'), targets: 'not-an-array' }],
    workspace_members: ['pkg0'],
  }),
}, async ({ fixtures, directory, commands }) => {
  await assert.rejects(buildContracts(fixtures, directory), /Invalid Cargo metadata/);
  assert.ok(!commands.some(c => c.args[0] === 'contract'));
}));

test('malformed Cargo metadata payload is rejected before building', async () => scenario({
  cargoMetadataRaw: {
    packages: 'invalid',
    workspace_members: ['pkg0'],
  },
}, async ({ fixtures, directory, commands }) => {
  await assert.rejects(buildContracts(fixtures, directory), /Invalid Cargo metadata/);
  assert.ok(!commands.some(c => c.args[0] === 'contract'));
}));

test('valid version-1 Cargo metadata with harmless unknown fields passes cleanly', async () => scenario({
  cargoMetadataExtra: {
    version: 1,
    workspace_root: '/workspace',
    target_directory: '/workspace/target',
    harmless_extension_field: { key: 'value' },
  },
}, async ({ fixtures, directory, destinations, wasm }) => {
  const results = await buildContracts(fixtures, directory, '1.95.0');
  assert.equal(results.length, 1);
  assert.equal(results[0].package, 'hello-contract');
  assert.deepEqual(fs.readFileSync(path.join(directory, destinations[0])), wasm);
}));

test('probes effective compiler in each distinct package context directory', async () => scenario({
  names: ['first-contract', 'second-contract'],
  rust: (cwd) => {
    return 'rustc 1.95.0 (stable)';
  },
}, async ({ fixtures, directory, commands }) => {
  await buildContracts(fixtures, directory);
  const rustcCalls = commands.filter(c => c.command === 'rustc');
  assert.ok(rustcCalls.length >= 2, 'should invoke rustc for distinct package directories');
  const dir0 = path.join(directory, 'crate0');
  const dir1 = path.join(directory, 'crate1');
  assert.ok(rustcCalls.some(c => c.cwd === dir0), 'should probe crate0 context');
  assert.ok(rustcCalls.some(c => c.cwd === dir1), 'should probe crate1 context');
}));

test('rejects unsupported crate-local toolchain before building that package', async () => scenario({
  names: ['first-contract', 'second-contract'],
  rust: (cwd) => {
    if (cwd && cwd.endsWith('crate1')) {
      return 'rustc 1.83.0 (compat-test)';
    }
    return 'rustc 1.95.0 (stable)';
  },
}, async ({ fixtures, directory, commands }) => {
  await assert.rejects(buildContracts(fixtures, directory), /Rust 1.84\+ is required for wasm32v1-none; got rustc 1.83.0/);
  assert.ok(!commands.some(c => c.command === 'stellar' && c.args && c.args[0] === 'contract'), 'should not execute stellar contract build');
}));

test('preserves explicit rust-toolchain override for both crate checks and builds', async () => scenario({
  rust: (cwd, env) => {
    return 'rustc 1.95.0 (override)';
  },
}, async ({ fixtures, directory, commands }) => {
  await buildContracts(fixtures, directory, 'nightly-2024-11-01');
  const rustcCalls = commands.filter(c => c.command === 'rustc');
  assert.ok(rustcCalls.length > 0, 'should invoke rustc');
  assert.ok(rustcCalls.every(c => c.env && c.env.RUSTUP_TOOLCHAIN === 'nightly-2024-11-01'), 'probe command should use toolchain override');
  const stellarContractCalls = commands.filter(c => c.command === 'stellar' && c.args && c.args[0] === 'contract');
  assert.ok(stellarContractCalls.length > 0);
  assert.ok(stellarContractCalls.every(c => c.env && c.env.RUSTUP_TOOLCHAIN === 'nightly-2024-11-01'));
}));
