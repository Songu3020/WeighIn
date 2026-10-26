const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { spawnSync } = require("node:child_process");
test("package main loads the existing measurement API", () => {
  const api = require("..");
  assert.equal(typeof api.runMeasurement, "function");
  assert.equal(typeof api.metricsFromSimulation, "function");
});
test("declared CLI entry runs and fails clearly without producing results for missing fixtures", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-package-entry-"),
  );
  try {
    const pkg = require("../package.json"),
      output = path.join(temporary, "results.json");
    const r = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, "..", pkg.bin.weighin),
        path.join(temporary, "missing.json"),
        "--output",
        output,
      ],
      { cwd: temporary, encoding: "utf8", timeout: 10000 },
    );
    assert.ifError(r.error);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Benchmarking failed/);
    assert.match(r.stderr, /ENOENT/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("CLI output writer creates nested parents and atomically writes valid JSON", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-output-"));
  try {
    const { writeResultsFile } = require("../dist/cli.js");
    const output = path.join(temporary, "missing", "nested", "results.json");
    writeResultsFile(output, { ok: true, answer: 42 });
    assert.equal(fs.existsSync(output), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
      ok: true,
      answer: 42,
    });
    const dirEntries = fs.readdirSync(path.dirname(output));
    assert.equal(
      dirEntries.some((entry) => entry.startsWith(".weighin-results-")),
      false,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("CLI output writer preserves a prior result when delivery fails", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "weighin-output-fail-"),
  );
  const output = path.join(temporary, "nested", "results.json");
  const prior = { status: "previous" };
  try {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(prior), "utf8");
    const { writeResultsFile } = require("../dist/cli.js");
    const originalWrite = fs.writeFileSync;
    const originalRename = fs.renameSync;
    fs.writeFileSync = function (target, ...args) {
      if (typeof target === "string" && target.includes(".weighin-results-")) {
        throw Object.assign(new Error("simulated write failure"), {
          code: "EACCES",
        });
      }
      return originalWrite.call(this, target, ...args);
    };
    fs.renameSync = function (target, ...args) {
      if (typeof target === "string" && target.includes(".weighin-results-")) {
        throw Object.assign(new Error("simulated rename failure"), {
          code: "EACCES",
        });
      }
      return originalRename.call(this, target, ...args);
    };
    try {
      assert.throws(
        () => writeResultsFile(output, { status: "next" }),
        /EACCES|simulated/,
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), prior);
    } finally {
      fs.writeFileSync = originalWrite;
      fs.renameSync = originalRename;
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('CLI rejects ambiguous combination of stdout mode and explicit output file',()=>{
  const pkg=require('../package.json');
  const bin=path.resolve(__dirname,'..',pkg.bin.weighin);

  // Case 1: --json-stdout and --output file.json
  const r1=spawnSync(process.execPath,[bin,'fixtures.json','--json-stdout','--output','out.json'],
    {encoding:'utf8',timeout:5000});
  assert.equal(r1.status,1);
  assert.match(r1.stderr,/Ambiguous output configuration/);
  assert.equal(r1.stdout,'');

  // Case 2: --stdout and positional output
  const r2=spawnSync(process.execPath,[bin,'fixtures.json','positional.json','--stdout'],
    {encoding:'utf8',timeout:5000});
  assert.equal(r2.status,1);
  assert.match(r2.stderr,/Ambiguous output configuration/);
  assert.equal(r2.stdout,'');
});

test('CLI stdout failure emits error on stderr and nothing on stdout',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'weighin-stdout-fail-'));
  try{
    const pkg=require('../package.json');
    const bin=path.resolve(__dirname,'..',pkg.bin.weighin);
    const r=spawnSync(process.execPath,[bin,path.join(temporary,'nonexistent.json'),'--json-stdout'],
      {cwd:temporary,encoding:'utf8',timeout:10000});
    assert.equal(r.status,1);
    assert.match(r.stderr,/Benchmarking failed/);
    assert.equal(r.stdout,'');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
