import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  parseJsonRpcResponse,
  redactEndpointSecrets,
  sanitizeEndpoint,
} from "./endpoint";

const DEADLINE_MS = 120_000;
const REQUEST_MS = 15_000;
const RETRY_MS = 2_000;
const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504]);
class TemporaryReadinessError extends Error {}

/** Confirm account inclusion through RPC; funding success alone is insufficient.
 * Only transport/timeouts and temporary HTTP failures are retried. Invalid RPC,
 * permanent funding errors and deadline exhaustion fail before measurement.
 */
export async function ensureAccountReady(
  rpcUrl: string,
  publicKey: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason || new Error("Account readiness cancelled");
  }
  let base: URL;
  try {
    base = new URL(rpcUrl);
  } catch {
    throw new Error(
      `Invalid RPC URL for account readiness: ${sanitizeEndpoint(rpcUrl)}`,
    );
  }
  base.pathname =
    base.pathname.replace(/\/rpc\/?$/, "").replace(/\/$/, "") + "/friendbot";
  base.search = "";
  base.hash = "";
  base.searchParams.set("addr", publicKey);
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: Keypair.fromPublicKey(publicKey).xdrPublicKey(),
    }),
  ).toXDR("base64");
  const deadline = Date.now() + DEADLINE_MS;
  let funded = false,
    lastError = "account has not appeared in RPC";
  let requestId = 0;
  async function request(
    url: string,
    options: RequestInit = {},
  ): Promise<string> {
    try {
      if (signal?.aborted)
        throw signal.reason || new Error("Account readiness cancelled");
      if (Date.now() >= deadline)
        throw new TemporaryReadinessError("readiness deadline elapsed");
      const timeoutSignal = AbortSignal.timeout(
        Math.max(1, Math.min(REQUEST_MS, deadline - Date.now())),
      );
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      const response = await fetch(url, {
        ...options,
        signal: combinedSignal,
      });
      if (!response.ok) {
        // Classify from headers even if the error body stalls.
        void response.body?.cancel().catch(() => {});
        const message = `HTTP ${response.status} ${response.statusText}`;
        if (TRANSIENT_HTTP.has(response.status))
          throw new TemporaryReadinessError(message);
        throw new Error(message);
      }
      return await response.text();
    } catch (error: any) {
      if (signal?.aborted)
        throw signal.reason || new Error("Account readiness cancelled");
      if (error instanceof TemporaryReadinessError) throw error;
      if (
        error instanceof TypeError ||
        ["TimeoutError", "AbortError"].includes(error?.name)
      ) {
        throw new TemporaryReadinessError(
          `transport failure at ${sanitizeEndpoint(url)}: ${redactEndpointSecrets(String(error?.message ?? error), rpcUrl)}`,
        );
      }
      throw error;
    }
  }
  while (Date.now() < deadline) {
    if (signal?.aborted)
      throw signal.reason || new Error("Account readiness cancelled");
    try {
      const id = ++requestId;
      const response = await request(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "getLedgerEntries",
          params: { keys: [key] },
        }),
      });
      let json;
      try {
        json = parseJsonRpcResponse(response, id);
      } catch (error) {
        throw new Error(
          `Account readiness invalid RPC response at ${sanitizeEndpoint(rpcUrl)}: ${redactEndpointSecrets(String((error as Error)?.message ?? error), rpcUrl)}`,
        );
      }
      if ("error" in json)
        throw new Error(
          `Account readiness RPC method error at ${sanitizeEndpoint(rpcUrl)}: ${redactEndpointSecrets(JSON.stringify(json.error), rpcUrl)}`,
        );
      const result = json.result as any;
      const entries = result?.entries;
      if (
        !Number.isInteger(result?.latestLedger) ||
        result.latestLedger <= 0 ||
        !Array.isArray(entries) ||
        entries.length > 1
      )
        throw new Error("Invalid account readiness RPC response");
      if (entries.length === 1) {
        const entry = entries[0];
        const value = xdr.LedgerEntryData.fromXDR(entry.xdr, "base64");
        if (
          entry.key !== key ||
          value.switch().name !== "account" ||
          value.account().accountId().toXDR("base64") !==
            Keypair.fromPublicKey(publicKey).xdrPublicKey().toXDR("base64")
        ) {
          throw new Error(
            "Account readiness RPC returned an unrelated account",
          );
        }
        console.log(`Deployer account confirmed in RPC: ${publicKey}`);
        return;
      }
      if (!funded) {
        console.log(`Funding deployer account: ${publicKey} via friendbot...`);
        await request(base.toString());
        funded = true;
      }
      lastError = "funded account has not appeared in RPC";
    } catch (error: any) {
      if (signal?.aborted)
        throw signal.reason || new Error("Account readiness cancelled");
      // A response body can time out after fetch has resolved.
      if (
        !(error instanceof TemporaryReadinessError) &&
        !["TimeoutError", "AbortError"].includes(error?.name)
      )
        throw error;
      lastError = error.message;
      console.warn(`Account readiness retry: ${lastError}`);
    }
    if (signal?.aborted)
      throw signal.reason || new Error("Account readiness cancelled");
    const remaining = deadline - Date.now();
    if (remaining > 0)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(RETRY_MS, remaining));
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason || new Error("Account readiness cancelled"));
          };
          if (signal.aborted) {
            clearTimeout(timer);
            return reject(
              signal.reason || new Error("Account readiness cancelled"),
            );
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
  }
  throw new Error(
    `Account readiness failed within ${DEADLINE_MS / 1000}s: ${lastError}`,
  );
}
