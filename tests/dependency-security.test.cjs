const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

test("committed CycloneDX inventory matches the current locked inputs", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(root, "dist/dependency-inventory.js"), "--check"],
    { cwd: root, encoding: "utf8" },
  );
  assert.match(output, /Dependency inventory verified/);
});

test("a clean packed consumer receives the inventory, bundles, native locks, and loadable API", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-packed-consumer-"));
  try {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
        { cwd: root, encoding: "utf8" },
      ),
    )[0];
    const packagedPaths = new Set(packed.files.map(({ path: filePath }) => filePath));
    for (const filePath of [
      "docs/dependency-inventory.json",
      "docs/DEPENDENCY_SECURITY.md",
      "bundled/index.js",
      "bundled/comment-action.js",
      "native/simulation/Cargo.toml",
      "native/simulation/Cargo.lock",
    ]) {
      assert.ok(packagedPaths.has(filePath), `missing packed file ${filePath}`);
    }

    const consumer = path.join(temporary, "consumer");
    const tarball = path.join(temporary, packed.filename);
    // The consumer install prefers the npm cache but may fall back to the
    // registry: a cold CI cache holds the locked tarballs but not the
    // registry metadata npm resolves version ranges from.
    execFileSync(
      "npm",
      [
        "install",
        "--prefer-offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        consumer,
        tarball,
      ],
      { cwd: temporary, stdio: "pipe" },
    );
    execFileSync(process.execPath, ["-e", "require('weighin')"], {
      cwd: consumer,
      stdio: "pipe",
    });
    const installedInventory = JSON.parse(
      fs.readFileSync(
        path.join(consumer, "node_modules/weighin/docs/dependency-inventory.json"),
        "utf8",
      ),
    );
    const sourceInventory = JSON.parse(
      fs.readFileSync(path.join(root, "docs/dependency-inventory.json"), "utf8"),
    );
    assert.deepEqual(installedInventory, sourceInventory);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
