import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const OWNED_DIR_PREFIX = "weighin-key-";
const OWNED_KEY_FILE_NAME = "deployer-key";

/**
 * A deployer key location plus the cleanup that goes with it.
 * `owned` is true only when the API created the location itself.
 */
export interface DeployerKeyLease {
  keyFile: string;
  owned: boolean;
  release(): Promise<void>;
}

/**
 * Resolve where the deployer key lives for one measurement run.
 *
 * - Caller supplied a key file: use it as-is. We never create or delete it.
 * - Otherwise: create a private temp directory that we own, and delete
 *   it in `release()`.
 */
export async function acquireDeployerKey(
  suppliedKeyFile?: string,
): Promise<DeployerKeyLease> {
  if (suppliedKeyFile) {
    return {
      keyFile: suppliedKeyFile,
      owned: false,
      release: async () => {},
    };
  }

  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), OWNED_DIR_PREFIX),
  );
  await fs.promises.chmod(dir, 0o700);

  return {
    keyFile: path.join(dir, OWNED_KEY_FILE_NAME),
    owned: true,
    release: () => fs.promises.rm(dir, { recursive: true, force: true }),
  };
}
