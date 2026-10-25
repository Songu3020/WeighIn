import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  renderComment,
  findReportComment,
  upsertPrComment,
  COMMENT_MARKER,
} from "../src/comment";
import { DiffResult } from "../src/diff";
import { Violation } from "../src/threshold";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

function createMockDiff(regression: boolean): DiffResult {
  return {
    contracts: [
      {
        fixture_id: "path:fixtures.json",
        logical_id: "id:contract-a",
        contract_id: "contract-a",
        base_contract_id: "base-contract-a",
        head_contract_id: "contract-a",
        base_commit: "abc",
        head_commit: "def",
        hasRegression: regression,
        newFunctions: [],
        removedFunctions: [],
        newBenchmarks: [],
        removedBenchmarks: [],
        functions: [
          {
            function_name: "test-fn",
            hasRegression: regression,
            metrics: [
              {
                key: "cpu_instructions",
                base: { consumed: 100, limit: 1000 },
                head: { consumed: regression ? 110 : 100, limit: 1000 },
                delta: regression ? 10 : 0,
                pct: regression ? 10 : 0,
                regression,
              },
            ],
          },
        ],
      },
    ],
    hasRegression: regression,
    newContracts: [],
    removedContracts: [],
  };
}

describe("renderComment", () => {
  it("renders a success status when no regressions and no violations", () => {
    const diff = createMockDiff(false);
    const comment = renderComment(diff, [], "main", "abcdef123");
    expect(comment).toContain("🟢");
    expect(comment).toContain("**All thresholds passed**");
  });

  it("renders a success status when there are regressions but no threshold violations", () => {
    const diff = createMockDiff(true);
    const comment = renderComment(diff, [], "main", "abcdef123");
    expect(comment).toContain("🟢");
    expect(comment).toContain("**All thresholds passed**");
    expect(comment).toContain(
      "🔴 | CPU Instructions | 100 | 110 | +10 | +10.0% | 1,000 |",
    );
  });

  it("renders a failure status when threshold violations exist", () => {
    const diff = createMockDiff(true);
    const violation: Violation = {
      contract_id: "contract-a",
      function_name: "test-fn",
      metric: "cpu_instructions",
      delta: 10,
      pct: 10,
      rule: "strict_zero_tolerance",
      message: "Fail msg",
    };
    const comment = renderComment(diff, [violation], "main", "abcdef123");
    expect(comment).toContain("🔴");
    expect(comment).toContain("**1 threshold violation**");
    expect(comment).toContain("### ❌ Violations");
    expect(comment).toContain("Fail msg");
  });

  it("keeps primary evidence visible and folds verbose provenance into details", () => {
    const diff = createMockDiff(true);
    const fn = diff.contracts[0].functions[0];
    fn.case_id = "args:[]";
    fn.base_provenance = {
      source: "soroban-simulation",
      source_version: "28.0.1",
      protocol: 28,
      helper_sha256: "a".repeat(64),
      network_id: "test-network",
      ledger: 229,
      header_sha256: "b".repeat(64),
      snapshot_sha256: "c".repeat(64),
      config_sha256: "d".repeat(64),
      compute_config_sha256: "e".repeat(64),
      input_sha256: "f".repeat(64),
      seed: [],
      auth_mode: "recording",
      host_features: [],
      resource_limits_sha256: "1".repeat(64),
    };
    fn.head_provenance = {
      ...fn.base_provenance,
      ledger: 230,
      helper_sha256: "2".repeat(64),
      snapshot_sha256: "3".repeat(64),
      config_sha256: "4".repeat(64),
      compute_config_sha256: "5".repeat(64),
      input_sha256: "6".repeat(64),
      resource_limits_sha256: "7".repeat(64),
    };
    fn.metrics[0].head.source = "simulated_instructions";
    fn.metrics[0].head.limit_source = "protocol_limit";
    fn.metrics.push({
      key: "memory_bytes",
      base: { consumed: null, limit: null, reason: "Unavailable in BASE" },
      head: {
        consumed: null,
        limit: null,
        reason: "Unsupported by this simulator",
        source: "native-memory-meter",
        limit_reason: "No independent cap",
      },
      availability: "unavailable",
      reason: "BASE: Unavailable in BASE; HEAD: Unsupported by this simulator",
      delta: null,
      pct: null,
      regression: false,
    });

    const report = renderComment(
      diff,
      [
        {
          contract_id: "contract-a",
          function_name: "test-fn",
          case_id: "args:[]",
          metric: "cpu_instructions",
          delta: 10,
          pct: 10,
          rule: "strict_zero_tolerance",
          message: "CPU policy breach",
        },
      ],
      "main",
      "abcdef123",
    );
    const detailsStart = report.indexOf(
      "<details><summary>Snapshot and metric provenance</summary>",
    );
    const detailsEnd = report.indexOf("</details>", detailsStart);
    const beforeDetails = report.slice(0, detailsStart);
    const details = report.slice(detailsStart, detailsEnd);

    expect(detailsStart).toBeGreaterThan(0);
    expect(detailsEnd).toBeGreaterThan(detailsStart);
    expect(beforeDetails).toContain(
      "Compute source: soroban-simulation 28.0.1; protocol 28.",
    );
    expect(beforeDetails).toContain("CPU policy breach");
    expect(beforeDetails).toContain(
      "| 🔴 | CPU Instructions | 100 | 110 | +10 | +10.0% | 1,000 |",
    );
    expect(beforeDetails).toContain("Unsupported by this simulator");
    expect(details).toContain("Snapshot ledgers: BASE 229 → HEAD 230.");
    expect(details).toContain("No independent cap");
    expect(details).toContain(
      `Helper SHA256: BASE \`${"a".repeat(64)}\` → HEAD \`${"2".repeat(64)}\`.`,
    );
    expect(details).toContain("simulated_instructions");
    expect(details).toContain("native-memory-meter");
  });

  it("renders legacy records without provenance as a normal Markdown table", () => {
    const report = renderComment(
      createMockDiff(false),
      [],
      "main",
      "abcdef123",
    );
    expect(report).toContain(
      "| | Metric | Base | Head | Delta | Change | Limit |",
    );
    expect(report).toContain("#### `test-fn`");
    expect(report).not.toContain("Snapshot and metric provenance");
    expect(report).toContain("<!-- weighin-report -->");
  });

  it("formats missing functions and contracts", () => {
    const diff = createMockDiff(false);
    diff.newContracts.push("new-contract");
    diff.removedContracts.push("old-contract");
    diff.contracts[0].newBenchmarks.push({
      function_name: "new-fn",
      case_id: "args:[]",
    });
    diff.contracts[0].removedBenchmarks.push({
      function_name: "old-fn",
      case_id: "args:[]",
    });

    const comment = renderComment(diff, [], "main", "abcdef123");
    expect(comment).toContain("new-contract");
    expect(comment).toContain("old-contract");
    expect(comment).toContain("new-fn");
    expect(comment).toContain("old-fn");
  });

  it("renders byte-identical output for equivalent reordered contracts and functions without mutating inputs", () => {
    const fn1 = {
      function_name: "alpha_fn",
      case_id: "id:case-1",
      hasRegression: false,
      metrics: [
        {
          key: "cpu_instructions" as const,
          base: { consumed: 100, limit: 1000 },
          head: { consumed: 100, limit: 1000 },
          delta: 0,
          pct: 0,
          regression: false,
        },
      ],
    };
    const fn2 = {
      function_name: "beta_fn",
      case_id: "id:case-2",
      hasRegression: false,
      metrics: [
        {
          key: "cpu_instructions" as const,
          base: { consumed: 200, limit: 1000 },
          head: { consumed: 200, limit: 1000 },
          delta: 0,
          pct: 0,
          regression: false,
        },
      ],
    };

    const contractA = {
      fixture_id: "path:fixtures-a.json",
      logical_id: "id:contract-a",
      contract_id: "CAAA",
      base_contract_id: "base-CAAA",
      head_contract_id: "CAAA",
      base_commit: "abc",
      head_commit: "def",
      hasRegression: false,
      newFunctions: [],
      removedFunctions: [],
      newBenchmarks: [
        { function_name: "new_b", case_id: "id:1" },
        { function_name: "new_a", case_id: "id:1" },
      ],
      removedBenchmarks: [
        { function_name: "rem_b", case_id: "id:1" },
        { function_name: "rem_a", case_id: "id:1" },
      ],
      functions: [fn2, fn1],
    };

    const contractB = {
      fixture_id: "path:fixtures-b.json",
      logical_id: "id:contract-b",
      contract_id: "CBBB",
      base_contract_id: "base-CBBB",
      head_contract_id: "CBBB",
      base_commit: "abc",
      head_commit: "def",
      hasRegression: false,
      newFunctions: [],
      removedFunctions: [],
      newBenchmarks: [],
      removedBenchmarks: [],
      functions: [fn1],
    };

    const diff1: DiffResult = {
      contracts: [contractB, contractA],
      hasRegression: false,
      newContracts: ["zeta_contract", "alpha_contract"],
      removedContracts: ["theta_contract", "beta_contract"],
    };

    const diff2: DiffResult = {
      contracts: [
        {
          ...contractA,
          newBenchmarks: [
            { function_name: "new_a", case_id: "id:1" },
            { function_name: "new_b", case_id: "id:1" },
          ],
          removedBenchmarks: [
            { function_name: "rem_a", case_id: "id:1" },
            { function_name: "rem_b", case_id: "id:1" },
          ],
          functions: [fn1, fn2],
        },
        contractB,
      ],
      hasRegression: false,
      newContracts: ["alpha_contract", "zeta_contract"],
      removedContracts: ["beta_contract", "theta_contract"],
    };

    const violations1: Violation[] = [
      {
        contract_id: "CAAA",
        function_name: "beta_fn",
        metric: "memory_bytes",
        delta: 5,
        pct: 5,
        rule: "strict_zero_tolerance",
        message: "viol 2",
      },
      {
        contract_id: "CAAA",
        function_name: "alpha_fn",
        metric: "cpu_instructions",
        delta: 10,
        pct: 10,
        rule: "strict_zero_tolerance",
        message: "viol 1",
      },
    ];

    const violations2: Violation[] = [violations1[1], violations1[0]];

    const comment1 = renderComment(diff1, violations1, "main", "abcdef123");
    const comment2 = renderComment(diff2, violations2, "main", "abcdef123");

    expect(comment1).toBe(comment2);

    // Verify inputs were not mutated
    expect(diff1.contracts[0].contract_id).toBe("CBBB");
    expect(violations1[0].function_name).toBe("beta_fn");
  });
});

