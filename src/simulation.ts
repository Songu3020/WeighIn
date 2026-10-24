import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  parseJsonRpcResponse,
  redactEndpointSecrets,
  sanitizeEndpoint,
} from "./endpoint";
import { execFile } from "child_process";
import { Keypair, Transaction, xdr } from "@stellar/stellar-sdk";
import { z } from "zod";
import { SUPPORTED_PROTOCOL_VERSION } from "./network";

export const sha256 = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value).digest("hex");
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const encoded = z.string().min(1);
const outputSchema = z
  .object({
    schema_version: z.literal(1),
    source: z.literal("soroban-simulation"),
    source_version: z.literal("28.0.1"),
    protocol: z.literal(28),
    host_features: z.tuple([
      z.literal("recording_mode"),
      z.literal("testutils"),
    ]),
    auth_mode: z.literal("recording(true,true)"),
    cpu_instructions_consumed: integer,
    memory_bytes_consumed: integer,
    cpu_limit: integer.positive(),
    memory_limit: integer.positive(),
    instruction_budget: integer,
    disk_read_bytes: integer,
    write_bytes: integer,
    read_only_keys: z.array(encoded),
    read_write_keys: z.array(encoded),
    retval_xdr: encoded,
    transaction_data_xdr: encoded,
    contract_events_xdr: z.array(encoded),
    modified_entries: integer,
  })
  .strict();
export type SimulationOutput = z.infer<typeof outputSchema>;
export interface SnapshotEntry {
  key: string;
  xdr: string | null;
  extension_xdr?: string;
  last_modified?: number;
  live_until?: number | null;
}
export interface SimulationInput {
  schema_version: 1;
  header_xdr: string;
  network_passphrase: string;
  host_function_xdr: string;
  source_account_xdr: string;
  entries: SnapshotEntry[];
  instruction_leeway: number;
  seed: number[];
}
export interface ComputeProvenance {
  source: "soroban-simulation";
  source_version: "28.0.1";
  protocol: 28;
  helper_sha256: string;
  network_id: string;
  ledger: number;
  header_sha256: string;
  snapshot_sha256: string;
  config_sha256: string;
  compute_config_sha256: string;
  input_sha256: string;
  seed: number[];
  auth_mode: string;
  host_features: string[];
  /** Public key of the account that invoked the measured transaction.
   *  Absent only in records produced before source-account identity was
   *  recorded; comparisons require both sides to agree on it.
   */
  source_account?: string;
  /** Schema 4: audited resource caps only, excluding fee settings and metadata. */
  resource_limits_sha256?: string;
}

export interface ResourceLimits {
  cpu_instructions: number;
  memory_bytes: number;
  footprint_entries: number;
  disk_read_bytes: number;
  write_entries: number;
  write_bytes: number;
  events_and_return_bytes: number;
}

function sameXdr(
  left: { toXDR(format: "raw"): Buffer } | Buffer | string,
  right: { toXDR(format: "raw"): Buffer } | Buffer | string,
): boolean {
  const bytes = (value: { toXDR(format: "raw"): Buffer } | Buffer | string) =>
    typeof value === "string"
      ? Buffer.from(value)
      : Buffer.isBuffer(value)
        ? value
        : value.toXDR("raw");
  return bytes(left).equals(bytes(right));
}

/**
 * Validates uniqueness within read-only and read-write footprint keys and ensures
 * they are disjoint sets (#121). Rejects malformed footprints before counting resources.
 */
export function validateFootprintKeys(
  readOnlyKeys: string[],
  readWriteKeys: string[],
  sourceLabel: string = "footprint",
): void {
  const seenReadOnly = new Set<string>();
  const duplicateReadOnly = new Set<string>();
  for (const key of readOnlyKeys) {
    if (seenReadOnly.has(key)) {
      duplicateReadOnly.add(key);
    }
    seenReadOnly.add(key);
  }
  if (duplicateReadOnly.size > 0) {
    throw new Error(
      `Invalid ${sourceLabel}: duplicate key(s) in read-only footprint: [${[...duplicateReadOnly].join(", ")}]`,
    );
  }

  const seenReadWrite = new Set<string>();
  const duplicateReadWrite = new Set<string>();
  for (const key of readWriteKeys) {
    if (seenReadWrite.has(key)) {
      duplicateReadWrite.add(key);
    }
    seenReadWrite.add(key);
  }
  if (duplicateReadWrite.size > 0) {
    throw new Error(
      `Invalid ${sourceLabel}: duplicate key(s) in read-write footprint: [${[...duplicateReadWrite].join(", ")}]`,
    );
  }

  const overlaps: string[] = [];
  for (const key of seenReadWrite) {
    if (seenReadOnly.has(key)) {
      overlaps.push(key);
    }
  }
  if (overlaps.length > 0) {
    throw new Error(
      `Invalid ${sourceLabel}: key(s) present in both read-only and read-write footprints: [${overlaps.join(", ")}]`,
    );
  }
}

