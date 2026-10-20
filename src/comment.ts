import {
  DiffResult,
  FunctionDiff,
  MetricDiff,
  MetricKey,
  METRIC_KEYS,
  BenchmarkIdentity,
  contractLabel,
} from "./diff";
import { Violation } from "./threshold";
import { PolicyOrigin } from "./threshold";

export const COMMENT_MARKER = "<!-- weighin-report -->";

export interface CommentInfo {
  id: number;
  body?: string | null;
}

export async function findReportComment(
  octokit: any,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string = COMMENT_MARKER,
): Promise<CommentInfo | undefined> {
  for await (const response of octokit.paginate.iterator(
    octokit.rest.issues.listComments,
    {
      owner,
      repo,
      issue_number: issueNumber,
    },
  )) {
    const comments: CommentInfo[] = response.data;
    const match = comments.find((comment) => comment.body?.includes(marker));
    if (match) {
      return match;
    }
  }
  return undefined;
}

export async function upsertPrComment(
  token: string,
  body: string,
): Promise<void>;
export async function upsertPrComment(
  token: string,
  prNumber: number,
  body: string,
): Promise<void>;
export async function upsertPrComment(
  token: string,
  numberOrBody: number | string,
  explicitBody?: string,
): Promise<void> {
  const github = await import("@actions/github");
  const core = await import("@actions/core");
  const body = typeof numberOrBody === "string" ? numberOrBody : explicitBody!;
  const prNumber =
    typeof numberOrBody === "number"
      ? numberOrBody
      : github.context.payload.pull_request?.number;
  if (!prNumber) {
    core.warning("Not in a pull_request context; skipping PR comment.");
    return;
  }
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const existing = await findReportComment(octokit, owner, repo, prNumber);
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    core.info(`Updated PR comment #${existing.id}`);
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    core.info("Created new PR comment");
  }
}

// Human-readable labels for the 11 metrics
const METRIC_LABELS: Record<MetricKey, string> = {
  cpu_instructions: "CPU Instructions",
  memory_bytes: "Memory Bytes",
  ledger_read_entries: "Footprint Entries (RO + RW)",
  ledger_read_bytes: "Disk Read Bytes",
  ledger_write_entries: "Write Footprint Entries",
  ledger_write_bytes: "Ledger Write Bytes",
  historical_data_read_bytes: "Historical Read Bytes",
  contract_data_hard_limit: "Contract Data (instance)",
  tx_size_bytes: "Tx Size Bytes",
  events_count: "Successful Contract/System Events",
  event_data_bytes: "Events + Return XDR Bytes",
};

function metricLabel(metric: MetricDiff): string {
  // Historical numeric records predate the audited semantics. Do not reinterpret
  // their old byte/count names merely because today's report renderer is newer.
  if (!metric.head.limit_source && !metric.head.limit_reason) {
    const legacy: Partial<Record<MetricKey, string>> = {
      ledger_read_entries: "Ledger Read Entries",
      ledger_read_bytes: "Ledger Read Bytes",
      ledger_write_entries: "Ledger Write Entries",
      events_count: "Events Count",
      event_data_bytes: "Event Data Bytes",
    };
    return legacy[metric.key] ?? METRIC_LABELS[metric.key];
  }
  return METRIC_LABELS[metric.key];
}

// Format a numeric value with thousands separators
function fmt(n: number | null): string {
  if (n === null) return "Unavailable";
  return n.toLocaleString("en-US");
}

// Format a delta with sign
function fmtDelta(delta: number): string {
  if (delta === 0) return "±0";
  return delta > 0 ? `+${fmt(delta)}` : fmt(delta);
}

// Format a percentage change
function fmtPct(pct: number | null): string {
  if (pct === null) return "— (BASE 0)";
  if (pct === 0) return "—";
  return pct > 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
}

// Trend emoji: regression, improvement, or unchanged
function trend(delta: number): string {
  if (delta > 0) return "🔴";
  if (delta < 0) return "🟢";
  return "⚪";
}

function benchmarkLabel(fn: BenchmarkIdentity): string {
  return fn.case_id === undefined
    ? fn.function_name
    : `${fn.function_name} / ${fn.case_id}`;
}

