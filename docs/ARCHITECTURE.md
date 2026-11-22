# WeighIn Architecture

WeighIn is a GitHub Action and CLI for measuring Soroban contract resource
usage, comparing revisions, enforcing configured policies, and publishing a
pull request report.

## Execution pipeline

```mermaid
flowchart TD
    A[GitHub Actions starts bundled/index.js] --> B[Validate inputs, fixtures, and policy]
    B --> C[Check Soroban RPC health]
    C --> D[Keep target PR branch checked out in GITHUB_WORKSPACE]
    D --> E[Build HEAD WASM from HEAD fixtures]
    E --> F[Deploy setup contracts and WASM for HEAD]
    F --> G[Build invocation transactions]
    G --> H[Query Soroban RPC simulation]
    H --> I[Extract resource measurements and provenance]

    B --> J[Resolve the target BASE branch/ref]
    J --> K[Fetch origin and create a detached BASE worktree]
    K --> L[Read BASE fixtures from the target worktree]
    L --> M[Build BASE WASM]
    M --> N[Deploy setup contracts and WASM for BASE]
    N --> O[Build invocation transactions]
    O --> P[Query Soroban RPC simulation]
    P --> Q[Extract BASE resource measurements]

    I --> R[Pair BASE and HEAD by stable logical identity]
    Q --> R
    R --> S[Compute HEAD minus BASE metric diffs]
    S --> T[Enforce absolute limits and percentage thresholds]
    T --> U[Render Markdown report]
    U --> V[Write job summary and optional report/metadata files]
    V --> W{GitHub token configured?}
    W -->|Yes| X[Find or create the WeighIn PR comment]
    X --> Y[Update the existing report or publish a new comment]
    W -->|No| Z[Skip comment publication]
    Y --> AA{Threshold violations?}
    Z --> AA
    AA -->|Yes| AB[Fail the action]
    AA -->|No| AC[Pass the action]
```

The target branch is the PR base branch, unless `base-ref` is supplied.
WeighIn fetches that ref and creates a separate detached worktree; it does not
merge the base into the PR branch or modify the HEAD checkout. HEAD and BASE
measurements use their own fixture declarations and build artifacts. Both sets
of invocation transactions are sent to RPC simulation, not submitted as normal
benchmark writes.

The diff uses fixture, logical contract, function, and case identities. Runtime
contract addresses and WASM hashes are recorded for provenance, but they are
not the comparison key.

## Core module responsibilities

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | Parses CLI arguments and provides the standalone measurement entry point. It can measure existing fixtures, optionally compare BASE and HEAD fixture results, and emit JSON or thresholds. |
| `src/measurement.ts` | Parses and validates fixtures, prepares and deploys setup contracts, builds invocation transactions, calls the Soroban RPC/native simulation path, and converts simulation output into benchmark records and metrics. |
| `src/diff.ts` | Matches BASE and HEAD benchmark records by logical identity and calculates per-metric absolute deltas, percentages, availability, and aggregate differences. |
| `src/threshold.ts` | Loads and validates `weighin.toml`, resolves effective policy rules, and evaluates measurement diffs against global, function, or aggregate limits and thresholds. |
| `src/comment.ts` | Finds the existing WeighIn report comment, renders the Markdown report, resolves the report-author identity, and creates or updates the PR comment. |

The GitHub Actions orchestration in `src/action.ts` wires these modules together:
it validates configuration, checks out the target branch, builds and measures
both revisions, creates the diff, applies thresholds, writes outputs, and
publishes the comment.
