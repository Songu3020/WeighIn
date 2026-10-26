// Controlled transport for endpoint-redaction tests. No live network is used:
// every request is intercepted, its exact URL recorded, and a deterministic
// failure returned so entry points stop before any real work.
const fs = require("node:fs");

const capturePath = process.env.WEIGHIN_ENDPOINT_CAPTURE;

globalThis.fetch = async (url, options) => {
  const target = typeof url === "string" ? url : url?.url ?? String(url);
  if (capturePath) {
    fs.appendFileSync(
      capturePath,
      `${JSON.stringify({
        url: target,
        method: options?.method ?? "GET",
      })}\n`,
    );
  }
  if (process.env.WEIGHIN_ENDPOINT_MODE === "json-error") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "synthetic controlled failure" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response("controlled failure", {
    status: 400,
    statusText: "Bad Request",
  });
};