describe("findReportComment unit tests", () => {
  function createMockOctokit(
    pages: Array<Array<{ id: number; body?: string | null }>>,
    failOnPage?: number,
  ) {
    const requestedPages: number[] = [];
    return {
      requestedPages,
      rest: {
        issues: {
          listComments: () => {},
        },
      },
      paginate: {
        iterator: async function* () {
          for (let i = 0; i < pages.length; i++) {
            requestedPages.push(i + 1);
            if (failOnPage === i + 1) {
              throw new Error(`Simulated API failure on page ${i + 1}`);
            }
            yield { data: pages[i] };
          }
        },
      },
    };
  }

  it("finds comment on page 2 and stops traversing before page 3", async () => {
    const mock = createMockOctokit([
      [{ id: 1, body: "Discussion item 1" }],
      [{ id: 2, body: `Report: ${COMMENT_MARKER}` }],
      [{ id: 3, body: "Discussion item 2" }],
    ]);
    const comment = await findReportComment(mock, "owner", "repo", 42);
    expect(comment?.id).toBe(2);
    expect(mock.requestedPages).toEqual([1, 2]);
  });

  it("reaches exhaustion across all pages when no marker exists", async () => {
    const mock = createMockOctokit([
      [{ id: 1, body: "Comment 1" }],
      [{ id: 2, body: "Comment 2" }],
      [{ id: 3, body: "Comment 3" }],
    ]);
    const comment = await findReportComment(mock, "owner", "repo", 42);
    expect(comment).toBeUndefined();
    expect(mock.requestedPages).toEqual([1, 2, 3]);
  });

  it("traverses past an empty first page and finds marker on page 2", async () => {
    const mock = createMockOctokit([
      [],
      [{ id: 20, body: `Previous run: ${COMMENT_MARKER}` }],
    ]);
    const comment = await findReportComment(mock, "owner", "repo", 42);
    expect(comment?.id).toBe(20);
    expect(mock.requestedPages).toEqual([1, 2]);
  });

  it("preserves selection of the first matching marker on a page with multiple markers", async () => {
    const mock = createMockOctokit([
      [
        { id: 11, body: `First: ${COMMENT_MARKER}` },
        { id: 12, body: `Second: ${COMMENT_MARKER}` },
      ],
      [{ id: 13, body: `Third: ${COMMENT_MARKER}` }],
    ]);
    const comment = await findReportComment(mock, "owner", "repo", 42);
    expect(comment?.id).toBe(11);
    expect(mock.requestedPages).toEqual([1]);
  });

  it("propagates API failure during pagination without suppressing error", async () => {
    const mock = createMockOctokit(
      [[{ id: 1, body: "Comment 1" }], [{ id: 2, body: "Comment 2" }]],
      2,
    );
    await expect(findReportComment(mock, "owner", "repo", 42)).rejects.toThrow(
      "Simulated API failure on page 2",
    );
    expect(mock.requestedPages).toEqual([1, 2]);
  });
});