function renderFunctionTable(fn: FunctionDiff): string {
  const rows = fn.metrics.map((m) => {
    if (m.availability === "unavailable") {
      return `| ⚪ | ${metricLabel(m)} | ${fmt(m.base.consumed)} | ${fmt(m.head.consumed)} | Unavailable | — | ${fmt(m.head.limit)} |`;
    }
    const t = trend(m.delta!);
    const label = metricLabel(m);
    const base = fmt(m.base.consumed);
    const head = fmt(m.head.consumed);
    const delta = fmtDelta(m.delta!);
    const pct = fmtPct(m.pct);
    const limit =
      m.head.limit === null && m.head.limit_reason
        ? "No independent limit"
        : fmt(m.head.limit);
    return `| ${t} | ${label} | ${base} | ${head} | ${delta} | ${pct} | ${limit} |`;
  });

  const provenanceDetails: string[] = [];
  if (fn.head_provenance) {
    provenanceDetails.push(
      `Snapshot ledgers: BASE ${fn.base_provenance?.ledger ?? "Unavailable"} → HEAD ${fn.head_provenance.ledger}.`,
      `Compute config SHA256: BASE \`${fn.base_provenance?.compute_config_sha256 ?? "Unavailable"}\` → HEAD \`${fn.head_provenance.compute_config_sha256}\`.`,
      `Full config SHA256: BASE \`${fn.base_provenance?.config_sha256 ?? "Unavailable"}\` → HEAD \`${fn.head_provenance.config_sha256}\`.`,
      `Resource limits SHA256: BASE \`${fn.base_provenance?.resource_limits_sha256 ?? "Unavailable"}\` → HEAD \`${fn.head_provenance.resource_limits_sha256 ?? "Unavailable"}\`.`,
      `Helper SHA256: BASE \`${fn.base_provenance?.helper_sha256 ?? "Unavailable"}\` → HEAD \`${fn.head_provenance.helper_sha256}\`.`,
    );
  }
  provenanceDetails.push(
    ...fn.metrics
      .filter(
        (m) => m.head.source || m.head.limit_source || m.head.limit_reason,
      )
      .map(
        (m) =>
          `- **${METRIC_LABELS[m.key]}** source: ${m.head.source ? `\`${m.head.source}\`` : "Unavailable"}; limit: ${m.head.limit_source ? `\`${m.head.limit_source}\`` : (m.head.limit_reason ?? "Unavailable")}.`,
      ),
  );

  return [
    `#### \`${benchmarkLabel(fn)}\``,
    "",
    ...(fn.head_provenance
      ? [
          `Compute source: ${fn.head_provenance.source} ${fn.head_provenance.source_version}; protocol ${fn.head_provenance.protocol}.`,
          "",
        ]
      : []),
    "| | Metric | Base | Head | Delta | Change | Limit |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...fn.metrics
      .filter((m) => m.availability === "unavailable")
      .map((m) => `- **${metricLabel(m)} unavailable**: ${m.reason}`),
    ...(provenanceDetails.length > 0
      ? [
          "",
          "<details><summary>Snapshot and metric provenance</summary>",
          "",
          ...provenanceDetails,
          "",
          "</details>",
        ]
      : []),
  ].join("\n");
}