/**
 * Validates the cryptographic hash of a ledger-history header against canonical decoded header bytes (#122).
 * Verifies that the history-entry hash matches SHA-256 of header.toXDR(), and matches
 * the optional RPC response row hash if present.
 */
export function validateLedgerHeaderHash(
  historyEntry: xdr.LedgerHeaderHistoryEntry,
  rowHash?: string,
): { recomputedHash: string; historyHash: string } {
  const headerBytes = historyEntry.header().toXDR();
  const recomputedHash = crypto
    .createHash("sha256")
    .update(headerBytes)
    .digest("hex");
  const historyHash = historyEntry.hash().toString("hex");

  if (historyHash !== recomputedHash) {
    throw new Error(
      `Ledger header hash mismatch: history-entry hash (${historyHash}) does not match SHA-256 of decoded header bytes (${recomputedHash})`,
    );
  }

  if (rowHash && rowHash.toLowerCase() !== recomputedHash.toLowerCase()) {
    throw new Error(
      `Ledger header hash mismatch: RPC response hash (${rowHash}) does not match SHA-256 of decoded header bytes (${recomputedHash})`,
    );
  }

  return { recomputedHash, historyHash };
}

/**
 * Verify that a captured LedgerEntryData is the value addressed by its
 * LedgerKey. Membership in the response is not sufficient: a substituted
 * account, contract, code hash, config setting, or durability would otherwise
 * be accepted as snapshot state.
 */
export function validateLedgerKeyEntryCorrespondence(
  keyXdr: string,
  dataXdr: string,
): void {
  const key = xdr.LedgerKey.fromXDR(keyXdr, "base64");
  const data = xdr.LedgerEntryData.fromXDR(dataXdr, "base64");
  const keyName = key.switch().name;
  const dataName = data.switch().name;
  if (keyName === "account") {
    if (
      dataName !== "account" ||
      !sameXdr(key.account().accountId(), data.account().accountId())
    )
      throw new Error("Ledger entry/key mismatch: account identity");
  } else if (keyName === "trustline") {
    if (
      dataName !== "trustline" ||
      !sameXdr(key.trustLine().accountId(), data.trustLine().accountId()) ||
      !sameXdr(key.trustLine().asset(), data.trustLine().asset())
    )
      throw new Error("Ledger entry/key mismatch: trustline identity");
  } else if (keyName === "offer") {
    if (
      dataName !== "offer" ||
      !sameXdr(key.offer().sellerId(), data.offer().sellerId()) ||
      !sameXdr(key.offer().offerId(), data.offer().offerId())
    )
      throw new Error("Ledger entry/key mismatch: offer identity");
  } else if (keyName === "data") {
    if (
      dataName !== "data" ||
      !sameXdr(key.data().accountId(), data.data().accountId()) ||
      !sameXdr(key.data().dataName(), data.data().dataName())
    )
      throw new Error("Ledger entry/key mismatch: data identity");
  } else if (keyName === "claimableBalance") {
    if (
      dataName !== "claimableBalance" ||
      !sameXdr(
        key.claimableBalance().balanceId(),
        data.claimableBalance().balanceId(),
      )
    )
      throw new Error("Ledger entry/key mismatch: claimable-balance identity");
  } else if (keyName === "contractData") {
    if (
      dataName !== "contractData" ||
      !sameXdr(key.contractData().contract(), data.contractData().contract()) ||
      !sameXdr(key.contractData().key(), data.contractData().key()) ||
      key.contractData().durability().name !==
        data.contractData().durability().name
    )
      throw new Error("Ledger entry/key mismatch: contract-data identity");
  } else if (keyName === "contractCode") {
    if (
      dataName !== "contractCode" ||
      !sameXdr(key.contractCode().hash(), data.contractCode().hash())
    )
      throw new Error("Ledger entry/key mismatch: contract-code hash");
  } else if (keyName === "configSetting") {
    if (
      dataName !== "configSetting" ||
      key.configSetting().configSettingId().name !==
        data.configSetting().switch().name
    )
      throw new Error("Ledger entry/key mismatch: config-setting identity");
  } else if (keyName === "ttl") {
    if (
      dataName !== "ttl" ||
      !sameXdr(key.ttl().keyHash(), data.ttl().keyHash())
    )
      throw new Error("Ledger entry/key mismatch: TTL identity");
  } else {
    throw new Error(
      `Unsupported LedgerKey variant for correspondence validation: ${keyName}`,
    );
  }
}

