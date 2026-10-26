/**
 * Shared endpoint diagnostic policy.
 *
 * Diagnostics must never echo the configured RPC URL verbatim: the URL may
 * carry credentials in its userinfo or query string. `sanitizeEndpoint` keeps
 * the scheme, host, port and path while stripping userinfo, redacting query
 * values (keys are preserved) and dropping the fragment. Malformed input is
 * replaced with a fixed placeholder so the raw value is never printed.
 *
 * This is a shape-based redaction for display only. It does not prove that a
 * URL is secret-free and must never be used to rewrite the endpoint actually
 * used for requests.
 */

export const REDACTED_VALUE = "REDACTED";
export const INVALID_ENDPOINT = "[invalid endpoint]";

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number; result: unknown }
  | { jsonrpc: "2.0"; id: string | number; error: JsonRpcErrorObject };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate a JSON-RPC 2.0 response against the issued request ID. */
export function parseJsonRpcResponse(
  rawBody: string,
  expectedId: string | number,
): JsonRpcResponse {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new Error("Malformed JSON-RPC response: invalid JSON");
  }
  if (!isRecord(value)) {
    throw new Error("Malformed JSON-RPC response: expected an object");
  }
  if (value.jsonrpc !== "2.0") {
    throw new Error("Malformed JSON-RPC response: unsupported jsonrpc version");
  }
  if (!Object.hasOwn(value, "id") || value.id !== expectedId) {
    throw new Error(
      "Malformed JSON-RPC response: response ID does not match request",
    );
  }

  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) {
    throw new Error(
      "Malformed JSON-RPC response: expected exactly one of result or error",
    );
  }
  const allowedKeys = new Set([
    "jsonrpc",
    "id",
    hasResult ? "result" : "error",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Malformed JSON-RPC response: unexpected envelope field");
  }

  if (hasResult) {
    return value as JsonRpcResponse;
  }
  const error = value.error;
  if (
    !isRecord(error) ||
    !Number.isInteger(error.code) ||
    typeof error.message !== "string" ||
    Object.keys(error).some((key) => !["code", "message", "data"].includes(key))
  ) {
    throw new Error("Malformed JSON-RPC response: invalid error object");
  }
  return value as JsonRpcResponse;
}

export function sanitizeEndpoint(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return INVALID_ENDPOINT;
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  const params = new URLSearchParams();
  for (const key of url.searchParams.keys()) {
    params.append(key, REDACTED_VALUE);
  }
  url.search = params.toString();
  return url.toString();
}

function endpointSecrets(rawUrl: string): string[] {
  const secrets = new Set<string>();
  try {
    const url = new URL(rawUrl);
    if (url.username) secrets.add(url.username);
    if (url.password) secrets.add(url.password);
    if (url.username || url.password) {
      secrets.add(`${url.username}:${url.password}`);
    }
    for (const value of url.searchParams.values()) {
      if (value) secrets.add(value);
    }
  } catch {
    // Malformed input: `redactEndpointSecrets` still replaces the raw value.
  }
  return [...secrets].filter((secret) => secret.length > 0);
}

/** Replace any occurrence of the raw endpoint and its credential components. */
export function redactEndpointSecrets(message: string, rawUrl: string): string {
  let result = message;
  if (rawUrl) result = result.split(rawUrl).join(sanitizeEndpoint(rawUrl));
  for (const secret of endpointSecrets(rawUrl)) {
    for (const variant of new Set([secret, encodeURIComponent(secret)])) {
      result = result.split(variant).join(REDACTED_VALUE);
    }
  }
  return result;
}
