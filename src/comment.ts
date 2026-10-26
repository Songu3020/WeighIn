import {
  DiffResult,
  FunctionDiff,
  MetricDiff,
  MetricKey,
  METRIC_KEYS,
  BenchmarkIdentity,
  contractLabel,
} from "./diff";
import { Violation, PolicyOrigin, EffectivePolicyReport } from "./threshold";

export const COMMENT_MARKER = "<!-- weighin-report -->";

export interface CommentInfo {
  id: number;
  body?: string | null;
  user?: { id?: number | null } | null;
}

export async function findReportComment(
  octokit: any,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string = COMMENT_MARKER,
  expectedAuthorId?: number,
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
    const match = comments.find((comment) => {
      const matchesMarker = comment.body?.includes(marker);
      if (!matchesMarker) return false;
      if (expectedAuthorId !== undefined) {
        return comment.user?.id === expectedAuthorId;
      }
      return true;
    });
    if (match) {
      return match;
    }
  }
  return undefined;
}

/**
 * Which identity should own the report comment.
 *
 * - `github-actions` (default): the canonical GitHub Actions bot
 *   (`github-actions[bot]`, numeric ID 41898282, type `Bot`).
 * - `authenticated-user`: the user returned by `GET /user` for the supplied
 *   token. Use this when posting with a personal-access token or a user
 *   OAuth token.
 *
 * Custom installation-token writers and arbitrary third-party GitHub App
 * identities are not supported by either mode.
 */
export type CommentAuthorMode = "github-actions" | "authenticated-user";

/** Canonical identity of the GitHub Actions bot. */
const GITHUB_ACTIONS_BOT = {
  login: "github-actions[bot]",
  id: 41898282,
  type: "Bot",
} as const;

interface ExpectedAuthor {
  id: number;
}

/**
 * Resolve the numeric user ID that is expected to own the report comment.
 *
 * For `github-actions` mode the identity is hardcoded to the canonical bot.
 * For `authenticated-user` mode the currently-authenticated user is fetched
 * via `GET /user`; if the response is missing or the ID is not a positive
 * integer the function throws an actionable error before any comment mutation.
 *
 * Throws if `mode` is not one of the two supported values.
 */
export async function resolveExpectedAuthor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  octokit: any,
  mode: CommentAuthorMode,
): Promise<ExpectedAuthor> {
  if (mode === "github-actions") {
    return { id: GITHUB_ACTIONS_BOT.id };
  }
  if (mode === "authenticated-user") {
    let data: unknown;
    try {
      const response = await octokit.rest.users.getAuthenticated();
      data = response.data;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      throw new Error(
        `comment-author-mode is "authenticated-user" but the authenticated user could not be resolved: ${message}`,
      );
    }
    const user = data as Record<string, unknown> | null | undefined;
    if (
      !user ||
      typeof user.id !== "number" ||
      !Number.isInteger(user.id) ||
      user.id <= 0
    ) {
      throw new Error(
        'comment-author-mode is "authenticated-user" but GET /user returned an unusable identity (missing or non-positive numeric id). ' +
          "Ensure the supplied token belongs to a regular user or bot account with a valid numeric ID.",
      );
    }
    return { id: user.id };
  }
  // Exhaustive check: TypeScript narrows `mode` to `never` here, but we
  // also guard at runtime for callers that bypass type checking.
  throw new Error(
    `Unsupported comment-author-mode: "${mode as string}". ` +
      'Supported values are "github-actions" and "authenticated-user".',
  );
}

/**
 * Options for `upsertPrComment`.
 */