function execute(
  file: string,
  args: string[],
  input?: string,
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(
        signal.reason || new Error("Simulation helper execution cancelled"),
      );
    }
    const child = execFile(
      file,
      args,
      {
        cwd,
        timeout: input === undefined ? 600_000 : 30_000,
        maxBuffer: 16 * 1024 * 1024,
        signal,
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(
            signal.reason || new Error("Simulation helper execution cancelled"),
          );
        } else if (error) {
          if (
            error.name === "AbortError" ||
            (error as any).code === "ABORT_ERR"
          ) {
            reject(
              signal?.reason ||
                new Error("Simulation helper execution cancelled"),
            );
          } else {
            const failure = new Error(
              `Simulation helper failed: ${stderr || error.message}`,
            ) as Error & { stdout?: string; exitCode?: number };
            failure.stdout = stdout;
            failure.exitCode =
              typeof (error as NodeJS.ErrnoException & { code?: unknown })
                .code === "number"
                ? (error as NodeJS.ErrnoException & { code: number }).code
                : undefined;
            reject(failure);
          }
        } else resolve(stdout);
      },
    );
    // Ignore EPIPE here: the exit callback reports a helper that rejects input.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

interface HelperFailureEnvelope {
  protocol_version: 1;
  status:
    | "uncaptured"
    | "unsupported"
    | "invalid_input"
    | "incomplete"
    | "host_failure";
  keys?: string[];
  message: string;
}

function parseHelperFailure(error: unknown): HelperFailureEnvelope | null {
  const stdout = (error as { stdout?: unknown })?.stdout;
  if (typeof stdout !== "string" || !stdout.trim()) return null;
  try {
    const parsed = JSON.parse(stdout) as Partial<HelperFailureEnvelope>;
    if (
      parsed.protocol_version !== 1 ||
      typeof parsed.status !== "string" ||
      typeof parsed.message !== "string"
    ) {
      throw new Error("invalid protocol envelope");
    }
    if (
      ![
        "uncaptured",
        "unsupported",
        "invalid_input",
        "incomplete",
        "host_failure",
      ].includes(parsed.status)
    )
      throw new Error("unknown protocol status");
    if (
      parsed.status === "uncaptured" &&
      (!Array.isArray(parsed.keys) || parsed.keys.length === 0)
    )
      throw new Error("uncaptured envelope has no keys");
    return parsed as HelperFailureEnvelope;
  } catch (parseError) {
    throw new Error(
      `Invalid native helper failure protocol: ${parseError instanceof Error ? parseError.message : parseError}`,
    );
  }
}

let provisioned: Promise<string> | undefined;

/**
 * Reset helper provisioning state (used for testing failure and recovery).
 * @internal Test-only; omitted from the published declarations.
 */
export function _resetSimulationHelperState(): void {
  provisioned = undefined;
}

export interface HelperCompatibilityInputs {
  os?: string;
  arch?: string;
  toolchain?: string;
  target?: string;
  manifestPath?: string;
  lockPath?: string;
  sourcePath?: string;
  features?: string[];
  flags?: string[];
}

/**
 * Define complete compatibility keys including helper source, manifest, lock,
 * pinned compiler, target, enabled features, and build flags.
 */
export function computeHelperCacheKey(
  inputs?: Partial<HelperCompatibilityInputs>,
): string {
  const directory = path.resolve(__dirname, "../native/simulation");
  const os = inputs?.os ?? process.platform;
  const arch = inputs?.arch ?? process.arch;
  const toolchain = inputs?.toolchain ?? "1.95.0";
  const target = inputs?.target ?? "x86_64-unknown-linux-gnu";
  const manifestPath =
    inputs?.manifestPath ?? path.join(directory, "Cargo.toml");
  const lockPath = inputs?.lockPath ?? path.join(directory, "Cargo.lock");
  const sourcePath = inputs?.sourcePath ?? path.join(directory, "src/main.rs");

  const manifestContent = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath)
    : Buffer.from("");
  const lockContent = fs.existsSync(lockPath)
    ? fs.readFileSync(lockPath)
    : Buffer.from("");
  const sourceContent = fs.existsSync(sourcePath)
    ? fs.readFileSync(sourcePath)
    : Buffer.from("");

  const features = [...(inputs?.features ?? [])].sort().join(",");
  const flags = [...(inputs?.flags ?? ["--release", "--locked"])]
    .sort()
    .join(" ");

  const hash = crypto
    .createHash("sha256")
    .update(manifestContent)
    .update(lockContent)
    .update(sourceContent)
    .update(features)
    .update(flags)
    .digest("hex");

  return `${os}-${arch}-cargo-simulation-helper-${toolchain}-${target}-${hash}`;
}

