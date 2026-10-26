# Clean checkout and npm package verification

The package is a prebuilt CLI and the existing measurement module. Its `main`
entry is `dist/measurement.js` and its `types` entry is `dist/measurement.d.ts`.
The build emits declarations for every `dist` module; test-only helpers marked
`@internal` (such as `_resetSimulationHelperState`) are stripped from them. `npm pack` runs the existing TypeScript build and
Action bundle commands through `prepack`; a checkout with no `dist` can therefore
produce a complete tarball after `npm ci`. Packing source requires the development
dependencies. Installing the resulting tarball requires only production Node
dependencies, plus the existing native/runtime prerequisites for measurement.

## From source

Use Linux x64 with Node, Rust 1.95.0, wasm32v1-none, the official Stellar CLI
28.1.0 and Docker for the pinned standalone sidecar. A fresh checkout does not
include Node dependencies, compiled JS, WASM or a native executable:

```bash
npm ci
npm test
npm run test:native
npm run build
npm run bundle
npm pack
```

The helper sources and locked dependencies are shipped with both the repository
and tarball. Default provisioning builds the helper from those sources; no copied
binary or `WEIGHIN_HELPER_PATH` is required. It needs Cargo dependency access and
permission to write the package's native target directory. The supported scope
remains Linux x64/protocol 28/standalone.

## Install the tarball locally

Create a separate consumer directory and install the actual tarball, using its
absolute path:

```bash
npm install --omit=dev /absolute/path/to/weighin-1.0.0.tgz
node -e "console.log(typeof require('weighin').runMeasurement)"
```

TypeScript consumers need no separate typings package:

```ts
import { runMeasurement, validateMeasurementRecords, type ContractBenchmark } from "weighin";
import { diffBenchmarks } from "weighin/dist/diff";
```

`tests/type-declarations.test.cjs` packs the real tarball, installs it in an
isolated consumer and compiles that consumer under `strict` with TypeScript.
It also checks that API misuse and imports of stripped internals fail to compile.

Run the installed `node_modules/.bin/weighin` executable from the benchmark
project's directory with the project's fixture path. The CLI measures existing
WASMs; build the configured artifacts first. For this repository's temporary
historical identity bridge, use the shared builder to produce both destinations,
as described in [fixture migration](fixture-migration.md). Start the pinned sidecar
with the repository's startup script after installing dependencies/building JS.
The historical migration experiment explicitly selects commit
`59db63a7b895dcc5ca763e3c668990fec40850fb`, regardless of current HEAD.

## Verification experiment

With the prerequisites on PATH and no existing `stellar-quickstart` container
(the startup script preserves unowned name collisions):

```bash
node tests/experiments/verify-clean-delivery.cjs /tmp/weighin-clean-delivery-proof
```

The harness clones committed local history into a new directory and verifies all
four artifact/dependency directories are absent. It runs the quality gates,
checks regenerated bundle consistency, creates a real npm tarball, installs it
with production dependencies in a separate directory, tests the module/bin,
builds the installed helper in a fresh target and compares a frozen snapshot
replay to saved genuine output. It then builds the reference artifacts, starts a
fresh pinned sidecar, runs the installed CLI with default helper resolution, and
reruns all four historical migration/threshold scenarios through the real bundled
Action. The installed CLI's native executable path is recorded by forwarding
observers, not overridden. Sidecar cleanup runs after live scenarios.

Rust/npm download caches may already contain dependencies. This verifies empty
build targets and clean installs on this host; it does not claim a fresh machine,
cache-free dependency downloads, public npm publication or public GitHub CI.
Private deployer keys remain in temporary runner directories.

See `docs/experiments/clean-delivery/` for baseline failures, exact command logs,
tarball contents, install/provision results, raw IO and final verification.
The baseline tarball omitted the CLI before manual build; its advertised
`dist/index.js` did not exist even after manual build. These failures are preserved
rather than counted as successful delivery checks.

## Recorded result (2026-10-08)

Clean committed source `0e8e894b669b89a73be59d25ae8862c61e03689c` passed
npm ci, all 145 behavior tests, all 15 native tests, build, bundle and committed
bundle consistency. Native tests built into a verified-empty target (8m24s).
A separate fresh checkout also packed successfully with no manual build/no prior
dist; prepack created both module and CLI entries. The 423322-byte real tarball
installed with production dependencies only and no TypeScript dependency.

The installed helper built independently from shipped source, with no executable
override/copied binary. Its frozen-state output exactly matched saved genuine
output. The installed CLI then performed two genuine schema-4 measurements on a
fresh pinned standalone sidecar, CPU 266842 each. Forwarding IO captures confirm
that both invoked the consumer package's own native executable.

The clean checkout's bundled Action ran all historical scenarios against the
fixed recorded BASE: exits 1/0/0/1; SDK upgrade CPU delta +64 remains visible;
strict control delta 0; changed-WASM/address regression delta +42329 and exit 1.
The installed Action bundle/source/lock match the executed clean checkout bytes;
the installed CLI and source-provisioned helper were directly executed. This is
local verification, not a claim of a public GitHub workflow run.

Only the generated tarball remains untracked in the experiment checkout; tracked
source/bundle are unchanged. The owned sidecar was stopped. Download caches and
host prerequisites were reused, but native and contract build targets started
empty. Historical scenarios share the freshly created contract artifact cache.
