import * as exec from "@actions/exec";

/** Run a command and capture stdout. Throws on non-zero exit. */
export async function capture(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  let out = "";
  await exec.exec(cmd, args, {
    cwd,
    listeners: {
      stdout: (d: Buffer) => {
        out += d.toString();
      },
    },
    silent: true,
  });
  return out.trim();
}

/** Run a command and capture stdout without trimming. Throws on non-zero exit. */
export async function captureRaw(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  let out = "";
  await exec.exec(cmd, args, {
    cwd,
    silent: true,
    listeners: {
      stdout: (d: Buffer) => {
        out += d.toString();
      },
    },
  });
  return out;
}

/**
 * Parse `git status --porcelain` output into the changed tracked paths.
 *
 * Untracked entries are skipped: they are not part of the committed revision,
 * and the Action writes its own report and metadata files into the workspace,
 * so an untracked file must not be reported as a workspace change.
 *
 * The raw output is required for parsing: every entry carries a two-character
 * status column, so trimming the output would shift the column and report
 * every path one character short.
 */
function parseTrackedChanges(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("??"))
    .map((line) => {
      const path = line.slice(3).trim();
      // A rename is reported as "<old> -> <new>"; the new path is the file
      // that the workspace currently contains.
      const rename = path.indexOf(" -> ");
      return rename === -1 ? path : path.slice(rename + 4);
    });
}

/**
 * Check if git workspace is clean (no uncommitted changes to tracked files).
 *
 * A workspace that only contains untracked files is clean: those files are not
 * part of the committed revision the benchmark is compared against.
 */
export async function isWorkspaceClean(dir: string): Promise<boolean> {
  try {
    const status = await captureRaw(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      dir,
    );
    return parseTrackedChanges(status).length === 0;
  } catch {
    return false;
  }
}

/** Get list of modified tracked files in git workspace. */
export async function getModifiedFiles(dir: string): Promise<string[]> {
  try {
    const status = await captureRaw(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      dir,
    );
    return parseTrackedChanges(status);
  } catch {
    return [];
  }
}

/** Get HEAD SHA in the given directory. */
export async function getHeadSha(dir: string): Promise<string> {
  try {
    return await capture("git", ["rev-parse", "HEAD"], dir);
  } catch {
    return "unknown";
  }
}
