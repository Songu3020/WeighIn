import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parseFixtures } from "./identity";
import { discoverSdkVersion } from "./sdk-version";
import { ensureAccountReady } from "./account";
import { redactEndpointSecrets, sanitizeEndpoint } from "./endpoint";
import { validateLargeInt } from "./config";
import { SUPPORTED_NETWORK_PASSPHRASE } from "./network";
import { CURRENT_RECORD_SCHEMA_VERSION } from "./record-schema";
import {
  measureInvocation,
  resolveSimulationHelper,
  validateFootprintKeys,
  ComputeProvenance,
  SimulationOutput,
  ResourceLimits,
} from "./simulation";
import {
  xdr,
  nativeToScVal,
  hash,
  StrKey,
  Address,
  TransactionBuilder,
  Transaction,
  Operation,
  Keypair,
  rpc,
  scvSortedMap,
} from "@stellar/stellar-sdk";

const DEFAULT_RPC_URL = "http://localhost:8000/rpc";

/** Schema 5 binds each metric to its approved source and cap mapping. */
export interface MetricValue {
  availability?: "measured" | "unavailable";
  consumed: number | null;
  limit: number | null;
  reason?: string;
  source?: string;
  limit_source?: string;
  limit_reason?: string;
}

export interface Metrics {
  cpu_instructions: MetricValue;
  memory_bytes: MetricValue;
  ledger_read_entries: MetricValue;
  ledger_read_bytes: MetricValue;
  ledger_write_entries: MetricValue;
  ledger_write_bytes: MetricValue;
  historical_data_read_bytes: MetricValue;
  contract_data_hard_limit: MetricValue;
  tx_size_bytes: MetricValue;
  events_count: MetricValue;
  event_data_bytes: MetricValue;
}

export interface BenchmarkResult {
  function_name: string;
  /** Stable configured case identity; absent only in legacy results. */
  case_id?: string;
  metrics: Metrics;
  wasm_sha256: string;
  provenance?: ComputeProvenance;
}

export interface ContractBenchmark {
  /** Versions 2–4 separate logical comparison identity from deployment identity. */
  schema_version?: 2 | 3 | 4 | 5;
  fixture_id?: string;
  logical_id?: string;
  /** Runtime address, never the comparison key for logical results. */
  contract_id: string;
  git_commit: string;
  soroban_sdk_version: string;
  timestamp: number;
  benchmarks: BenchmarkResult[];
}

export interface InvocationArg {
  type: string;
  value: any;
}

export interface InvocationSpec {
  id?: string;
  function_name: string;
  args: InvocationArg[];
}

export interface ContractSpec {
  id?: string;
  wasm_path: string;
  invocations: InvocationSpec[];
}

export interface FixturesSpec {
  id?: string;
  contracts: ContractSpec[];
}

/** Protocol-28 mapping, audited against the pinned host and RPC-matched helper.
 * IO byte adjustment is exactly identity in this helper's default configuration.
 * Footprint sizes are distinct access keys, not counts of host read/write calls.
 */