/** Linux x64 is the initial supported runtime. Cargo is never installed implicitly. */
export async function resolveSimulationHelper(
  explicitPath?: string,
  customBuild?: () => Promise<string>,
): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Native simulation currently supports Linux x64 only");
  }
  const override = explicitPath ?? process.env.WEIGHIN_HELPER_PATH;
  if (override) {
    const file = path.resolve(override);
    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      throw new Error(`Simulation helper missing or not executable: ${file}`);
    }
    return file;
  }
  if (!provisioned) {
    const buildPromise = (async () => {
      if (customBuild) {
        return customBuild();
      }
      const directory = path.resolve(__dirname, "../native/simulation");
      const manifest = path.join(directory, "Cargo.toml");
      if (!fs.existsSync(manifest))
        throw new Error(`Native simulation sources missing: ${manifest}`);
      console.log(
        "Building protocol-28 simulation helper (Rust 1.95.0, locked dependencies)...",
      );
      // Explicit target dir keeps Cargo environment overrides from moving the executable.
      await execute(
        "cargo",
        [
          "+1.95.0",
          "build",
          "--release",
          "--locked",
          "--manifest-path",
          manifest,
          "--target",
          "x86_64-unknown-linux-gnu",
          "--target-dir",
          path.join(directory, "target"),
        ],
        undefined,
        directory,
      );
      return path.join(
        directory,
        "target/x86_64-unknown-linux-gnu/release/weighin-simulation",
      );
    })();

    // Clear failed provisioning so subsequent calls can retry; do not let older
    // rejections clear newer in-flight attempts.
    const attempt = buildPromise.catch((err) => {
      if (provisioned === attempt) {
        provisioned = undefined;
      }
      throw err;
    });
    provisioned = attempt;
  }
  return provisioned;
}

