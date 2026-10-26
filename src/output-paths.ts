import * as fs from "fs";
import * as path from "path";

function realTarget(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail.reverse());
    } catch (e: any) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

const fold = (p: string) =>
  process.platform === "win32" || process.platform === "darwin"
    ? p.toLowerCase()
    : p;

function sameInode(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino !== 0 && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

export interface OutputPathCheck {
  workspace: string;
  outputs: Record<string, string>;
  inputs: Record<string, string>;
}

export function assertDistinctOutputPaths(check: OutputPathCheck): void {
  const entry = (label: string, raw: string, output: boolean) => {
    const abs = path.resolve(check.workspace, raw);
    return { label, abs, output, real: fold(realTarget(abs)) };
  };
  const all = [
    ...Object.entries(check.outputs)
      .filter(([, v]) => v)
      .map(([k, v]) => entry(k, v, true)),
    ...Object.entries(check.inputs)
      .filter(([, v]) => v)
      .map(([k, v]) => entry(k, v, false)),
  ];
  for (const e of all.filter((x) => x.output)) {
    try {
      if (fs.lstatSync(e.abs).isSymbolicLink())
        throw new Error(`${e.label} must not be a symbolic link`);
    } catch (err: any) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    }
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (!a.output && !b.output) continue;
      if (
        a.real === b.real ||
        a.real.startsWith(b.real + path.sep) ||
        b.real.startsWith(a.real + path.sep) ||
        sameInode(a.abs, b.abs)
      ) {
        throw new Error(
          `${a.label} and ${b.label} must not resolve to the same path`,
        );
      }
    }
  }
}
