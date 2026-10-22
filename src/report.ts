import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as core from "@actions/core";

/**
 * Bounded number of attempts to allocate an exclusively created temporary
 * report file.
 *
 * The temporary name already carries a random component, so a collision is
 * practically impossible. The bounded loop only guarantees that a name clash
 * (for example a pre-created file with the same name) cannot fail the write
 * on its own.
 */
const TEMPORARY_FILE_ATTEMPTS = 5;

/** A temporary file this write operation created and therefore owns. */
interface OwnedTemporaryFile {
  path: string;
  fd: number;
}

/**
 * Build a unique temporary path in the destination directory.
 *
 * The temporary file has to live in the same directory as the final report so
 * that the replacement is a same-filesystem rename.
 */
function temporaryReportPath(targetPath: string): string {
  const unique = `${process.pid.toString(36)}-${crypto
    .randomBytes(8)
    .toString("hex")}`;
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${unique}.tmp`,
  );
}

/**
 * Create the temporary file used for this write operation.
 *
 * `wx` maps to `O_CREAT | O_EXCL | O_WRONLY`, so creation is exclusive: the
 * returned path cannot belong to another writer. A failed exclusive creation
 * leaves nothing behind and never removes a file owned by somebody else.
 */
function createOwnedTemporaryFile(targetPath: string): OwnedTemporaryFile {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEMPORARY_FILE_ATTEMPTS; attempt++) {
    const candidate = temporaryReportPath(targetPath);
    try {
      const fd = fs.openSync(candidate, "wx", 0o666);
      return { path: candidate, fd };
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  throw lastError;
}

/**
 * Remove the temporary file this operation created.
 *
 * Cleanup failures are reported but never mask the original write or rename
 * error, and only the path this operation created is touched.
 */
function removeOwnedTemporaryFile(temporaryPath: string): void {
  try {
    fs.unlinkSync(temporaryPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    core.warning(
      `Could not remove temporary report file ${temporaryPath}: ${error.message}`,
    );
  }
}

/**
 * Write `body` to `targetPath` atomically.
 *
 * The complete content is written to an exclusively created temporary file in
 * the destination directory and renamed over the target only after the write
 * succeeded. A failed or interrupted write therefore leaves an already
 * published report intact instead of truncating it, and never leaves a partial
 * report behind.
 */
function writeFileAtomically(targetPath: string, body: string): void {
  const temporary = createOwnedTemporaryFile(targetPath);
  let closed = false;
  try {
    fs.writeFileSync(temporary.fd, body, "utf8");
    // The handle is closed before the rename so the replacement also works on
    // platforms that refuse to rename over an open file.
    fs.closeSync(temporary.fd);
    closed = true;
    fs.renameSync(temporary.path, targetPath);
  } catch (error) {
    if (!closed) {
      try {
        fs.closeSync(temporary.fd);
      } catch {
        // The handle is already unusable; the original error is reported.
      }
    }
    removeOwnedTemporaryFile(temporary.path);
    throw error;
  }
}

export function writeReportFile(
  reportPathInput: string,
  headWorkspace: string,
  body: string,
): void {
  if (!reportPathInput) return;
  const targetPath = path.resolve(headWorkspace, reportPathInput);
  try {
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    writeFileAtomically(targetPath, body);
    core.info(`Wrote Markdown report to ${targetPath}`);
  } catch (err: any) {
    throw new Error(
      `Failed to write WeighIn report to ${targetPath}: ${err.message}`,
    );
  }
}

export function generateFailureReport(errorMessage: string): string {
  return [
    "# WeighIn Resource Benchmark: Unsuccessful Comparison",
    "",
    "> **Status: FAILED** — A comparison or policy result could not be established due to an execution failure.",
    "",
    "## Failure Details",
    "",
    "```",
    errorMessage,
    "```",
    "",
    "## Policy Result",
    "",
    "- **Policies established:** No",
    "- **Thresholds evaluated:** None",
    "- **Benchmark metrics:** None (not measured)",
    "",
    "No passing comparison, deltas, or resource consumption metrics were established.",
    "",
  ].join("\n");
}
