import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The report writer is exercised through controlled filesystem failures. The
// mock delegates to the real filesystem, so only the injected failure differs
// from a normal write.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const mocked = {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    closeSync: vi.fn(actual.closeSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
  return { ...mocked, default: mocked };
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeReportFile } from "../src/report";

const actualFs = await vi.importActual<typeof import("fs")>("fs");

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** Temporary report paths handed to `openSync` during the current test. */
function temporaryPaths(): string[] {
  return vi
    .mocked(fs.openSync)
    .mock.calls.map((call) => String(call[0]))
    .filter((candidate) => candidate.endsWith(".tmp"));
}

/**
 * Emulate a write that fails after the destination was already truncated.
 *
 * A direct write to the final report destroys the previous report in this
 * situation; a write through a temporary file only damages the temporary file.
 */
function failAfterPartialWrite(code = "ENOSPC"): void {
  vi.mocked(fs.writeFileSync).mockImplementationOnce((target: any) => {
    actualFs.writeFileSync(target, "# Partial report\n");
    throw errno(code, "no space left on device");
  });
}

describe("writeReportFile atomic delivery", () => {
  let tempDir: string;
  let reportPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-atomic-test-"));
    reportPath = path.join(tempDir, "report.md");
  });

  afterEach(() => {
    vi.resetAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("publishes the report through a temporary file in the destination directory", () => {
    writeReportFile("report.md", tempDir, "# WeighIn Report\n");

    const writes = vi.mocked(fs.writeFileSync).mock.calls;
    expect(writes).toHaveLength(1);
    // The report body is written to a file descriptor, never to the final path.
    expect(typeof writes[0][0]).toBe("number");

    const temporaries = temporaryPaths();
    expect(temporaries).toHaveLength(1);
    expect(path.dirname(temporaries[0])).toBe(tempDir);
    expect(temporaries[0]).not.toBe(reportPath);

    const renames = vi.mocked(fs.renameSync).mock.calls;
    expect(renames).toHaveLength(1);
    expect(renames[0][0]).toBe(temporaries[0]);
    expect(renames[0][1]).toBe(reportPath);

    expect(fs.readFileSync(reportPath, "utf8")).toBe("# WeighIn Report\n");
  });

  it("closes the temporary file handle before the rename", () => {
    writeReportFile("report.md", tempDir, "# WeighIn Report\n");

    const closed = vi.mocked(fs.closeSync).mock.invocationCallOrder[0];
    const renamed = vi.mocked(fs.renameSync).mock.invocationCallOrder[0];
    expect(closed).toBeLessThan(renamed);
  });

  it("leaves an existing report unchanged when the write fails", () => {
    fs.writeFileSync(reportPath, "# Previous report\n");
    failAfterPartialWrite();

    expect(() =>
      writeReportFile("report.md", tempDir, "# New report\n"),
    ).toThrow(/Failed to write WeighIn report to .*report\.md: ENOSPC/);

    expect(fs.readFileSync(reportPath, "utf8")).toBe("# Previous report\n");
  });

  it("does not destroy the previous report when the rename fails", () => {
    fs.writeFileSync(reportPath, "# Previous report\n");
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw errno("EXDEV", "cross-device link not permitted");
    });

    expect(() =>
      writeReportFile("report.md", tempDir, "# New report\n"),
    ).toThrow(/Failed to write WeighIn report to .*report\.md: EXDEV/);

    expect(fs.readFileSync(reportPath, "utf8")).toBe("# Previous report\n");
  });

  it("removes its own temporary file after a failure", () => {
    fs.writeFileSync(reportPath, "# Previous report\n");
    failAfterPartialWrite();

    expect(() =>
      writeReportFile("report.md", tempDir, "# New report\n"),
    ).toThrow(/ENOSPC/);

    const temporaries = temporaryPaths();
    expect(temporaries).toHaveLength(1);
    expect(fs.existsSync(temporaries[0])).toBe(false);
    expect(fs.existsSync(reportPath)).toBe(true);
  });

  it("does not remove another writer's temporary file", () => {
    const foreignTemporary = path.join(tempDir, ".report.md.other-writer.tmp");
    fs.writeFileSync(foreignTemporary, "another writer's temporary file");
    failAfterPartialWrite();

    expect(() =>
      writeReportFile("report.md", tempDir, "# New report\n"),
    ).toThrow(/ENOSPC/);

    expect(fs.existsSync(foreignTemporary)).toBe(true);
    expect(fs.readFileSync(foreignTemporary, "utf8")).toBe(
      "another writer's temporary file",
    );
  });

  it("keeps the original write error when the cleanup also fails", () => {
    fs.writeFileSync(reportPath, "# Previous report\n");
    failAfterPartialWrite();
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw errno("EACCES", "permission denied");
    });

    expect(() =>
      writeReportFile("report.md", tempDir, "# New report\n"),
    ).toThrow(/Failed to write WeighIn report to .*report\.md: ENOSPC/);

    expect(fs.readFileSync(reportPath, "utf8")).toBe("# Previous report\n");
  });

  it("does not leave a partial report when the write fails without a previous report", () => {
    failAfterPartialWrite();

    expect(() =>
      writeReportFile("report.md", tempDir, "# Partial report\n"),
    ).toThrow(/ENOSPC/);

    expect(fs.existsSync(reportPath)).toBe(false);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it("uses distinct temporary files for concurrent writers", () => {
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      // A second writer publishes while the first writer still owns a
      // temporary file, so both writers are in flight at the same time.
      writeReportFile("report.md", tempDir, "# Concurrent report\n");
      throw errno("ENOSPC", "no space left on device");
    });

    expect(() =>
      writeReportFile("report.md", tempDir, "# Failing report\n"),
    ).toThrow(/ENOSPC/);

    const temporaries = temporaryPaths();
    expect(temporaries).toHaveLength(2);
    expect(new Set(temporaries).size).toBe(2);
    expect(temporaries.every((entry) => path.dirname(entry) === tempDir)).toBe(
      true,
    );
    // The failing writer never published its body over the concurrent report.
    expect(fs.readFileSync(reportPath, "utf8")).toBe("# Concurrent report\n");
  });

  it("fails predictably when the destination directory cannot be used", () => {
    const blocker = path.join(tempDir, "blocker");
    fs.writeFileSync(blocker, "unrelated content");

    expect(() =>
      writeReportFile("blocker/report.md", tempDir, "# New report\n"),
    ).toThrow(/Failed to write WeighIn report to .*blocker[/\\]report\.md/);

    expect(fs.readFileSync(blocker, "utf8")).toBe("unrelated content");
    expect(fs.existsSync(path.join(tempDir, "blocker", "report.md"))).toBe(
      false,
    );
  });
});
