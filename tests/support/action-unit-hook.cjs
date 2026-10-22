// Orchestration unit tests only: IO dependencies return controlled results.
// Live measurement proof uses the separate experiments/action-local-hook.cjs.
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const load = Module._load;
const mode = process.env.WEIGHIN_UNIT_MODE;
const logDir = process.env.WEIGHIN_UNIT_LOG_DIR;
if (logDir) fs.mkdirSync(logDir, { recursive: true });
function logKeyPath(filePath, fixtureId) {
  if (!filePath || !logDir) return;
  const dir = path.dirname(filePath);
  const stats = fs.existsSync(dir) ? fs.statSync(dir) : null;
  const record = {
    filePath,
    fixtureId,
    dirPath: dir,
    dirMode: stats ? stats.mode & 0o777 : null,
    exists: fs.existsSync(filePath),
    mode: process.env.WEIGHIN_UNIT_MODE,
  };
  fs.appendFileSync(
    path.join(logDir, "key-paths.jsonl"),
    JSON.stringify(record) + "\n",
  );
}
globalThis.fetch = async (url, options) => {
  const request = options?.body ? JSON.parse(options.body) : null;
  const method = request?.method ?? "";
  if (mode === "funding-exhausted") {
    if (!method) return new Response("still warming", { status: 502 });
    if (method === "getLedgerEntries")
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { entries: [], latestLedger: 100 } }),
      );
  }
  const result =
    method === "getNetwork"
      ? {
          passphrase:
            mode === "rpc-wrong-passphrase"
              ? "Test SDF Network ; September 2015"
              : "Standalone Network ; February 2017",
          ...(mode === "rpc-missing-protocol"
            ? {}
            : { protocolVersion: mode === "rpc-wrong-protocol" ? 27 : 28 }),
        }
      : { status: mode === "rpc-unhealthy" ? "starting" : "healthy" };
  if (mode === "rpc-invalid-envelope" && method === "getHealth") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id + 1, result }));
  }
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request?.id,
      result,
    }),
  );
};
if (mode === "funding-exhausted") {
  let elapsed = 0;
  Date.now = () => elapsed;
  globalThis.setTimeout = (callback, delay, ...args) => {
    elapsed += delay;
    return setImmediate(callback, ...args);
  };
}

Module._load = function (name, parent, ...args) {
  if (
    parent?.filename.endsWith("/dist/action.js") ||
    parent?.filename.endsWith("/dist/build.js") ||
    parent?.filename.endsWith("/dist/git-utils.js")
  ) {
    if (name === "@actions/core" && parent?.filename.endsWith("/dist/action.js")) {
      const core = load.call(this, name, parent, ...args);
      if (mode === "summary-delivery-failure") {
        let failedFirstWrite = false;
        return new Proxy(core, {
          get(target, property, receiver) {
            if (property === "summary") {
              return {
                addRaw(content) {
                  target.summary.addRaw(content);
                  return {
                    async write() {
                      if (!failedFirstWrite) {
                        failedFirstWrite = true;
                        throw new Error("unit summary delivery failure");
                      }
                      return target.summary.write();
                    },
                  };
                },
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
      }
      return core;
    }
    if (name === "@actions/github") return { context: { payload: {} } };
    if (name === "@actions/exec")
      return {
        exec: async (command, argv, options = {}) => {
          if (command === "git" && argv[0] === "check-ref-format") {
            const result = spawnSync("git", argv, { encoding: "utf8" });
            return result.status ?? 1;
          }
          if (command === "git" && argv[0] === "status") {
            options.listeners?.stdout?.(Buffer.from(""));
            return 0;
          }
          const isBase = !(
            options.cwd === process.env.GITHUB_WORKSPACE ||
            options.cwd?.startsWith(process.env.GITHUB_WORKSPACE + path.sep)
          );
          if (command === "git" && argv[0] === "fetch" && mode === "checkout")
            throw new Error("unit checkout failure");
          if (command === "git" && argv[1] === "add") {
            if (mode === "worktree") throw new Error("unit worktree failure");
            fs.cpSync(process.env.WEIGHIN_UNIT_BASE, argv[3], {
              recursive: true,
            });
          }
          if (command === "git" && argv[1] === "remove")
            fs.rmSync(argv.at(-1), { recursive: true, force: true });
          if (command === "stellar" && argv[0] === "contract") {
            if (logDir)
              fs.appendFileSync(
                path.join(logDir, "builds.jsonl"),
                `${JSON.stringify({ revision: isBase ? "BASE" : "HEAD", cwd: options.cwd })}\n`,
              );
            if (isBase && mode === "build")
              throw new Error("unit base build failure");
            fs.writeFileSync(
              path.join(argv[argv.indexOf("--out-dir") + 1], "contract.wasm"),
              Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
            );
          }
          const stdout =
            command === "rustc"
              ? "rustc 1.95.0"
              : command === "stellar"
                ? "stellar 28.1.0"
                : command === "cargo"
                  ? JSON.stringify({
                      workspace_members: ["unit"],
                      packages: [
                        {
                          id: "unit",
                          name: "contract",
                          manifest_path: path.join(options.cwd, "Cargo.toml"),
                          targets: [{ crate_types: ["cdylib"] }],
                        },
                      ],
                    })
                  : "unit-sha";
          options.listeners?.stdout?.(Buffer.from(stdout));
          return 0;
        },
      };
    if (name === "./measurement" && mode !== "funding-exhausted")
      return {
        runMeasurement: async (options) => {
          logKeyPath(options.keyFile, options.fixtureId);
          const isBase = !options.fixturesPath.startsWith(
            process.env.GITHUB_WORKSPACE + path.sep,
          );
          if (isBase && mode === "measurement")
            throw new Error("unit base measurement failure");
          if (!isBase && mode === "head-measurement")
            throw new Error("unit HEAD measurement failure");
          const result = JSON.parse(
            fs.readFileSync(
              path.resolve(
                __dirname,
                "../../docs/experiments/native-integration/base.json",
              ),
            ),
          );
          if (!isBase && mode === "regression")
            result[0].benchmarks[0].metrics.cpu_instructions.consumed += 100;
          if (isBase && mode === "schema") result[0].schema_version = 999;
          if (isBase && mode === "provenance")
            result[0].benchmarks[0].provenance = {};
          if (isBase && mode === "empty") return [];
          if (isBase && mode === "unmatched")
            result[0].logical_id = "id:unrelated";
          return result;
        },
      };
  }
  return load.call(this, name, parent, ...args);
};
