import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { acquireDeployerKey } from "../src/deployer-key";

describe("acquireDeployerKey", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "weighin-key-test-"));
    vi.stubEnv("TMPDIR", sandbox);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns a supplied key file untouched and does not own it", async () => {
    const supplied = path.join(sandbox, "shared-key");
    fs.writeFileSync(supplied, "SECRET", { mode: 0o600 });

    const lease = await acquireDeployerKey(supplied);
    expect(lease.keyFile).toBe(supplied);
    expect(lease.owned).toBe(false);

    await lease.release();
    expect(fs.readFileSync(supplied, "utf8")).toBe("SECRET");
  });

  it("creates nothing when a key file is supplied", async () => {
    const supplied = path.join(sandbox, "not-yet-created");

    const lease = await acquireDeployerKey(supplied);
    await lease.release();

    expect(fs.existsSync(supplied)).toBe(false);
    expect(fs.readdirSync(sandbox)).toEqual([]);
  });

  it("creates a private temp directory when no key file is supplied", async () => {
    const lease = await acquireDeployerKey();
    const dir = path.dirname(lease.keyFile);

    expect(lease.owned).toBe(true);
    expect(path.dirname(dir)).toBe(sandbox);
    if (process.platform !== "win32") {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }

    await lease.release();
  });

  it("release deletes the owned directory and any key written in it", async () => {
    const lease = await acquireDeployerKey();
    fs.writeFileSync(lease.keyFile, "SECRET", { mode: 0o600 });

    await lease.release();

    expect(fs.readdirSync(sandbox)).toEqual([]);
  });

  it("release is safe to call twice", async () => {
    const lease = await acquireDeployerKey();
    await lease.release();
    await expect(lease.release()).resolves.toBeUndefined();
  });
});