export function metricsFromSimulation(
  output: SimulationOutput,
  limits: ResourceLimits,
): Metrics {
  validateFootprintKeys(
    output.read_only_keys,
    output.read_write_keys,
    "measured simulation footprint",
  );
  const measured = (
    consumed: number,
    limit: number,
    source: string,
    limit_source: string,
  ): MetricValue => ({
    availability: "measured",
    consumed,
    limit,
    source,
    limit_source,
  });
  const unavailable = (reason: string): MetricValue => ({
    availability: "unavailable",
    consumed: null,
    limit: null,
    reason,
  });
  const io = "ConfigSettingContractLedgerCostV0";
  const eventBytes =
    output.contract_events_xdr.reduce(
      (sum, event) =>
        sum + xdr.ContractEvent.fromXDR(event, "base64").toXDR().length,
      0,
    ) + xdr.ScVal.fromXDR(output.retval_xdr, "base64").toXDR().length;
  return {
    cpu_instructions: measured(
      output.cpu_instructions_consumed,
      limits.cpu_instructions,
      "soroban-simulation.simulated_instructions",
      "ConfigSettingContractComputeV0.txMaxInstructions",
    ),
    memory_bytes: measured(
      output.memory_bytes_consumed,
      limits.memory_bytes,
      "soroban-simulation.simulated_memory",
      "ConfigSettingContractComputeV0.txMemoryLimit",
    ),
    ledger_read_entries: measured(
      output.read_only_keys.length + output.read_write_keys.length,
      limits.footprint_entries,
      "SorobanResources.footprint.readOnly.length + readWrite.length",
      "ConfigSettingContractLedgerCostExtV0.txMaxFootprintEntries",
    ),
    ledger_read_bytes: measured(
      output.disk_read_bytes,
      limits.disk_read_bytes,
      "SorobanResources.diskReadBytes (identity adjustment)",
      `${io}.txMaxDiskReadBytes`,
    ),
    ledger_write_entries: measured(
      output.read_write_keys.length,
      limits.write_entries,
      "SorobanResources.footprint.readWrite.length",
      `${io}.txMaxWriteLedgerEntries`,
    ),
    ledger_write_bytes: measured(
      output.write_bytes,
      limits.write_bytes,
      "SorobanResources.writeBytes (identity adjustment)",
      `${io}.txMaxWriteBytes`,
    ),
    historical_data_read_bytes: unavailable(
      "Protocol 28 exposes historical-data fees, not a historical read consumption resource",
    ),
    contract_data_hard_limit: unavailable(
      "No verified instance-only post-invocation size and corresponding limit mapping",
    ),
    tx_size_bytes: unavailable(
      "Simulation estimates a maximum envelope; no signed benchmark transaction is submitted",
    ),
    events_count: {
      availability: "measured",
      consumed: output.contract_events_xdr.length,
      limit: null,
      source: "successful non-diagnostic ContractEvents.length",
      limit_reason: "Protocol 28 has no independent event-count cap",
    },
    event_data_bytes: measured(
      eventBytes,
      limits.events_and_return_bytes,
      "sum(successful non-diagnostic ContractEvent XDR bytes) + return ScVal XDR bytes",
      "ConfigSettingContractEventsV0.txMaxContractEventsSizeBytes",
    ),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validate a public account key used as an invocation source.
 *  Only Ed25519 account identifiers are accepted; muxed and contract
 *  addresses are not transaction sources.
 */
export function normalizeSourceAccount(publicKey: string): string {
  if (typeof publicKey !== "string" || !publicKey.trim()) {
    throw new Error("Invalid invocation source account: expected a public key");
  }
  const trimmed = publicKey.trim();
  if (!StrKey.isValidEd25519PublicKey(trimmed)) {
    throw new Error(
      "Invalid invocation source account: expected an Ed25519 account public key (G...)",
    );
  }
  return trimmed;
}

// Convert native type/value to ScVal
export function toScVal(arg: InvocationArg): xdr.ScVal {
  const type = arg.type.toLowerCase();
  const val = arg.value;
  switch (type) {
    case "symbol":
      return xdr.ScVal.scvSymbol(val);
    case "string":
      return xdr.ScVal.scvString(val);
    case "u32":
      return xdr.ScVal.scvU32(val);
    case "i32":
      return xdr.ScVal.scvI32(val);
    case "bool":
      return xdr.ScVal.scvBool(val);
    case "u64":
    case "i64":
    case "u128":
    case "i128": {
      const err = validateLargeInt(type, val);
      if (err) throw new Error(err);
      return nativeToScVal(BigInt(val), { type });
    }
    case "address": {
      if (typeof val !== "string")
        throw new Error("Invalid value for address: must be string");
      try {
        return Address.fromString(val).toScVal();
      } catch (error: any) {
        throw new Error(`Invalid value for address: ${error.message}`);
      }
    }
    case "bytes": {
      if (typeof val !== "string")
        throw new Error("Invalid value for bytes: must be valid hex");
      if (!/^[0-9a-fA-F]*$/.test(val))
        throw new Error("Invalid value for bytes: must be valid hex");
      if (val.length % 2 !== 0)
        throw new Error(
          "Invalid value for bytes: hex string must have even length",
        );
      return xdr.ScVal.scvBytes(Buffer.from(val, "hex"));
    }
    case "vec": {
      if (!Array.isArray(val))
        throw new Error("Invalid value for vec: must be array");
      return xdr.ScVal.scvVec(
        val.map((item, index) => {
          if (!item || typeof item.type !== "string" || !("value" in item))
            throw new Error(`Invalid vector element at index ${index}`);
          return toScVal(item as InvocationArg);
        }),
      );
    }
    case "map": {
      if (!Array.isArray(val))
        throw new Error("Invalid value for map: must be array");
      const seenKeyXdrs = new Set<string>();
      const entries = val.map((entry, index) => {
        if (!entry?.key || !entry?.value)
          throw new Error(`Invalid map entry at index ${index}`);
        const keySc = toScVal(entry.key);
        const keyXdrHex = keySc.toXDR("hex");
        if (seenKeyXdrs.has(keyXdrHex)) {
          throw new Error(
            `Duplicate map key detected at entry ${index}: key encodes to identical Soroban ScVal value`,
          );
        }
        seenKeyXdrs.add(keyXdrHex);
        return new xdr.ScMapEntry({
          key: keySc,
          val: toScVal(entry.value),
        });
      });
      return scvSortedMap(entries);
    }
    default:
      throw new Error(`Unsupported argument type: ${arg.type}`);
  }
}

// Deterministically calculate contract ID
export function calculateContractId(
  deployerAddress: string,
  salt: Buffer,
): string {
  const addressSc = Address.fromString(deployerAddress).toScAddress();
  const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: addressSc,
      salt: salt,
    }),
  );

  const networkId = hash(Buffer.from(SUPPORTED_NETWORK_PASSPHRASE));
  const hashIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: networkId,
      contractIdPreimage: preimage,
    }),
  );

  const contractIdBytes = hash(hashIdPreimage.toXDR());
  return StrKey.encodeContract(contractIdBytes);
}

