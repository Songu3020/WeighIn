const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const actionEntries = [
  { name: "bundled", file: path.resolve(__dirname, "../bundled/index.js"), useHook: false },
  { name: "compiled", file: path.resolve(__dirname, "../dist/action.js"), useHook: true },
];

function runActionWithInputs({
  entryFile,
  useHook = false,
  skipBuildInput = null,
  buildCommandInput = "",
  fixturesPath = "fixtures.json",
  rpcUrl = "http://localhost:9999/unreachable-rpc",
}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-skip-build-test-"));
  const headDir = path.join(temporary, "head");
  fs.mkdirSync(headDir, { recursive: true });

  const fixturesFile = path.join(headDir, fixturesPath);
  fs.writeFileSync(
    fixturesFile,
    JSON.stringify({
      contracts: [
        {
          wasm_path: "contract.wasm",
          invocations: [{ function_name: "hello", args: [] }],
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(headDir, "contract.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));

  const outputFile = path.join(temporary, "output");
  const summaryFile = path.join(temporary, "summary");
  fs.writeFileSync(outputFile, "");
  fs.writeFileSync(summaryFile, "");

  const env = {
    ...process.env,
    TMPDIR: temporary,
    GITHUB_WORKSPACE: headDir,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    "INPUT_FIXTURES-PATH": fixturesPath,
    "INPUT_RPC-URL": rpcUrl,
    "INPUT_CONFIG-PATH": "",
    "INPUT_GITHUB-TOKEN": "",
    "INPUT_BASE-REF": "main",
    "INPUT_BUILD-COMMAND": buildCommandInput,
  };

  if (skipBuildInput !== null) {
    env["INPUT_SKIP-BUILD"] = skipBuildInput;
  } else {
    delete env["INPUT_SKIP-BUILD"];
  }

  const args = [];
  if (useHook) {
    args.push("--require", path.resolve(__dirname, "support/action-unit-hook.cjs"));
    env.WEIGHIN_UNIT_MODE = "control";
    env.WEIGHIN_UNIT_BASE = path.join(temporary, "base");
    fs.mkdirSync(env.WEIGHIN_UNIT_BASE, { recursive: true });
    fs.writeFileSync(path.join(env.WEIGHIN_UNIT_BASE, fixturesPath), fs.readFileSync(fixturesFile));
  }
  args.push(entryFile);

  try {
    const proc = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 10000,
      env,
    });

    const outputContent = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
    const summaryContent = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, "utf8") : "";

    // Check if any deployer key directories were created in temporary TMPDIR
    const createdKeyDirs = fs.readdirSync(temporary).filter((name) => name.startsWith("weighin-key-"));

    return {
      status: proc.status,
      stdout: proc.stdout,
      stderr: proc.stderr,
      output: outputContent,
      summary: summaryContent,
      keyDirs: createdKeyDirs,
      combinedOutput: `${proc.stdout}\n${proc.stderr}\n${outputContent}`,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

for (const entry of actionEntries) {
  test(`${entry.name} Action rejects non-boolean skip-build values early with actionable schema error and zero side effects`, () => {
    const invalidValues = ["yes", "no", "0", "1", "maybe", "flase", "ture", "ENABLED"];

    for (const val of invalidValues) {
      const res = runActionWithInputs({
        entryFile: entry.file,
        useHook: entry.useHook,
        skipBuildInput: val,
      });

      assert.equal(res.status, 1, `Expected status 1 for invalid value "${val}"`);
      assert.match(
        res.combinedOutput,
        /Input does not meet YAML 1\.2 "Core Schema" specification: skip-build/,
        `Expected YAML 1.2 boolean error for value "${val}"`,
      );
      assert.match(
        res.combinedOutput,
        /Support boolean input list: `true \| True \| TRUE \| false \| False \| FALSE`/,
        `Expected supported booleans list for value "${val}"`,
      );
      assert.match(res.output, /result<<[^\n]*\nfail/);
      assert.match(res.output, /diff-json<<[^\n]*\n{}/);

      // Verify side effect safety: no deployer key directory created
      assert.equal(
        res.keyDirs.length,
        0,
        `Expected no key directories created for rejected input "${val}", found: ${res.keyDirs.join(", ")}`,
      );
    }
  });

  test(`${entry.name} Action rejects conflicting build-command and skip-build before network or deployer operations`, () => {
    for (const validTrue of ["true", "True", "TRUE"]) {
      const res = runActionWithInputs({
        entryFile: entry.file,
        useHook: entry.useHook,
        skipBuildInput: validTrue,
        buildCommandInput: "echo conflict",
      });

      assert.equal(res.status, 1, `Expected status 1 for conflicting options with skip-build="${validTrue}"`);
      assert.match(
        res.combinedOutput,
        /build-command and skip-build cannot be used together/,
      );
      assert.match(res.output, /result<<[^\n]*\nfail/);
      assert.match(res.output, /diff-json<<[^\n]*\n{}/);

      // Verify side effect safety: no deployer key directory created
      assert.equal(
        res.keyDirs.length,
        0,
        `Expected no key directories created for conflicting input, found: ${res.keyDirs.join(", ")}`,
      );
    }
  });

  test(`${entry.name} Action accepts omitted skip-build and defaults to false (not rejecting)`, () => {
    const resOmitted = runActionWithInputs({
      entryFile: entry.file,
      useHook: entry.useHook,
      skipBuildInput: null,
    });

    // Should NOT fail on skip-build schema validation
    assert.doesNotMatch(
      resOmitted.combinedOutput,
      /YAML 1\.2 "Core Schema" specification: skip-build/,
    );

    const resEmpty = runActionWithInputs({
      entryFile: entry.file,
      useHook: entry.useHook,
      skipBuildInput: "",
    });

    assert.doesNotMatch(
      resEmpty.combinedOutput,
      /YAML 1\.2 "Core Schema" specification: skip-build/,
    );
  });

  test(`${entry.name} Action accepts all valid boolean spellings (true, True, TRUE, false, False, FALSE)`, () => {
    for (const validFalse of ["false", "False", "FALSE"]) {
      const res = runActionWithInputs({
        entryFile: entry.file,
        useHook: entry.useHook,
        skipBuildInput: validFalse,
      });

      assert.doesNotMatch(
        res.combinedOutput,
        /YAML 1\.2 "Core Schema" specification: skip-build/,
        `Should not reject valid false spelling "${validFalse}"`,
      );
    }

    for (const validTrue of ["true", "True", "TRUE"]) {
      const res = runActionWithInputs({
        entryFile: entry.file,
        useHook: entry.useHook,
        skipBuildInput: validTrue,
      });

      assert.doesNotMatch(
        res.combinedOutput,
        /YAML 1\.2 "Core Schema" specification: skip-build/,
        `Should not reject valid true spelling "${validTrue}"`,
      );
    }
  });
}