describe("upsertPrComment public API with paginated transport", () => {
  interface RecordedCall {
    method: string;
    url: string;
    body?: any;
    commentId?: number;
  }

  let server: http.Server;
  const calls: RecordedCall[] = [];
  let origUrl: string | undefined;
  let origRepo: string | undefined;

  beforeAll(async () => {
    origUrl = process.env.GITHUB_API_URL;
    origRepo = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_REPOSITORY = "WeighInNG/WeighIn";

    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const url = new URL(
          req.url || "/",
          `http://${req.headers.host || "127.0.0.1"}`,
        );
        const parsedBody = raw ? JSON.parse(raw) : undefined;

        // PR 91: page 2 contains report
        if (url.pathname === "/repos/WeighInNG/WeighIn/issues/91/comments") {
          if (req.method === "GET") {
            const page = parseInt(url.searchParams.get("page") || "1", 10);
            calls.push({ method: "GET", url: req.url || "" });
            if (page === 1) {
              res.writeHead(200, {
                "content-type": "application/json",
                link: `<http://${req.headers.host}${url.pathname}?page=2>; rel="next"`,
                connection: "close",
              });
              res.end(
                JSON.stringify([{ id: 101, body: "Non-marker comment" }]),
              );
            } else {
              res.writeHead(200, {
                "content-type": "application/json",
                connection: "close",
              });
              res.end(
                JSON.stringify([
                  {
                    id: 102,
                    body: `Existing report ${COMMENT_MARKER}`,
                    user: { id: 41898282 },
                  },
                ]),
              );
            }
            return;
          }
        }

        // PR 92: exhaustion without report
        if (url.pathname === "/repos/WeighInNG/WeighIn/issues/92/comments") {
          if (req.method === "GET") {
            const page = parseInt(url.searchParams.get("page") || "1", 10);
            calls.push({ method: "GET", url: req.url || "" });
            if (page === 1) {
              res.writeHead(200, {
                "content-type": "application/json",
                link: `<http://${req.headers.host}${url.pathname}?page=2>; rel="next"`,
                connection: "close",
              });
              res.end(JSON.stringify([{ id: 201, body: "Page 1 non-marker" }]));
            } else {
              res.writeHead(200, {
                "content-type": "application/json",
                connection: "close",
              });
              res.end(JSON.stringify([{ id: 202, body: "Page 2 non-marker" }]));
            }
            return;
          }
          if (req.method === "POST") {
            calls.push({
              method: "POST",
              url: req.url || "",
              body: parsedBody,
            });
            res.writeHead(201, {
              "content-type": "application/json",
              connection: "close",
            });
            res.end(JSON.stringify({ id: 999, body: parsedBody?.body }));
            return;
          }
        }

        // PR 93: failure on GET
        if (url.pathname === "/repos/WeighInNG/WeighIn/issues/93/comments") {
          if (req.method === "GET") {
            calls.push({ method: "GET", url: req.url || "" });
            res.writeHead(500, {
              "content-type": "application/json",
              connection: "close",
            });
            res.end(JSON.stringify({ message: "Simulated upstream failure" }));
            return;
          }
        }

        // Comment update
        const match = url.pathname.match(
          /^\/repos\/WeighInNG\/WeighIn\/issues\/comments\/(\d+)$/,
        );
        if (match && req.method === "PATCH") {
          const commentId = parseInt(match[1], 10);
          calls.push({
            method: "PATCH",
            url: req.url || "",
            commentId,
            body: parsedBody,
          });
          res.writeHead(200, {
            "content-type": "application/json",
            connection: "close",
          });
          res.end(JSON.stringify({ id: commentId, body: parsedBody?.body }));
          return;
        }

        res.writeHead(400, { connection: "close" });
        res.end("Unexpected test API request");
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as any).port;
    process.env.GITHUB_API_URL = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    process.env.GITHUB_API_URL = origUrl;
    process.env.GITHUB_REPOSITORY = origRepo;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("updates report on page 2 without creating a new comment", async () => {
    calls.length = 0;
    await upsertPrComment(
      "test-token",
      91,
      `New report body ${COMMENT_MARKER}`,
    );
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(calls[2].commentId).toBe(102);
    expect(calls[2].body.body).toBe(`New report body ${COMMENT_MARKER}`);
  });

  it("reaches exhaustion before creating a new report when no marker exists", async () => {
    calls.length = 0;
    await upsertPrComment("test-token", 92, `Created report ${COMMENT_MARKER}`);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
    expect(calls[2].body.body).toBe(`Created report ${COMMENT_MARKER}`);
  });

  it("fails closed on API error without creating or updating comment", async () => {
    calls.length = 0;
    await expect(
      upsertPrComment("test-token", 93, `Report ${COMMENT_MARKER}`),
    ).rejects.toThrow();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});

describe("bundled entry points consistency", () => {
  it("bundled/index.js and bundled/comment-action.js use shared paginated lookup", () => {
    const root = path.resolve(__dirname, "..");
    const bundledAction = fs.readFileSync(
      path.join(root, "bundled/index.js"),
      "utf8",
    );
    const bundledCommentAction = fs.readFileSync(
      path.join(root, "bundled/comment-action.js"),
      "utf8",
    );

    // Both bundles must include the paginated iterator
    expect(bundledAction).toContain("paginate.iterator");
    expect(bundledCommentAction).toContain("paginate.iterator");

    // Both bundles must use the shared findReportComment logic
    expect(bundledAction).toContain("findReportComment");
    expect(bundledCommentAction).toContain("findReportComment");
  });
});