/**
 * Load or generate a deployer keypair.
 *
 * @param keyFile  Absolute path to the key file. Shared between base and head
 *                 runs so both measurements use the same on-chain account.
 * @param rpcUrl   Used to derive the friendbot URL for initial funding.
 */
export async function getOrInitAccount(
  keyFile: string,
  rpcUrl: string,
  signal?: AbortSignal,
): Promise<Keypair> {
  let keypair: Keypair;
  if (fs.existsSync(keyFile)) {
    const secret = fs.readFileSync(keyFile, "utf8").trim();
    keypair = Keypair.fromSecret(secret);
  } else {
    keypair = Keypair.random();
    fs.writeFileSync(keyFile, keypair.secret(), { mode: 0o600 });
  }

  await ensureAccountReady(rpcUrl, keypair.publicKey(), signal);

  return keypair;
}

// Poll transaction completion
async function waitForTransaction(
  server: rpc.Server,
  txHash: string,
  signal?: AbortSignal,
): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < 30; i++) {
    if (signal?.aborted) {
      throw signal.reason || new Error("Transaction confirmation cancelled");
    }
    const tx = await server.getTransaction(txHash);
    if (tx.status !== "NOT_FOUND") {
      return tx;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(
            signal.reason || new Error("Transaction confirmation cancelled"),
          );
        };
        if (signal.aborted) {
          clearTimeout(timer);
          return reject(
            signal.reason || new Error("Transaction confirmation cancelled"),
          );
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  throw new Error(`Transaction ${txHash} not found after 30 seconds`);
}

// A transaction hash is 32 hex-encoded bytes.
const TX_HASH_PATTERN = /^[0-9a-f]{64}$/i;

function isTransactionHash(value: unknown): value is string {
  return typeof value === "string" && TX_HASH_PATTERN.test(value);
}

// Render an endpoint for diagnostics without exposing userinfo or query values.
function safeEndpoint(rpcUrl: string): string {
  try {
    const url = new URL(rpcUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid endpoint]";
  }
}

// Strip endpoint credentials from a captured transport message before reporting.
function scrubEndpoint(message: string, rpcUrl: string): string {
  return message
    .split(rpcUrl)
    .join(safeEndpoint(rpcUrl))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1")
    .replace(/([?&][^=&\s]+)=([^&\s]*)/g, "$1=REDACTED");
}

function hashLabel(hash: unknown): string {
  return isTransactionHash(hash) ? hash : "none";
}

// Submit a prepared transaction and require a confirmed SUCCESS. Definite
// rejections (ERROR) and temporary rejections (TRY_AGAIN_LATER) fail before any
// confirmation polling; PENDING/DUPLICATE with a valid hash use the existing
// confirmation path; any other response fails closed.
async function submitAndConfirm(
  server: rpc.Server,
  prepared: Transaction,
  phase: string,
  rpcUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason || new Error(`${phase} cancelled`);
  }
  let submission: rpc.Api.SendTransactionResponse;
  try {
    submission = await server.sendTransaction(prepared);
  } catch (err: any) {
    if (signal?.aborted) {
      throw signal.reason || new Error(`${phase} cancelled`);
    }
    throw new Error(
      `${phase} submission failed at ${safeEndpoint(rpcUrl)}: ${scrubEndpoint(String(err?.message ?? err), rpcUrl)}`,
    );
  }
  const status = submission?.status as string;
  if (status === "ERROR") {
    throw new Error(
      `${phase} submission was rejected (status=ERROR, hash=${hashLabel(submission?.hash)})`,
    );
  }
  if (status === "TRY_AGAIN_LATER") {
    throw new Error(
      `${phase} submission was temporarily rejected (status=TRY_AGAIN_LATER, hash=${hashLabel(submission?.hash)})`,
    );
  }
  if (status !== "PENDING" && status !== "DUPLICATE") {
    throw new Error(
      `${phase} submission returned an invalid response: unrecognized status "${String(submission?.status)}"`,
    );
  }
  if (!isTransactionHash(submission.hash)) {
    throw new Error(
      `${phase} submission returned an invalid response (status=${status}): missing or invalid transaction hash`,
    );
  }
  const confirmed = await waitForTransaction(server, submission.hash, signal);
  if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(
      `${phase} transaction ${submission.hash} did not succeed (status=${confirmed.status})`,
    );
  }
}

