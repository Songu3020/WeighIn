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

export const COMMENT_MARKER = "<!-- weighin-report -->";

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
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });
  const existing = comments.find(
    (comment: { id: number; body?: string | null }) =>
      comment.body?.includes(COMMENT_MARKER),
  );
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

function escapeMarkdownText(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .replace(/`/g, "\\`");
}

function codeSpan(value: string | number | null | undefined): string {
  return `\`${String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, "\\n")}\``;
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
      return `| ⚪ | ${escapeMarkdownText(metricLabel(m))} | ${fmt(m.base.consumed)} | ${fmt(m.head.consumed)} | Unavailable | — | ${fmt(m.head.limit)} |`;
    }
    const t = trend(m.delta!);
    const label = escapeMarkdownText(metricLabel(m));
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

  return [
    `#### ${codeSpan(benchmarkLabel(fn))}`,
    "",
    ...(fn.head_provenance
      ? [
          `Compute source: ${escapeMarkdownText(fn.head_provenance.source)} ${escapeMarkdownText(fn.head_provenance.source_version)}; protocol ${escapeMarkdownText(fn.head_provenance.protocol)}.`,
          `Snapshot ledgers: BASE ${escapeMarkdownText(fn.base_provenance?.ledger)} → HEAD ${escapeMarkdownText(fn.head_provenance.ledger)}; compute config SHA256: ${codeSpan(fn.head_provenance.compute_config_sha256)}.`,
          `Full config SHA256: BASE ${codeSpan(fn.base_provenance?.config_sha256)} → HEAD ${codeSpan(fn.head_provenance.config_sha256)}.`,
          ...(fn.head_provenance.resource_limits_sha256
            ? [
                `Resource limits SHA256: ${codeSpan(fn.head_provenance.resource_limits_sha256)}.`,
              ]
            : []),
          "",
        ]
      : []),
    "| | Metric | Base | Head | Delta | Change | Limit |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...fn.metrics
      .filter((m) => m.availability === "unavailable")
      .map(
        (m) =>
          `- **${escapeMarkdownText(metricLabel(m))} unavailable**: ${escapeMarkdownText(m.reason)}`,
      ),
    ...fn.metrics
      .filter((m) => m.head.limit_source || m.head.limit_reason)
      .map(
        (m) =>
          `- **${escapeMarkdownText(METRIC_LABELS[m.key])}** source: ${codeSpan(m.head.source)}; limit: ${m.head.limit_source ? codeSpan(m.head.limit_source) : escapeMarkdownText(m.head.limit_reason)}.`,
      ),
  ].join("\n");
}

/**
 * Build a complete markdown body for a PR comment.
 */
export function renderComment(
  diff: DiffResult,
  violations: Violation[],
  baseRef: string,
  headSha: string,
): string {
  const lines: string[] = [];

  // Header
  const statusEmoji = violations.length > 0 ? "🔴" : "🟢";
  const statusText =
    violations.length > 0
      ? `**${violations.length} threshold violation${violations.length > 1 ? "s" : ""}**`
      : "**All thresholds passed**";
  lines.push(`## ${statusEmoji} WeighIn Benchmark Report`);
  lines.push("");
  lines.push(
    `${statusText} — comparing ${codeSpan(baseRef)} → ${codeSpan(headSha.slice(0, 8))}`,
  );
  lines.push("");

  // Violations block
  if (violations.length > 0) {
    lines.push("### ❌ Violations");
    lines.push("");
    for (const v of violations) {
      const measured = diff.contracts
        .find((c) => contractLabel(c) === contractLabel(v))
        ?.functions.find(
          (fn) =>
            fn.function_name === v.function_name && fn.case_id === v.case_id,
        )
        ?.metrics.find((m) => m.key === v.metric);
      lines.push(
        `- **${codeSpan(`${contractLabel(v)} / ${benchmarkLabel(v)}`)} / ${measured ? codeSpan(metricLabel(measured)) : codeSpan(METRIC_LABELS[v.metric])}**: ${escapeMarkdownText(v.message)}`,
      );
    }
    lines.push("");
  }

  // New / removed contracts
  if (diff.newContracts.length > 0) {
    lines.push(
      `> **New contracts** (no baseline): ${diff.newContracts.map((c) => codeSpan(c)).join(", ")}`,
    );
    lines.push("");
  }
  if (diff.removedContracts.length > 0) {
    lines.push(
      `> **Removed contracts**: ${diff.removedContracts.map((c) => codeSpan(c)).join(", ")}`,
    );
    lines.push("");
  }

  // Per-contract sections
  for (const contract of diff.contracts) {
    lines.push(`### Contract ${codeSpan(contractLabel(contract))}`);
    lines.push("");
    lines.push(
      `Runtime addresses: BASE ${codeSpan(contract.base_contract_id)} → HEAD ${codeSpan(contract.head_contract_id)}`,
    );
    lines.push("");

    if (contract.newBenchmarks.length > 0) {
      lines.push(
        `> New benchmarks (no baseline): ${contract.newBenchmarks.map((f) => codeSpan(benchmarkLabel(f))).join(", ")}`,
      );
      lines.push("");
    }
    if (contract.removedBenchmarks.length > 0) {
      lines.push(
        `> Removed benchmarks: ${contract.removedBenchmarks.map((f) => codeSpan(benchmarkLabel(f))).join(", ")}`,
      );
      lines.push("");
    }

    for (const fn of contract.functions) {
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