function compareCodePoints(a?: string, b?: string): number {
  const sa = a ?? "";
  const sb = b ?? "";
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function compareContracts(a: any, b: any): number {
  return (
    compareCodePoints(a.fixture_id, b.fixture_id) ||
    compareCodePoints(a.logical_id, b.logical_id) ||
    compareCodePoints(a.contract_id, b.contract_id)
  );
}

function compareBenchmarkIdentities(
  a: BenchmarkIdentity,
  b: BenchmarkIdentity,
): number {
  return (
    compareCodePoints(a.function_name, b.function_name) ||
    compareCodePoints(a.case_id, b.case_id)
  );
}

function compareFunctions(a: FunctionDiff, b: FunctionDiff): number {
  return (
    compareCodePoints(a.function_name, b.function_name) ||
    compareCodePoints(a.case_id, b.case_id)
  );
}

function compareViolations(a: Violation, b: Violation): number {
  return (
    compareCodePoints(a.fixture_id, b.fixture_id) ||
    compareCodePoints(a.logical_id, b.logical_id) ||
    compareCodePoints(a.contract_id, b.contract_id) ||
    compareCodePoints(a.function_name, b.function_name) ||
    compareCodePoints(a.case_id, b.case_id) ||
    compareCodePoints(a.metric, b.metric)
  );
}

/**
 * Build a complete markdown body for a PR comment.
 */
export function renderComment(
  diff: DiffResult,
  violations: Violation[],
  baseRef: string,
  headSha: string,
  policyOrigin?: PolicyOrigin,
): string {
  const lines: string[] = [];

  // Sort violations without mutating input
  const sortedViolations = [...violations].sort(compareViolations);

  // Header
  const statusEmoji = sortedViolations.length > 0 ? "🔴" : "🟢";
  const statusText =
    sortedViolations.length > 0
      ? `**${sortedViolations.length} threshold violation${sortedViolations.length > 1 ? "s" : ""}**`
      : "**All thresholds passed**";
  lines.push(`## ${statusEmoji} WeighIn Benchmark Report`);
  lines.push("");
  if (policyOrigin) {
    lines.push(
      `Policy source: **${policyOrigin.mode}** \`${policyOrigin.path}\` at \`${policyOrigin.revision}\`; content SHA256 \`${policyOrigin.content_sha256}\`.`,
    );
    lines.push("");
  }
  lines.push(
    `${statusText} — comparing \`${baseRef}\` → \`${headSha.slice(0, 8)}\``,
  );
  lines.push("");

  // Violations block
  if (sortedViolations.length > 0) {
    lines.push("### ❌ Violations");
    lines.push("");
    for (const v of sortedViolations) {
      const measured = diff.contracts
        .find((c) => contractLabel(c) === contractLabel(v))
        ?.functions.find(
          (fn) =>
            fn.function_name === v.function_name && fn.case_id === v.case_id,
        )
        ?.metrics.find((m) => m.key === v.metric);
      lines.push(
        `- **\`${contractLabel(v)} / ${benchmarkLabel(v)}\` / ${measured ? metricLabel(measured) : METRIC_LABELS[v.metric]}**: ${v.message}`,
      );
    }
    lines.push("");
  }

  // New / removed contracts (sorted copies)
  const sortedNewContracts = [...diff.newContracts].sort(compareCodePoints);
  const sortedRemovedContracts = [...diff.removedContracts].sort(
    compareCodePoints,
  );

  if (sortedNewContracts.length > 0) {
    lines.push(
      `> **New contracts** (no baseline): ${sortedNewContracts.map((c) => `\`${c}\``).join(", ")}`,
    );
    lines.push("");
  }
  if (sortedRemovedContracts.length > 0) {
    lines.push(
      `> **Removed contracts**: ${sortedRemovedContracts.map((c) => `\`${c}\``).join(", ")}`,
    );
    lines.push("");
  }

  // Per-contract sections (sorted copy)
  const sortedContracts = [...diff.contracts].sort(compareContracts);
  for (const contract of sortedContracts) {
    lines.push(`### Contract \`${contractLabel(contract)}\``);
    lines.push("");
    lines.push(
      `Runtime addresses: BASE \`${contract.base_contract_id}\` → HEAD \`${contract.head_contract_id}\``,
    );
    lines.push("");

    const sortedNewBenchmarks = [...contract.newBenchmarks].sort(
      compareBenchmarkIdentities,
    );
    const sortedRemovedBenchmarks = [...contract.removedBenchmarks].sort(
      compareBenchmarkIdentities,
    );

    if (sortedNewBenchmarks.length > 0) {
      lines.push(
        `> New benchmarks (no baseline): ${sortedNewBenchmarks.map((f) => `\`${benchmarkLabel(f)}\``).join(", ")}`,
      );
      lines.push("");
    }
    if (sortedRemovedBenchmarks.length > 0) {
      lines.push(
        `> Removed benchmarks: ${sortedRemovedBenchmarks.map((f) => `\`${benchmarkLabel(f)}\``).join(", ")}`,
      );
      lines.push("");
    }

    const sortedFunctions = [...contract.functions].sort(compareFunctions);
    for (const fn of sortedFunctions) {
      lines.push(renderFunctionTable(fn));
      lines.push("");
    }
  }

  // Known limitations footer
  lines.push("---");
  lines.push("");
  lines.push("<details><summary>Known measurement gaps</summary>");
  lines.push("");
  lines.push(
    "- **Unavailable metrics** are shown explicitly; configured policies requiring them fail.",
  );
  lines.push(
    "- **Compute** uses protocol-matched native simulation and captured network cost settings.",
  );
  lines.push(
    "- **WASM build determinism**: cross-CI-run hash equality has not yet been verified",
  );
  lines.push(
    "  in two separate GitHub Actions runs. Snapshot repeatability does not prove build repeatability.",
  );
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push(COMMENT_MARKER);

  return lines.join("\n");
}