// Check if contract is already deployed
export async function isContractDeployed(
  server: rpc.Server,
  contractId: string,
): Promise<boolean> {
  const contractScAddress = Address.fromString(contractId).toScAddress();
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractScAddress,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  try {
    const res = await server.getLedgerEntries(ledgerKey);
    if (
      !res ||
      typeof res !== "object" ||
      !Array.isArray((res as any).entries)
    ) {
      throw new Error(
        `Deployment probe returned an invalid ledger response: ${JSON.stringify(res)}`,
      );
    }

    if (res.entries.length === 0) return false;
    if (res.entries.length > 1) {
      throw new Error(
        `Deployment probe returned ${res.entries.length} entries for ${contractId}; expected at most one matching contract instance`,
      );
    }

    const entry = res.entries[0] as any;
    if (!entry || typeof entry !== "object") {
      throw new Error(
        `Deployment probe returned a malformed entry for ${contractId}: ${JSON.stringify(entry)}`,
      );
    }
    const entryKey =
      typeof entry.key === "string"
        ? entry.key
        : typeof entry.key?.toXDR === "function"
          ? entry.key.toXDR("base64")
          : undefined;
    const entryValue = entry.xdr ?? entry.val;
    const entryXdr =
      typeof entryValue === "string"
        ? entryValue
        : typeof entryValue?.toXDR === "function"
          ? entryValue.toXDR("base64")
          : undefined;
    if (typeof entryKey !== "string" || typeof entryXdr !== "string") {
      throw new Error(
        `Deployment probe returned a missing key/xdr payload for ${contractId}: ${JSON.stringify(entry)}`,
      );
    }
    if (entryKey !== ledgerKey.toXDR("base64")) {
      throw new Error(
        `Deployment probe returned an unrelated ledger entry for ${contractId}; expected instance key ${ledgerKey.toXDR("base64")}, got ${entryKey}`,
      );
    }

    let ledgerEntry: xdr.LedgerEntryData;
    try {
      ledgerEntry = xdr.LedgerEntryData.fromXDR(entryXdr, "base64");
    } catch (error: any) {
      throw new Error(
        `Deployment probe returned invalid XDR for ${contractId}: ${error.message}`,
      );
    }

    if (ledgerEntry.switch().name !== "contractData") {
      throw new Error(
        `Deployment probe returned ${ledgerEntry.switch().name} for ${contractId}; expected contractData`,
      );
    }

    const contractData = ledgerEntry.contractData();
    if (!contractData) {
      throw new Error(
        `Deployment probe returned a contractData record without payload for ${contractId}`,
      );
    }
    const instanceKey = contractData.key();
    if (
      instanceKey.toXDR("base64") !==
      xdr.ScVal.scvLedgerKeyContractInstance().toXDR("base64")
    ) {
      throw new Error(
        `Deployment probe returned a non-instance contractData entry for ${contractId}`,
      );
    }
    if (
      contractData.contract().toXDR("base64") !==
      contractScAddress.toXDR("base64")
    ) {
      throw new Error(
        `Deployment probe returned a different contract for ${contractId}; expected ${contractScAddress.toXDR("base64")}`,
      );
    }

    return true;
  } catch (error: any) {
    if (
      error instanceof Error &&
      error.message.startsWith("Deployment probe")
    ) {
      throw error;
    }
    throw new Error(
      `Deployment probe failed for contract ${contractId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Resolve a declared wasm_path against the fixtures directory.
 *  Falls back to the sibling target directory when a workspace renamed its
 *  target triple, and fails before any network side effect otherwise.
 */
export function resolveContractWasmPath(
  fixturesDir: string,
  wasmPath: string,
): string {
  let resolved = path.resolve(fixturesDir, wasmPath);
  if (!fs.existsSync(resolved)) {
    let altPath = "";
    if (resolved.includes("wasm32-unknown-unknown")) {
      altPath = resolved.replace("wasm32-unknown-unknown", "wasm32v1-none");
    } else if (resolved.includes("wasm32v1-none")) {
      altPath = resolved.replace("wasm32v1-none", "wasm32-unknown-unknown");
    }
    if (altPath && fs.existsSync(altPath)) {
      resolved = altPath;
    } else {
      throw new Error(
        `WASM not found: ${resolved}\nBuild the contract before running measurements.`,
      );
    }
  }
  return resolved;
}

/** Upload the WASM and create the contract instance when it is not deployed.
 *  Deployment always uses the deployer account, never an invocation source.
 */
export async function ensureContractDeployed(options: {
  server: rpc.Server;
  deployer: Keypair;
  deployerAddress: Address;
  wasmBytes: Buffer;
  wasmHash: Buffer;
  salt: Buffer;
  contractId: string;
  rpcUrl: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { server, deployer, deployerAddress, wasmBytes, wasmHash, salt } =
    options;
  const deployed = await isContractDeployed(server, options.contractId);
  if (deployed) {
    console.log(`Already deployed at ${options.contractId}`);
    return;
  }

  console.log(`Installing WASM...`);
  let account = await server.getAccount(deployer.publicKey());

  // 1. Upload WASM
  const uploadTx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: SUPPORTED_NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.uploadContractWasm({ wasm: wasmBytes }))
    .setTimeout(30)
    .build();

  let preparedUpload;
  try {
    preparedUpload = await server.prepareTransaction(uploadTx);
  } catch (err: any) {
    console.error(
      `WASM upload preparation failed at ${sanitizeEndpoint(options.rpcUrl)}: ${redactEndpointSecrets(String(err?.message ?? err), options.rpcUrl)}`,
    );
    throw err;
  }
  preparedUpload.sign(deployer);
  await submitAndConfirm(
    server,
    preparedUpload,
    "WASM upload",
    options.rpcUrl,
    options.signal,
  );

  console.log(`WASM installed. Deploying contract instance...`);
  account = await server.getAccount(deployer.publicKey());

  // 2. Create contract instance
  const createTx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: SUPPORTED_NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.createCustomContract({
        wasmHash,
        address: deployerAddress,
        salt,
      }),
    )
    .setTimeout(30)
    .build();

  const preparedCreate = await server.prepareTransaction(createTx);
  preparedCreate.sign(deployer);
  await submitAndConfirm(
    server,
    preparedCreate,
    "contract creation",
    options.rpcUrl,
    options.signal,
  );
  console.log(`Deployed at ${options.contractId}`);
}

/** Build the simulated invocation transaction for one contract case.
 *  The transaction source account selects the invoking identity; it is never
 *  a signing key, because benchmark invocations are simulated, not submitted.
 */
export async function buildInvocationTransaction(options: {
  server: rpc.Server;
  sourceAccount: string;
  contractId: string;
  invocation: InvocationSpec;
  rpcUrl: string;
  signal?: AbortSignal;
}): Promise<Transaction> {
  const { server, sourceAccount, contractId, invocation } = options;
  if (options.signal?.aborted) {
    throw options.signal.reason || new Error("Measurement cancelled");
  }
  let account;
  try {
    account = await server.getAccount(sourceAccount);
  } catch (err: any) {
    throw new Error(
      `Invocation source account is not available on the network: ${sourceAccount} (${redactEndpointSecrets(String(err?.message ?? err), options.rpcUrl)})`,
    );
  }
  const argsSc = invocation.args.map(toScVal);
  return new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: SUPPORTED_NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: invocation.function_name,
        args: argsSc,
      }),
    )
    .setTimeout(30)
    .build();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunMeasurementOptions {
  /** Absolute path to the fixtures JSON file. wasm_path entries are resolved
   *  relative to this file's directory. */
  fixturesPath: string;
  /** Stable workspace-relative fixture path, identical in BASE and HEAD.
   * Defaults to fixturesPath relative to the current working directory.
   * A configured top-level fixture id takes precedence.
   */
  fixtureId?: string;
  gitCommit: string;
  /**
   * SDK metadata reported on every contract record.
   * Caller-supplied: when supplied, this value is used verbatim for all
   * records (the GitHub Action passes an explicitly discovered value this
   * way). When omitted, each record's `soroban_sdk_version` is discovered
   * independently from the Cargo workspace/lock owning that contract's WASM
   * artifact (see `discoverSdkVersion` in `./sdk-version`); unresolved
   * associations report `"unknown"`. Discovered metadata is best-effort
   * filesystem data: it is read from lockfiles on disk, never from RPC, and
   * does not prove how a prebuilt WASM was compiled.
   */
  sdkVersion?: string;
  /** Soroban RPC endpoint. Defaults to localhost:8000/rpc. */
  rpcUrl?: string;
  /**
   * Absolute path to a file used to persist the deployer keypair between
   * base and head runs so both use the same funded on-chain account.
   * Defaults to <fixturesDir>/.weighin-temp-key
   */
  keyFile?: string;
  /** Executable override; otherwise build the bundled pinned helper on Linux x64. */
  helperPath?: string;
  /**
   * Public key of the account that invokes the measured contract calls.
   * Defaults to the deployer account. The account only selects the invoking
   * identity of a simulated call: no key material is required and nothing is
   * signed, but the account must exist on the network. Deployment always uses
   * the deployer account.
   */
  invocationSourceAccount?: string;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
  allowCrossTargetSubstitution?: boolean;
}

const WASM_MAGIC = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

export interface ResolveWasmPathOptions {
  allowCrossTargetSubstitution?: boolean;
}

/**
 * Resolves the path to a declared WASM artifact.
 * Fails closed if the declared path does not exist, unless allowCrossTargetSubstitution
 * is explicitly enabled (or WEIGHIN_ALLOW_CROSS_TARGET_SUBSTITUTION env var is set).
 */
export function resolveWasmPath(
  fixturesDir: string,
  declaredWasmPath: string,
  options?: ResolveWasmPathOptions,
): string {
  const wasmPath = path.resolve(fixturesDir, declaredWasmPath);
  if (fs.existsSync(wasmPath)) {
    return wasmPath;
  }

  const allowOptIn =
    options?.allowCrossTargetSubstitution ??
    (process.env.WEIGHIN_ALLOW_CROSS_TARGET_SUBSTITUTION === "true" ||
      process.env.WEIGHIN_ALLOW_CROSS_TARGET_SUBSTITUTION === "1");

  if (allowOptIn) {
    let altPath = "";
    if (wasmPath.includes("wasm32-unknown-unknown")) {
      altPath = wasmPath.replace("wasm32-unknown-unknown", "wasm32v1-none");
    } else if (wasmPath.includes("wasm32v1-none")) {
      altPath = wasmPath.replace("wasm32v1-none", "wasm32-unknown-unknown");
    }
    if (altPath && fs.existsSync(altPath)) {
      console.warn(
        `Warning: declared WASM artifact not found at ${wasmPath}; substituting alternate target artifact at ${altPath}`,
      );
      return altPath;
    }
  }

  throw new Error(
    `WASM not found: ${wasmPath}\nBuild the contract before running measurements.`,
  );
}

/**
 * Validates existence, regular-file status, and WASM binary header for a single contract artifact.
 */
export function validateWasmArtifact(
  fixturesDir: string,
  declaredWasmPath: string,
  options?: ResolveWasmPathOptions,
): { resolvedPath: string } {
  const resolvedPath = resolveWasmPath(fixturesDir, declaredWasmPath, options);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err: any) {
    throw new Error(
      `WASM artifact inaccessible at ${resolvedPath}: ${err.message}`,
    );
  }

  if (!stat.isFile()) {
    throw new Error(`WASM artifact at ${resolvedPath} is not a regular file`);
  }

  const fd = fs.openSync(resolvedPath, "r");
  try {
    const buffer = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, buffer, 0, 8, 0);
    if (bytesRead < 8 || !buffer.equals(WASM_MAGIC)) {
      throw new Error(
        `Invalid WASM header at ${resolvedPath}: expected magic header \\0asm\\x01\\x00\\x00\\x00`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }

  return { resolvedPath };
}

/**
 * Preflight all contract artifacts across the fixture before initiating network operations.
 */
export function preflightContractArtifacts(
  fixturesDir: string,
  contracts: Array<{ wasm_path: string; id?: string; logical_id?: string }>,
  fixtureId: string,
  options?: ResolveWasmPathOptions,
): Map<string, string> {
  const resolvedPaths = new Map<string, string>();
  const errors: string[] = [];

  for (const contract of contracts) {
    const contractLabel =
      contract.logical_id ??
      (contract.id ? `id:${contract.id}` : `wasm:${contract.wasm_path}`);
    const context = `${fixtureId} / ${contractLabel}`;

    try {
      const { resolvedPath } = validateWasmArtifact(
        fixturesDir,
        contract.wasm_path,
        options,
      );
      resolvedPaths.set(contract.wasm_path, resolvedPath);
    } catch (err: any) {
      errors.push(`[${context}] ${err.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Preflight validation failed for configured contract WASM artifacts:\n${errors.join("\n")}`,
    );
  }

  return resolvedPaths;
}

export async function runMeasurement(
  fixturesPathOrOptions: string | RunMeasurementOptions,
  gitCommit?: string,
  sdkVersion?: string,
  rpcUrl?: string,
): Promise<ContractBenchmark[]> {
  // Support both the old positional signature and the new options object
  let opts: RunMeasurementOptions;
  if (typeof fixturesPathOrOptions === "string") {
    opts = {
      fixturesPath: fixturesPathOrOptions,
      gitCommit: gitCommit ?? "unknown",
      sdkVersion: sdkVersion,
      rpcUrl,
    };
  } else {
    opts = fixturesPathOrOptions;
  }

  if (opts.signal?.aborted) {
    throw opts.signal.reason || new Error("Measurement cancelled by caller");
  }

  const effectiveRpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const fixturesDir = path.dirname(path.resolve(opts.fixturesPath));
  const keyFile = opts.keyFile ?? path.join(fixturesDir, ".weighin-temp-key");

  const rawFixtures = fs.readFileSync(opts.fixturesPath, "utf8");
  const fixturesSpec = parseFixtures(
    rawFixtures,
    opts.fixtureId ??
      path.relative(process.cwd(), path.resolve(opts.fixturesPath)),
  );

  // Preflight every configured contract WASM BEFORE funding or deploying anything (#119, #120)
  const resolvedWasmPaths = preflightContractArtifacts(
    fixturesDir,
    fixturesSpec.contracts,
    fixturesSpec.fixture_id,
    { allowCrossTargetSubstitution: opts.allowCrossTargetSubstitution },
  );

  const server = new rpc.Server(effectiveRpcUrl, { allowHttp: true });
  const deployer = await getOrInitAccount(
    keyFile,
    effectiveRpcUrl,
    opts.signal,
  );
  const deployerAddress = Address.fromString(deployer.publicKey());

  // The invoking identity may differ from the deployer. It is validated
  // before any measurement so an invalid account fails before a snapshot.
  let invocationSourceAccount = deployer.publicKey();
  if (opts.invocationSourceAccount !== undefined) {
    invocationSourceAccount = normalizeSourceAccount(
      opts.invocationSourceAccount,
    );
    if (invocationSourceAccount !== deployer.publicKey()) {
      console.log(`Invocation source account: ${invocationSourceAccount}`);
    }
  }

  const results: ContractBenchmark[] = [];

  for (const contractSpec of fixturesSpec.contracts) {
    const wasmPath = resolvedWasmPaths.get(contractSpec.wasm_path)!;
    const wasmBytes = fs.readFileSync(wasmPath);
    const wasmHash = crypto.createHash("sha256").update(wasmBytes).digest();
    const wasmSha256 = wasmHash.toString("hex");

    console.log(`WASM: ${wasmPath}`);
    console.log(`WASM SHA256: ${wasmSha256}`);

    // Deterministic salt based on WASM hash — same WASM always gets same contract ID
    const salt = crypto.createHash("sha256").update(wasmHash).digest();
    const contractId = calculateContractId(deployer.publicKey(), salt);

    console.log(`Contract ID: ${contractId}`);
    await ensureContractDeployed({
      server,
      deployer,
      deployerAddress,
      wasmBytes,
      wasmHash,
      salt,
      contractId,
      rpcUrl: effectiveRpcUrl,
      signal: opts.signal,
    });

    const benchmarks: BenchmarkResult[] = [];

    // 3. Simulate invocations
    for (const invokeSpec of contractSpec.invocations) {
      if (opts.signal?.aborted) {
        throw (
          opts.signal.reason || new Error("Measurement cancelled by caller")
        );
      }
      console.log(`Simulating ${invokeSpec.function_name}...`);
      const invokeTx = await buildInvocationTransaction({
        server,
        sourceAccount: invocationSourceAccount,
        contractId,
        invocation: invokeSpec,
        rpcUrl: effectiveRpcUrl,
        signal: opts.signal,
      });

      const simRes = await server.simulateTransaction(invokeTx);
      if (rpc.Api.isSimulationError(simRes)) {
        throw new Error(
          `Simulation failed for ${invokeSpec.function_name}: ${simRes.error}`,
        );
      }

      if (!rpc.Api.isSimulationSuccess(simRes)) {
        throw new Error(
          `Simulation did not return transaction data for ${invokeSpec.function_name}`,
        );
      }
      const helperPath = await resolveSimulationHelper(opts.helperPath);
      const { output, provenance, limits } = await measureInvocation(
        effectiveRpcUrl,
        invokeTx,
        helperPath,
        { signal: opts.signal },
      );
      const metrics = metricsFromSimulation(output, limits);

      benchmarks.push({
        function_name: invokeSpec.function_name,
        case_id: invokeSpec.case_id,
        metrics,
        provenance,
        wasm_sha256: wasmSha256,
      });
    }

    const sorobanSdkVersion =
      opts.sdkVersion !== undefined
        ? opts.sdkVersion
        : discoverSdkVersion(wasmPath);

    results.push({
      schema_version: CURRENT_RECORD_SCHEMA_VERSION,
      fixture_id: fixturesSpec.fixture_id,
      logical_id: contractSpec.logical_id,
      contract_id: contractId,
      git_commit: opts.gitCommit,
      soroban_sdk_version: sorobanSdkVersion,
      timestamp: Math.floor(Date.now() / 1000),
      benchmarks,
    });
  }

  return results;
}

export {
  METRIC_KEYS,
  MetricKey,
  CURRENT_RECORD_SCHEMA_VERSION,
  SUPPORTED_RECORD_SCHEMA_VERSIONS,
  SUPPORTED_MEASUREMENT_ENVELOPES,
  RUNTIME_RECORD_INVARIANTS,
  MeasurementRecordValidationError,
  detectRecordEnvelopeVersion,
  inspectMeasurementRecord,
  validateMeasurementRecord,
  inspectMeasurementRecords,
  validateMeasurementRecords,
  resolveContractIdentityKey,
  validateBenchmarkComparisonCompatibility,
  getMeasurementRecordJsonSchema,
  RecordSchemaVersion,
  MeasurementEnvelopeVersion,
  RecordValidationDiagnostic,
  SingleRecordValidationResult,
  RecordValidationResult,
} from "./record-schema";
export type { SdkAssociation } from "./sdk-version";
export {
  discoverSdkAssociations,
  discoverSdkVersion,
  findOwningLock,
  formatSdkVersions,
  parseSdkVersionsFromLock,
  readSdkVersionsFromLock,
} from "./sdk-version";
