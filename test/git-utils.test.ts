import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as exec from "@actions/exec";
import {
  isWorkspaceClean,
  getModifiedFiles,
  getHeadSha,
  capture,
  captureRaw,
} from "../src/git-utils";

vi.mock("@actions/exec");

describe("git-utils", () => {
  beforeEach(() => vi.resetAllMocks());

  describe("capture", () => {
    it("returns command stdout", async () => {
      vi.mocked(exec.exec).mockImplementation(async (cmd, args, options) => {
        const listeners = options?.listeners as any;
        if (listeners?.stdout) {
          listeners.stdout(Buffer.from("test output\n"));
        }
        return 0;
      });

      const result = await capture("git", ["status"]);
      expect(result).toBe("test output");
    });

    it("throws on non-zero exit", async () => {
      vi.mocked(exec.exec).mockRejectedValue(new Error("exit code 1"));

      await expect(capture("git", ["status"])).rejects.toThrow("exit code 1");
    });
  });

  describe("captureRaw", () => {
    it("returns command stdout without trimming", async () => {
      vi.mocked(exec.exec).mockImplementation(async (cmd, args, options) => {
        const listeners = options?.listeners as any;
        if (listeners?.stdout) {
          listeners.stdout(Buffer.from("test output\n"));
        }
        return 0;
      });

      const result = await captureRaw("git", ["show"]);
      expect(result).toBe("test output\n");
    });
  });

  describe("isWorkspaceClean", () => {
    it("returns true when git status is empty", async () => {
      vi.mocked(exec.exec).mockImplementation(async (cmd, args, options) => {
        if (args[0] === "status") {
          const listeners = options?.listeners as any;
          if (listeners?.stdout) {
            listeners.stdout(Buffer.from(""));
          }
          return 0;
        }
        return 0;
      });

      const result = await isWorkspaceClean("/test");
      expect(result).toBe(true);
    });

    it("returns false when git status shows modifications", async () => {
      vi.mocked(exec.exec).mockImplementation(async (cmd, args, options) => {
        if (args[0] === "status") {
          const listeners = options?.listeners as any;
          if (listeners?.stdout) {
            listeners.stdout(Buffer.from("M  src/contract.rs\n"));
          }
          return 0;
        }
        return 0;
      });

      const result = await isWorkspaceClean("/test");
      expect(result).toBe(false);
    });

    it("returns false when git command fails", async () => {
      vi.mocked(exec.exec).mockRejectedValue(new Error("git not found"));

      const result = await isWorkspaceClean("/test");
      expect(result).toBe(false);
    });
  });

  describe("getModifiedFiles", () => {
    it("returns empty array when git status is empty", async () => {
      vi.mocked(exec.exec).mockImplementation(async (cmd, args, options) => {
        if (args[0] === "status") {
          const listeners = options?.listeners as any;
          if (listeners?.stdout) {
            listeners.stdout(Buffer.from(""));
          }
          return 0;
        }
        return 0;
      });

      const result = await getModifiedFiles("/test");
      expect(result).toEqual([]);
    });

    it("returns list of modified files", async () => {
      vi.mocked(exec.exec).mockImplementation(async (cmd, args, options) => {
        if (args[0] === "status") {
          const listeners = options?.listeners as any;
          if (listeners?.stdout) {
            listeners.stdout(
              Buffer.from("M  src/contract.rs\nA  new.txt\n?? untracked.txt\n"),
            );
          }
          return 0;
        }
        return 0;
      });

      const result = await getModifiedFiles("/test");
      expect(result).toEqual(["src/contract.rs", "new.txt"]);
    });

    it("does not report untracked files", async () => {
      vi.mocked(exec.exec).mockImplementation(async (cmd, args, options) => {
        if (args[0] === "status") {
          const listeners = options?.listeners as any;
          if (listeners?.stdout) {
            listeners.stdout(Buffer.from("?? weighin-report.md\n"));
          }
          return 0;
        }
        return 0;
      });

      expect(await getModifiedFiles("/test")).toEqual([]);
      expect(await isWorkspaceClean("/test")).toBe(true);
    });

    it("keeps the full path of unstaged modifications", async () => {
      vi.mocked(exec.exec).mockImplementation(async (cmd, args, options) => {
        if (args[0] === "status") {
          const listeners = options?.listeners as any;
          if (listeners?.stdout) {
            listeners.stdout(Buffer.from(" M contract/src/lib.rs\n"));
          }
          return 0;
        }
        return 0;
      });

      const result = await getModifiedFiles("/test");
      expect(result).toEqual(["contract/src/lib.rs"]);
    });

    it("reports the new path of a renamed file", async () => {
      vi.mocked(exec.exec).mockImplementation(async (cmd, args, options) => {
        if (args[0] === "status") {
          const listeners = options?.listeners as any;
          if (listeners?.stdout) {
            listeners.stdout(Buffer.from("R  old.rs -> new.rs\n"));
          }
          return 0;
        }
        return 0;
      });

      const result = await getModifiedFiles("/test");
      expect(result).toEqual(["new.rs"]);
    });

    it("returns empty array when git command fails", async () => {
      vi.mocked(exec.exec).mockRejectedValue(new Error("git not found"));

      const result = await getModifiedFiles("/test");
      expect(result).toEqual([]);
    });
  });

  describe("getHeadSha", () => {
    it("returns HEAD SHA", async () => {
      vi.mocked(exec.exec).mockImplementation(async (cmd, args, options) => {
        if (args[0] === "rev-parse") {
          const listeners = options?.listeners as any;
          if (listeners?.stdout) {
            listeners.stdout(Buffer.from("abc123def456\n"));
          }
          return 0;
        }
        return 0;
      });

      const result = await getHeadSha("/test");
      expect(result).toBe("abc123def456");
    });

    it("returns 'unknown' when git command fails", async () => {
      vi.mocked(exec.exec).mockRejectedValue(new Error("git not found"));

      const result = await getHeadSha("/test");
      expect(result).toBe("unknown");
    });
  });
});
