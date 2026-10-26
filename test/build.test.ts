import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as exec from "@actions/exec";
import { buildContracts } from "../src/build";
import {
  buildForRevision,
  parseOptionalBooleanInput,
} from "../src/build-selection";

vi.mock("@actions/exec");
vi.mock("../src/build", () => ({
  buildContracts: vi.fn().mockResolvedValue([]),
}));

describe("build selection", () => {
  beforeEach(() => vi.resetAllMocks());

  it("uses the modern Stellar builder by default", async () => {
    await buildForRevision(
      "/workspace/fixtures.json",
      "/workspace",
      "1.95.0",
      "",
      false,
    );
    expect(buildContracts).toHaveBeenCalledWith(
      "/workspace/fixtures.json",
      "/workspace",
      "1.95.0",
    );
  });

  it("runs the configured custom command in each revision's worktree", async () => {
    vi.mocked(exec.exec).mockResolvedValue(0);
    await buildForRevision(
      "fixtures.json",
      "/base",
      "1.95.0",
      "make contract",
      false,
    );
    expect(exec.exec).toHaveBeenCalledWith(
      "sh",
      ["-c", "make contract"],
      expect.objectContaining({ cwd: "/base" }),
    );
  });

  it("uses configured prebuilt WASM when build is skipped", async () => {
    await buildForRevision("fixtures.json", "/workspace", "1.95.0", "", true);
    expect(exec.exec).not.toHaveBeenCalled();
    expect(buildContracts).not.toHaveBeenCalled();
  });

  it("rejects ambiguous build configuration", async () => {
    await expect(
      buildForRevision("fixtures.json", "/workspace", "", "make", true),
    ).rejects.toThrow(/cannot be used together/);
  });

  it("makes custom command failures explicit", async () => {
    vi.mocked(exec.exec).mockRejectedValue(new Error("exit code 2"));
    await expect(
      buildForRevision("fixtures.json", "/head", "", "make fail", false),
    ).rejects.toThrow(/Custom build command failed: exit code 2/);
  });
});

describe("parseOptionalBooleanInput", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns default when input is omitted or empty", () => {
    delete process.env["INPUT_SKIP-BUILD"];
    expect(parseOptionalBooleanInput("skip-build", false)).toBe(false);
    expect(parseOptionalBooleanInput("skip-build", true)).toBe(true);

    process.env["INPUT_SKIP-BUILD"] = "";
    expect(parseOptionalBooleanInput("skip-build", false)).toBe(false);

    process.env["INPUT_SKIP-BUILD"] = "   ";
    expect(parseOptionalBooleanInput("skip-build", false)).toBe(false);
  });

  it("accepts all documented YAML 1.2 true boolean spellings", () => {
    for (const val of ["true", "True", "TRUE"]) {
      process.env["INPUT_SKIP-BUILD"] = val;
      expect(parseOptionalBooleanInput("skip-build", false)).toBe(true);
    }
  });

  it("accepts all documented YAML 1.2 false boolean spellings", () => {
    for (const val of ["false", "False", "FALSE"]) {
      process.env["INPUT_SKIP-BUILD"] = val;
      expect(parseOptionalBooleanInput("skip-build", true)).toBe(false);
    }
  });

  it("rejects non-boolean spellings and misspellings with actionable schema error", () => {
    for (const val of [
      "yes",
      "no",
      "0",
      "1",
      "on",
      "off",
      "maybe",
      "flase",
      "ture",
    ]) {
      process.env["INPUT_SKIP-BUILD"] = val;
      expect(() => parseOptionalBooleanInput("skip-build", false)).toThrow(
        /YAML 1\.2 "Core Schema" specification: skip-build/,
      );
    }
  });
});