/** Capture and hash the helper executable's content; rejects missing, unreadable, or non-file paths. */
export function captureHelperIdentity(helperPath: string): string {
  try {
    const stats = fs.statSync(helperPath);
    if (!stats.isFile()) {
      throw new Error(
        `Simulation helper at ${helperPath} is not a regular file`,
      );
    }
    const bytes = fs.readFileSync(helperPath);
    return sha256(bytes);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith("Simulation helper at")
    ) {
      throw err;
    }
    throw new Error(
      `Failed to capture simulation helper identity for ${helperPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Execute the versioned helper transport; never accept missing/invalid meters. */
export async function simulateSnapshot(
  input: SimulationInput,
  helperPath: string,
  signal?: AbortSignal,
): Promise<SimulationOutput> {
  let stdout: string;
  try {
    stdout = await execute(
      helperPath,
      [],
      JSON.stringify(input),
      undefined,
      signal,
    );
  } catch (failure) {
    // The helper reports a structured failure envelope on stdout. Surface its
    // status and message instead of the generic helper error text.
    const envelope = parseHelperFailure(failure);
    if (envelope) {
      throw new Error(`Native helper ${envelope.status}: ${envelope.message}`);
    }
    throw failure;
  }
  let output: SimulationOutput;
  try {
    output = outputSchema.parse(JSON.parse(stdout));
  } catch (error) {
    throw new Error(
      `Invalid simulation helper output: ${error instanceof Error ? error.message : error}`,
    );
  }
  const data = xdr.SorobanTransactionData.fromXDR(
    output.transaction_data_xdr,
    "base64",
  );
  const resources = data.resources();
  const same = (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right);
  if (
    resources.instructions() !== output.instruction_budget ||
    resources.diskReadBytes() !== output.disk_read_bytes ||
    resources.writeBytes() !== output.write_bytes ||
    !same(
      resources
        .footprint()
        .readOnly()
        .map((k) => k.toXDR("base64")),
      output.read_only_keys,
    ) ||
    !same(
      resources
        .footprint()
        .readWrite()
        .map((k) => k.toXDR("base64")),
      output.read_write_keys,
    )
  ) {
    throw new Error(
      "Invalid simulation helper output: resource fields disagree with transaction-data XDR",
    );
  }
  validateFootprintKeys(
    output.read_only_keys,
    output.read_write_keys,
    "simulation helper footprint",
  );
  xdr.ScVal.fromXDR(output.retval_xdr, "base64");
  for (const event of output.contract_events_xdr) {
    if (
      xdr.ContractEvent.fromXDR(event, "base64").type().name === "diagnostic"
    ) {
      throw new Error(
        "Invalid simulation helper output: diagnostic event is not a charged contract event",
      );
    }
  }
  return output;
}

const configNames = [
  "configSettingContractComputeV0",
  "configSettingContractLedgerCostV0",
  "configSettingContractLedgerCostExtV0",
  "configSettingContractHistoricalDataV0",
  "configSettingContractEventsV0",
  "configSettingContractBandwidthV0",
  "configSettingStateArchival",
  "configSettingContractCostParamsCpuInstructions",
  "configSettingContractCostParamsMemoryBytes",
  "configSettingLiveSorobanStateSizeWindow",
] as const;
const computeConfigNames = new Set([
  "configSettingContractComputeV0",
  "configSettingContractCostParamsCpuInstructions",
  "configSettingContractCostParamsMemoryBytes",
  "configSettingStateArchival",
]);
const configNameToKey = new Map(
  configNames.map((name) => [
    name,
    xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({
        configSettingId: xdr.ConfigSettingId[name](),
      }),
    ).toXDR("base64"),
  ]),
);
const configKeys = Array.from(configNameToKey.values());
const entriesSchema = z.object({
  latestLedger: integer.positive(),
  entries: z.array(
    z.object({
      key: encoded,
      xdr: encoded,
      extXdr: encoded,
      lastModifiedLedgerSeq: integer,
      liveUntilLedgerSeq: integer.optional(),
    }),
  ),
});
const simulationSchema = z.object({
  latestLedger: integer.positive(),
  transactionData: encoded,
  events: z.array(encoded),
  results: z.array(z.object({ xdr: encoded })).length(1),
});

function snapshotLimits(entries: SnapshotEntry[]): ResourceLimits {
  const settings = new Map(
    entries
      .filter((row) => configKeys.includes(row.key))
      .map((row) => {
        if (!row.xdr)
          throw new Error("Missing captured resource configuration");
        const setting = xdr.LedgerEntryData.fromXDR(
          row.xdr,
          "base64",
        ).configSetting();
        return [setting.switch().name, setting] as const;
      }),
  );
  const compute = settings
    .get("configSettingContractComputeV0")!
    .contractCompute();
  const io = settings
    .get("configSettingContractLedgerCostV0")!
    .contractLedgerCost();
  const footprint = settings
    .get("configSettingContractLedgerCostExtV0")!
    .contractLedgerCostExt();
  const events = settings
    .get("configSettingContractEventsV0")!
    .contractEvents();
  return z
    .object({
      cpu_instructions: integer.positive(),
      memory_bytes: integer.positive(),
      footprint_entries: integer,
      disk_read_bytes: integer,
      write_entries: integer,
      write_bytes: integer,
      events_and_return_bytes: integer,
    })
    .strict()
    .parse({
      cpu_instructions: Number(compute.txMaxInstructions().toString()),
      memory_bytes: compute.txMemoryLimit(),
      footprint_entries: footprint.txMaxFootprintEntries(),
      disk_read_bytes: io.txMaxDiskReadBytes(),
      write_entries: io.txMaxWriteLedgerEntries(),
      write_bytes: io.txMaxWriteBytes(),
      events_and_return_bytes: events.txMaxContractEventsSizeBytes(),
    });
}

class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: unknown,
    rpcUrl: string,
  ) {
    super(
      `RPC ${method} failed at ${sanitizeEndpoint(rpcUrl)}: ${redactEndpointSecrets(JSON.stringify(rpcError), rpcUrl)}`,
    );
  }
}

let nextRpcRequestId = 0;

// Only the error actually observed during live snapshot reads is retryable.
// HTTP failures, other RPC errors and simulation/helper failures remain fatal.
function isTransientLedgerRead(failure: unknown): boolean {
  if (!(failure instanceof RpcError) || failure.method !== "getLedgerEntries")
    return false;
  const error = failure.rpcError as {
    code?: unknown;
    message?: unknown;
  } | null;
  return (
    error?.code === -32603 &&
    error?.message ===
      "could not query captive core: http request failed with non-200 status code (404)"
  );
}

async function callRpc(
  rpcUrl: string,
  method: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) {
    throw signal.reason || new Error(`RPC ${method} cancelled`);
  }
  let response: Response;
  const timeoutSignal = AbortSignal.timeout(30_000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const requestId = ++nextRpcRequestId;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      }),
      signal: combinedSignal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason || new Error(`RPC ${method} cancelled`);
    }
    throw new Error(
      `RPC ${method} transport failure at ${sanitizeEndpoint(rpcUrl)}: ${redactEndpointSecrets(String((error as any)?.message ?? error), rpcUrl)}`,
    );
  }
  if (!response.ok)
    throw new Error(
      `RPC ${method}: HTTP ${response.status} at ${sanitizeEndpoint(rpcUrl)}`,
    );
  let responseBody: string;
  try {
    responseBody = await response.text();
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason || new Error(`RPC ${method} cancelled`);
    }
    throw new Error(
      `RPC ${method} response transport failure at ${sanitizeEndpoint(rpcUrl)}: ${redactEndpointSecrets(String((error as any)?.message ?? error), rpcUrl)}`,
    );
  }
  let envelope;
  try {
    envelope = parseJsonRpcResponse(responseBody, requestId);
  } catch (error) {
    throw new Error(
      `RPC ${method} invalid response at ${sanitizeEndpoint(rpcUrl)}: ${redactEndpointSecrets(String((error as Error)?.message ?? error), rpcUrl)}`,
    );
  }
  if ("error" in envelope) {
    throw new RpcError(method, envelope.error, rpcUrl);
  }
  return envelope.result;
}

export interface MeasureInvocationOptions {
  signal?: AbortSignal;
}

/** Capture all discovered keys/config at one ledger; retry the entire capture on drift.
 * RPC and helper must agree on transaction data and return value at that ledger.
 * The fixed seed makes random-dependent RPC parity an explicit unsupported case.
 */
export async function measureInvocation(
  rpcUrl: string,
  transaction: Transaction,
  helperPath: string,
  options?: MeasureInvocationOptions,
): Promise<{
  output: SimulationOutput;
  provenance: ComputeProvenance;
  limits: ResourceLimits;
}> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw signal.reason || new Error("Measurement cancelled");
  }
  const network = z
    .object({ passphrase: encoded, protocolVersion: integer })
    .parse(await callRpc(rpcUrl, "getNetwork", {}, signal));
  if (network.protocolVersion !== SUPPORTED_PROTOCOL_VERSION)
    throw new Error(
      `Unsupported protocol ${network.protocolVersion}: simulation helper supports ${SUPPORTED_PROTOCOL_VERSION}`,
    );
  if (transaction.networkPassphrase !== network.passphrase) {
    throw new Error(
      `Transaction network passphrase "${transaction.networkPassphrase}" does not match RPC network passphrase "${network.passphrase}"`,
    );
  }
  const keys = new Set(configKeys);
  let transientReadFailures = 0;
  let lastCause:
    | "ledger_drift"
    | "batch_ledger_disagreement"
    | "newly_discovered_keys"
    | "transient_read"
    | "none" = "none";
  const causes = {
    ledger_drift: 0,
    batch_ledger_disagreement: 0,
    newly_discovered_keys: 0,
    transient_read: 0,
  };
  let discoveredKeysCount = 0;
  let initialHelperSha256: string | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (signal?.aborted) {
      throw signal.reason || new Error("Measurement cancelled");
    }
    const raw = await callRpc(
      rpcUrl,
      "simulateTransaction",
      {
        transaction: transaction.toXDR(),
      },
      signal,
    );
    const error = (raw as { error?: string }).error;
    if (error) throw new Error(`RPC simulation failed: ${error}`);
    const simulation = simulationSchema.parse(raw);
    const resources = xdr.SorobanTransactionData.fromXDR(
      simulation.transactionData,
      "base64",
    ).resources();
    const roKeys = resources
      .footprint()
      .readOnly()
      .map((k) => k.toXDR("base64"));
    const rwKeys = resources
      .footprint()
      .readWrite()
      .map((k) => k.toXDR("base64"));
    validateFootprintKeys(roKeys, rwKeys, "RPC simulation footprint");
    for (const key of [...roKeys, ...rwKeys]) keys.add(key);
    const requested = [...keys].sort();
    const rows = new Map<
      string,
      z.infer<typeof entriesSchema>["entries"][number]
    >();
    let drift = false;
    for (let offset = 0; offset < requested.length; offset += 200) {
      if (signal?.aborted) {
        throw signal.reason || new Error("Measurement cancelled");
      }
      const batch = requested.slice(offset, offset + 200);
      let rawEntries: unknown;
      try {
        rawEntries = await callRpc(
          rpcUrl,
          "getLedgerEntries",
          { keys: batch },
          signal,
        );
      } catch (failure) {
        if (!isTransientLedgerRead(failure)) throw failure;
        transientReadFailures++;
        lastCause = "transient_read";
        causes.transient_read++;
        if (transientReadFailures > 3 || attempt === 29) {
          throw new Error(
            `Snapshot ledger-read retry limit exhausted: ${failure instanceof Error ? failure.message : failure}`,
          );
        }
        const delay = 250 * 2 ** (transientReadFailures - 1);
        console.warn(
          `Transient captive-core ledger-read failure; discarding snapshot and retrying capture (${transientReadFailures}/3, ${delay}ms): ${failure instanceof Error ? failure.message : failure}`,
        );
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          if (signal) {
            const onAbort = () => {
              clearTimeout(timer);
              reject(signal.reason || new Error("Measurement cancelled"));
            };
            if (signal.aborted) {
              clearTimeout(timer);
              return reject(
                signal.reason || new Error("Measurement cancelled"),
              );
            }
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        drift = true;
        break;
      }
      const result = entriesSchema.parse(rawEntries);
      if (result.latestLedger !== simulation.latestLedger) {
        if (offset === 0) {
          lastCause = "ledger_drift";
          causes.ledger_drift++;
        } else {
          lastCause = "batch_ledger_disagreement";
          causes.batch_ledger_disagreement++;
        }
        drift = true;
        break;
      }
      for (const row of result.entries) {
        if (!batch.includes(row.key) || rows.has(row.key))
          throw new Error(
            "Invalid/duplicate ledger entry in snapshot response",
          );
        rows.set(row.key, row);
      }
    }
    if (drift) continue;
    const headers = z
      .object({
        ledgers: z.array(
          z.object({
            sequence: integer,
            headerXdr: encoded,
            hash: z.string().optional(),
          }),
        ),
      })
      .parse(
        await callRpc(
          rpcUrl,
          "getLedgers",
          {
            startLedger: simulation.latestLedger,
            pagination: { limit: 1 },
          },
          signal,
        ),
      );
    const matchingRows = headers.ledgers.filter(
      (item) => item.sequence === simulation.latestLedger,
    );
    if (matchingRows.length === 0) {
      throw new Error("Snapshot ledger header unavailable");
    }
    if (matchingRows.length > 1) {
      throw new Error(
        `Ambiguous duplicate ledger headers returned for sequence ${simulation.latestLedger}`,
      );
    }
    const row = matchingRows[0];
    let historyEntry: xdr.LedgerHeaderHistoryEntry;
    try {
      historyEntry = xdr.LedgerHeaderHistoryEntry.fromXDR(
        row.headerXdr,
        "base64",
      );
    } catch {
      throw new Error("Malformed ledger header history entry XDR");
    }
    const header = historyEntry.header();
    if (
      header.ledgerSeq() !== simulation.latestLedger ||
      header.ledgerVersion() !== network.protocolVersion
    ) {
      throw new Error("Snapshot header ledger/protocol mismatch");
    }
    validateLedgerHeaderHash(historyEntry, row.hash);
    const missingConfigs = configNames.filter((name) => {
      const key = configNameToKey.get(name)!;
      const row = rows.get(key);
      return !row || !row.xdr;
    });
    if (missingConfigs.length > 0) {
      throw new Error(
        `Missing required configuration entries: [${missingConfigs.join(", ")}]`,
      );
    }
    const entries: SnapshotEntry[] = requested.map((key) => {
      const entry = rows.get(key);
      if (entry?.xdr) validateLedgerKeyEntryCorrespondence(key, entry.xdr);
      return entry
        ? {
            key,
            xdr: entry.xdr,
            extension_xdr: entry.extXdr,
            last_modified: entry.lastModifiedLedgerSeq,
            live_until: entry.liveUntilLedgerSeq ?? null,
          }
        : { key, xdr: null };
    });
    const operation = transaction.toEnvelope().v1().tx().operations();
    if (
      operation.length !== 1 ||
      operation[0].body().switch().name !== "invokeHostFunction"
    )
      throw new Error("Expected exactly one host invocation");
    const input: SimulationInput = {
      schema_version: 1,
      header_xdr: header.toXDR("base64"),
      network_passphrase: network.passphrase,
      host_function_xdr: operation[0]
        .body()
        .invokeHostFunctionOp()
        .hostFunction()
        .toXDR("base64"),
      source_account_xdr: Keypair.fromPublicKey(transaction.source)
        .xdrPublicKey()
        .toXDR("base64"),
      entries,
      instruction_leeway: 0,
      seed: Array(32).fill(0),
    };
    const preHelperSha256 = captureHelperIdentity(helperPath);
    if (initialHelperSha256 === null) {
      initialHelperSha256 = preHelperSha256;
    } else if (preHelperSha256 !== initialHelperSha256) {
      throw new Error(
        `Simulation helper executable was modified across attempts (expected: ${initialHelperSha256}, current: ${preHelperSha256})`,
      );
    }
    let output: SimulationOutput;
    try {
      output = await simulateSnapshot(input, helperPath, signal);
    } catch (failure) {
      const postFailureSha256 = captureHelperIdentity(helperPath);
      if (postFailureSha256 !== initialHelperSha256) {
        throw new Error(
          `Simulation helper executable was modified during execution (expected: ${initialHelperSha256}, current: ${postFailureSha256})`,
        );
      }
      const envelope = parseHelperFailure(failure);
      if (envelope) {
        if (envelope.status !== "uncaptured")
          throw new Error(
            `Native helper ${envelope.status}: ${envelope.message}`,
          );
        const additional = (envelope.keys ?? []).filter(
          (key) => !keys.has(key),
        );
        if (!additional.length)
          throw new Error("Native helper reported no new captured keys");
        for (const key of additional) {
          try {
            xdr.LedgerKey.fromXDR(key, "base64");
          } catch {
            throw new Error("Native helper reported malformed LedgerKey");
          }
          keys.add(key);
        }
        lastCause = "newly_discovered_keys";
        causes.newly_discovered_keys++;
        discoveredKeysCount += additional.length;
        continue;
      }
      const message =
        failure instanceof Error ? failure.message : String(failure);
      const missing = [
        ...message.matchAll(/UNCAPTURED_KEY:([A-Za-z0-9+/=]+)/g),
      ].map((match) => match[1]);
      const additional = missing.filter((key) => !keys.has(key));
      if (!additional.length) throw failure;
      lastCause = "newly_discovered_keys";
      causes.newly_discovered_keys++;
      discoveredKeysCount += additional.length;
      for (const key of additional) {
        xdr.LedgerKey.fromXDR(key, "base64");
        keys.add(key);
      }
      continue; // Recapture all state, including newly discovered keys, at one ledger.
    }
    const postHelperSha256 = captureHelperIdentity(helperPath);
    if (postHelperSha256 !== initialHelperSha256) {
      throw new Error(
        `Simulation helper executable was modified during execution (expected: ${initialHelperSha256}, current: ${postHelperSha256})`,
      );
    }
    // RPC events are DiagnosticEvent wrappers. Only successful non-diagnostic
    // ContractEvents contribute to this charged resource; preserve their order.
    const rpcEvents = simulation.events
      .map((event) => xdr.DiagnosticEvent.fromXDR(event, "base64"))
      .filter(
        (event) =>
          event.inSuccessfulContractCall() &&
          event.event().type().name !== "diagnostic",
      )
      .map((event) => event.event().toXDR("base64"));
    const txDataMismatch =
      output.transaction_data_xdr !== simulation.transactionData;
    const retvalMismatch = output.retval_xdr !== simulation.results[0].xdr;
    const eventsMismatch =
      JSON.stringify(output.contract_events_xdr) !== JSON.stringify(rpcEvents);
    if (txDataMismatch || retvalMismatch || eventsMismatch) {
      const mismatches: string[] = [];
      if (txDataMismatch) {
        mismatches.push(
          `transaction-data disagreement (native_sha256: ${sha256(output.transaction_data_xdr)}, rpc_sha256: ${sha256(simulation.transactionData)})`,
        );
      }
      if (retvalMismatch) {
        mismatches.push(
          `return-value disagreement (native_sha256: ${sha256(output.retval_xdr)}, rpc_sha256: ${sha256(simulation.results[0].xdr)})`,
        );
      }
      if (eventsMismatch) {
        mismatches.push(
          `ordered charged-event disagreement (native_count: ${output.contract_events_xdr.length}, rpc_count: ${rpcEvents.length}, native_sha256: ${sha256(JSON.stringify(output.contract_events_xdr))}, rpc_sha256: ${sha256(JSON.stringify(rpcEvents))})`,
        );
      }
      const err = new Error(
        `Local simulation disagrees with RPC at captured ledger [${mismatches.join("; ")}]; auth/random/state-dependent invocation is unsupported`,
      );
      (err as any).parityDetails = {
        transactionData: txDataMismatch,
        returnValue: retvalMismatch,
        contractEvents: eventsMismatch,
      };
      throw err;
    }
    const limits = snapshotLimits(entries);
    if (
      output.cpu_limit !== limits.cpu_instructions ||
      output.memory_limit !== limits.memory_bytes
    ) {
      throw new Error(
        "Native compute limits disagree with captured configuration",
      );
    }
    const finalHelperSha256 = captureHelperIdentity(helperPath);
    if (finalHelperSha256 !== initialHelperSha256) {
      throw new Error(
        `Simulation helper executable was modified before emitting provenance (expected: ${initialHelperSha256}, current: ${finalHelperSha256})`,
      );
    }
    return {
      output,
      limits,
      provenance: {
        source: output.source,
        source_version: output.source_version,
        protocol: output.protocol,
        helper_sha256: initialHelperSha256,
        network_id: sha256(network.passphrase),
        ledger: simulation.latestLedger,
        header_sha256: sha256(input.header_xdr),
        snapshot_sha256: sha256(JSON.stringify(entries)),
        config_sha256: sha256(
          JSON.stringify(
            entries.filter((entry) => configKeys.includes(entry.key)),
          ),
        ),
        resource_limits_sha256: sha256(JSON.stringify(limits)),
        // Cost model/limits/TTL values determine comparable compute. Fee-only live
        // state-size windows and last-modified metadata remain full provenance.
        compute_config_sha256: sha256(
          JSON.stringify(
            entries
              .filter((entry) => {
                const key = xdr.LedgerKey.fromXDR(entry.key, "base64");
                return (
                  key.switch().name === "configSetting" &&
                  computeConfigNames.has(
                    key.configSetting().configSettingId().name,
                  )
                );
              })
              .map((entry) => ({ key: entry.key, xdr: entry.xdr })),
          ),
        ),
        input_sha256: sha256(JSON.stringify(input)),
        seed: input.seed,
        auth_mode: output.auth_mode,
        host_features: output.host_features,
        source_account: transaction.source,
      },
    };
  }
  const exhaustionError = new Error(
    `Unable to capture a complete consistent snapshot after 30 attempts (last cause: ${lastCause}; attempts: 30, ledger_drift: ${causes.ledger_drift}, batch_ledger_disagreement: ${causes.batch_ledger_disagreement}, newly_discovered_keys: ${causes.newly_discovered_keys}, transient_reads: ${causes.transient_read}, tracked_keys: ${keys.size})`,
  );
  (exhaustionError as any).diagnostics = {
    lastCause,
    attempts: 30,
    causes,
    trackedKeys: keys.size,
    discoveredKeysCount,
  };
  throw exhaustionError;
}
