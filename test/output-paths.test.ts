import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assertDistinctOutputPaths } from "../src/output-paths";

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-paths-"));
  fs.writeFileSync(path.join(ws, "fixtures.json"), "{}");
  fs.writeFileSync(path.join(ws, "weighin.toml"), "");
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

function check(report: string, metadata: string): void {
  assertDistinctOutputPaths({
    workspace: ws,
    outputs: { "report-path": report, "metadata-path": metadata },
    inputs: {
      "fixtures-path": path.join(ws, "fixtures.json"),
      "config-path": "weighin.toml",
    },
  });
}

describe("assertDistinctOutputPaths", () => {
  it("accepts separate nested outputs that do not exist yet", () => {
    expect(() => check("out/report/r.md", "out/meta/m.json")).not.toThrow();
  });

  it("accepts omitted outputs", () => {
    expect(() => check("", "")).not.toThrow();
    expect(() => check("r.md", "")).not.toThrow();
  });

  it("rejects report and metadata with the same path", () => {
    expect(() => check("same.out", "same.out")).toThrow(/same path/);
  });

  it("rejects equivalent spellings of the same path", () => {
    expect(() => check("out/r.md", "out/../out/./r.md")).toThrow(/same path/);
  });

  it("rejects report colliding with the fixtures file", () => {
    expect(() => check("fixtures.json", "m.json")).toThrow(/same path/);
  });

  it("rejects metadata colliding with the config file", () => {
    expect(() => check("r.md", "weighin.toml")).toThrow(/same path/);
  });

  it("rejects one output nested under the other", () => {
    expect(() => check("out", "out/meta.json")).toThrow(/same path/);
  });

  it("rejects an output that is a symlink to an input", () => {
    fs.symlinkSync(path.join(ws, "fixtures.json"), path.join(ws, "link.md"));
    expect(() => check("link.md", "m.json")).toThrow(/symbolic link/);
  });

  it("rejects a dangling symlink output", () => {
    fs.symlinkSync(path.join(ws, "nowhere"), path.join(ws, "dangling.md"));
    expect(() => check("dangling.md", "m.json")).toThrow(/symbolic link/);
  });

  it("rejects an output reached through a symlinked parent directory", () => {
    fs.symlinkSync(ws, path.join(ws, "linkdir"));
    expect(() => check("linkdir/fixtures.json", "m.json")).toThrow(/same path/);
  });

  it("rejects a hardlink to an input", () => {
    fs.linkSync(path.join(ws, "fixtures.json"), path.join(ws, "hard.md"));
    expect(() => check("hard.md", "m.json")).toThrow(/same path/);
  });

  it("never modifies the colliding input", () => {
    const before = fs.readFileSync(path.join(ws, "fixtures.json"), "utf8");
    expect(() => check("fixtures.json", "m.json")).toThrow();
    expect(fs.readFileSync(path.join(ws, "fixtures.json"), "utf8")).toBe(
      before,
    );
  });
});

describe("assertDistinctOutputPaths with a blocked parent", () => {
  it("lets the original write error surface when a parent is a file", () => {
    fs.writeFileSync(path.join(ws, "blocked"), "x");
    expect(() => check("blocked/report.md", "m.json")).not.toThrow();
  });
});