export interface UpsertPrCommentOptions {
  /**
   * How to determine which identity owns the report comment.
   * Defaults to `"github-actions"`.
   */
  commentAuthorMode?: CommentAuthorMode;
  /**
   * Injected `@actions/core` module — used by the shared path so the caller
   * can supply its already-imported instance. Falls back to a dynamic import.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  core?: any;
}

export async function upsertPrComment(
  token: string,
  body: string,
  options?: UpsertPrCommentOptions,
): Promise<void>;
export async function upsertPrComment(
  token: string,
  prNumber: number,
  body: string,
  options?: UpsertPrCommentOptions,
): Promise<void>;
export async function upsertPrComment(
  token: string,
  numberOrBody: number | string,
  bodyOrOptions?: string | UpsertPrCommentOptions,
  maybeOptions?: UpsertPrCommentOptions,
): Promise<void> {
  const github = await import("@actions/github");

  // Disambiguate overloads
  let body: string;
  let prNumberInput: number | undefined;
  let options: UpsertPrCommentOptions;

  if (typeof numberOrBody === "number") {
    // upsertPrComment(token, prNumber, body, options?)
    prNumberInput = numberOrBody;
    body = bodyOrOptions as string;
    options = maybeOptions ?? {};
  } else {
    // upsertPrComment(token, body, options?)
    body = numberOrBody;
    prNumberInput = undefined;
    options = (bodyOrOptions as UpsertPrCommentOptions | undefined) ?? {};
  }

  const core = options.core ?? (await import("@actions/core"));
  const mode: CommentAuthorMode = options.commentAuthorMode ?? "github-actions";

  // Reject unsupported modes immediately before any mutation attempt.
  if (mode !== "github-actions" && mode !== "authenticated-user") {
    throw new Error(
      `Unsupported comment-author-mode: "${mode as string}". ` +
        'Supported values are "github-actions" and "authenticated-user".',
    );
  }

  const prNumber =
    prNumberInput !== undefined
      ? prNumberInput
      : (github.context.payload.pull_request?.number as number | undefined);

  if (!prNumber) {
    core.warning("Not in a pull_request context; skipping PR comment.");
    return;
  }

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  // Resolve expected author before touching comments.
  const expectedAuthor = await resolveExpectedAuthor(octokit, mode);

  const existing = await findReportComment(
    octokit,
    owner,
    repo,
    prNumber,
    COMMENT_MARKER,
    expectedAuthor.id,
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
    compareCodePoints(a.aggregate_id, b.aggregate_id) ||
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
  policyOrigin?: PolicyOrigin | EffectivePolicyReport,
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

  const effectivePolicy =
    policyOrigin && "status" in policyOrigin
      ? (policyOrigin as EffectivePolicyReport)
      : undefined;

  if (effectivePolicy) {
    if (effectivePolicy.status === "absent") {
      lines.push(
        "Policy status: **absent** (no policy configuration found; report-only mode).",
      );
      lines.push("");
    } else if (effectivePolicy.status === "empty") {
      lines.push(
        `Policy status: **loaded-empty** from **${effectivePolicy.mode ?? "head"}** \`${effectivePolicy.path ?? "weighin.toml"}\` at \`${effectivePolicy.revision ?? "unknown"}\`; content SHA256 \`${effectivePolicy.content_sha256 ?? ""}\` (no threshold rules configured; report-only mode).`,
      );
      lines.push("");
    } else {
      lines.push(
        `Policy source: **${effectivePolicy.mode}** \`${effectivePolicy.path}\` at \`${effectivePolicy.revision}\`; content SHA256 \`${effectivePolicy.content_sha256}\`.`,
      );
      lines.push("");
      if (effectivePolicy.rules.length > 0) {
        lines.push("<details><summary>Effective Policy Rules</summary>");
        lines.push("");
        lines.push("| Target | Metric | Effective Rule | Source |");
        lines.push("| :--- | :--- | :--- | :--- |");
        for (const r of effectivePolicy.rules) {
          lines.push(
            `| \`${r.target}\` | ${METRIC_LABELS[r.metric] ?? r.metric} | \`${r.rule}\` | ${r.source} |`,
          );
        }
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }
  } else if (policyOrigin) {
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
      if (v.aggregate_id) {
        lines.push(
          `- **\`Aggregate: ${v.aggregate_id}\` / ${METRIC_LABELS[v.metric]}**: ${v.message}`,
        );
      } else {
        const measured = diff.contracts
          .find((c) => contractLabel(c) === contractLabel(v as any))
          ?.functions.find(
            (fn) =>
              fn.function_name === v.function_name && fn.case_id === v.case_id,
          )
          ?.metrics.find((m) => m.key === v.metric);
        lines.push(
          `- **\`${contractLabel(v as any)} / ${benchmarkLabel(v as any)}\` / ${measured ? metricLabel(measured) : METRIC_LABELS[v.metric]}**: ${v.message}`,
        );
      }
    }
    lines.push("");
  }

  // Aggregate budgets section
  if (diff.aggregates && diff.aggregates.length > 0) {
    lines.push("### Aggregate Resource Budgets");
    lines.push("");
    for (const agg of diff.aggregates) {
      lines.push(
        `#### \`Aggregate: ${agg.name}\` (${agg.member_count} member${agg.member_count === 1 ? "" : "s"})`,
      );
      lines.push("");
      if (agg.description) {
        lines.push(`> ${agg.description}`);
        lines.push("");
      }
      if (agg.provenance) {
        lines.push(
          `Compute source: ${agg.provenance.source}; protocol ${agg.provenance.protocol_version}; network \`${agg.provenance.network_passphrase}\`.`,
        );
        lines.push("");
      }

      lines.push(
        "| | Metric | Base (Sum) | Head (Sum) | Delta | Change | Semantic Unit |",
      );
      lines.push("|---|---|---|---|---|---|---|");
      for (const m of agg.metrics) {
        const status =
          m.availability === "unavailable" ? "⚪" : m.regression ? "🔴" : "🟢";
        const baseStr =
          m.base_consumed === null
            ? "Unavailable"
            : m.base_consumed.toLocaleString("en-US");
        const headStr =
          m.head_consumed === null
            ? "Unavailable"
            : m.head_consumed.toLocaleString("en-US");
        const deltaStr =
          m.delta === null
            ? "Unavailable"
            : m.delta > 0
              ? `+${m.delta.toLocaleString("en-US")}`
              : m.delta.toLocaleString("en-US");
        const pctStr =
          m.pct === null
            ? m.delta !== null && m.delta > 0
              ? "+Infinity%"
              : "0.0%"
            : `${m.pct >= 0 ? "+" : ""}${m.pct.toFixed(1)}%`;

        lines.push(
          `| ${status} | ${METRIC_LABELS[m.key]} | ${baseStr} | ${headStr} | ${deltaStr} | ${pctStr} | ${m.description} |`,
        );
      }
      lines.push("");

      const unavailableMetrics = agg.metrics.filter(
        (m) => m.availability === "unavailable",
      );
      if (unavailableMetrics.length > 0) {
        for (const m of unavailableMetrics) {
          lines.push(`- **${METRIC_LABELS[m.key]} unavailable**: ${m.reason}`);
        }
        lines.push("");
      }

      // Member breakdown details
      lines.push("<details><summary>Member breakdown</summary>");
      lines.push("");
      lines.push(
        "| Member | Function | Case | CPU Instructions (Base → Head) | Memory Bytes (Base → Head) |",
      );
      lines.push("|---|---|---|---|---|");
      for (let i = 0; i < agg.member_count; i++) {
        const cpuRow = agg.breakdown.cpu_instructions[i];
        const memRow = agg.breakdown.memory_bytes[i];
        const memberName =
          cpuRow.logical_id ?? cpuRow.contract_id ?? `member-${i + 1}`;
        const cpuBase =
          cpuRow.base_consumed !== null
            ? cpuRow.base_consumed.toLocaleString("en-US")
            : "Unavailable";
        const cpuHead =
          cpuRow.head_consumed !== null
            ? cpuRow.head_consumed.toLocaleString("en-US")
            : "Unavailable";
        const memBase =
          memRow.base_consumed !== null
            ? memRow.base_consumed.toLocaleString("en-US")
            : "Unavailable";
        const memHead =
          memRow.head_consumed !== null
            ? memRow.head_consumed.toLocaleString("en-US")
            : "Unavailable";
        lines.push(
          `| \`${memberName}\` | \`${cpuRow.function_name}\` | \`${cpuRow.case_id ?? "default"}\` | ${cpuBase} → ${cpuHead} | ${memBase} → ${memHead} |`,
        );
      }
      lines.push("");
      lines.push(
        "> Note: Summed invocation memory reflects total allocation across sequential invocations, not peak concurrent memory.",
      );
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
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
