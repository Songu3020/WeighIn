# Contract build path

The Action builds both revisions with `stellar contract build`, using locked
dependencies and optimization. It requires Stellar CLI **28.1+**, Rust **1.84+**,
and the installed `wasm32v1-none` target. The verified reference uses Stellar CLI
28.1.0 (official release archive with SHA256 verification), Rust 1.95.0, and
Soroban SDK 28.0.0 with its checked-in Cargo.lock. SDK-specific Rust requirements
can be higher than the target's minimum; Cargo reports them as build errors.

Stellar's [Rust dialect guidance](https://developers.stellar.org/docs/learn/fundamentals/contract-development/rust-dialect)
requires the modern target on current Rust. [SDK 28 release notes](https://github.com/stellar/rs-soroban-sdk/releases/tag/v28.0.0)
require the Stellar build system for specification shaking. The
[pinned CLI implementation](https://github.com/stellar/stellar-cli/blob/v28.1.0/cmd/soroban-cli/src/commands/contract/build.rs)
selects the target, filters specifications, injects metadata and optimizes its
output. WeighIn fails if the CLI reports skipped optimization; it does not fall
back to plain Cargo or the older target.

## Artifact selection and workspace boundary

The builder API (`buildContracts`) requires an explicit allowed workspace root.
For each declared `wasm_path`, WeighIn validates that the resolved destination path
remains strictly within the allowed workspace root, rejecting relative traversal
escapes (`..`) and symlinks resolving outside the root before executing any commands
or writing any artifacts.

Manifest search ascends from the declared WASM destination toward the workspace root
to locate the nearest owning `Cargo.toml`. Search stops at the workspace root boundary
and never ascends past it to parent directories or filesystem root. Nested legitimate
Cargo workspaces within the workspace root are fully supported. The WASM basename must
identify exactly one workspace `cdylib` target using its Cargo target name (falling back
to the package name when Cargo omits the target name). A package named
`my-package` with `[lib] name = "contract-library"` emits
`contract_library.wasm`. Packages with multiple `cdylib` targets are rejected
before compilation because the target output is ambiguous. Unknown/ambiguous
names, missing manifests and build failures are errors. All declarations are
resolved before builds start; unrelated workspace packages are not selected.
Multiple declarations of one package share one build.

Cargo workspace metadata (`cargo metadata --no-deps --locked --format-version 1`)
is parsed and validated against a schema before selecting packages. WeighIn
verifies that package IDs, names, manifest paths, target crate types, and workspace
members conform to the expected shape, rejecting foreign workspace members,
malformed targets, and nonexistent manifest paths with actionable diagnostics, while
maintaining compatibility with valid version-1 metadata and unknown harmless fields.

For each selected package, WeighIn probes the effective compiler compatibility
within the distinct directory context of that package's manifest (`path.dirname(pkg.manifest_path)`),
verifying Rust 1.84+ for each crate context. This ensures that any crate-local
`rust-toolchain` or override configuration is evaluated in its proper directory context
and rejected before building if incompatible. Explicit toolchain overrides passed via
`rustToolchain` supply `RUSTUP_TOOLCHAIN` to both the compiler probe and build commands.

All normalized destination paths are preflighted before any build commands or
file writes. If multiple declarations resolve to the same canonical destination
through path normalization or directory symlinks, they are permitted only when
package ownership agrees (same package identity and manifest path); conflicting
declarations targeting the same destination from different packages fail immediately.
When repeated declarations target the same destination, WeighIn writes the artifact
once and verifies that subsequent declarations produce byte-for-byte identical output.

Each package builds into a fresh temporary output directory:

```text
stellar contract build --manifest-path <manifest> --package <package> --locked --optimize=true --out-dir <temporary-directory>
```

Both revisions use the caller's selected temporary-storage root (`TMPDIR` on
Unix, or the platform's normal temporary directory). Each default build creates
an owned child directory and supplies it as `TMPDIR`, `TMP`, and `TEMP` to the
Stellar CLI, so optimizer convergence files use the same verified storage as the
fresh output. WeighIn performs a write, fsync, close and byte-for-byte read check
before invoking the build, and repeats it before accepting the output. The probe
is at least 1 MiB and grows to the output size for the final check. Storage errors,
truncated probe contents and directory-creation failures stop the build. Owned
build directories are cleaned on success and failure; caller environment variables
are unchanged. There is no automatic fallback to another filesystem.

This protects against the persistent quota failure reproduced in the
[optimizer investigation](optimizer-repeatability.md). The probes do not reserve
capacity for Cargo or prove that a transient storage failure cannot occur only
during optimization. Provide sufficient healthy temporary storage for the entire
run, and use the same environment/toolchain for both revisions. No portable or
cold-build determinism guarantee is implied.

WeighIn verifies the fresh output's WASM header, then copies it to the configured
fixture path. An old artifact at that path cannot substitute for absent or failed
build output. Build result records retain each manifest/package; logs record the
artifact path, package, SHA256 and actual Rust/Stellar versions. Cargo caches may still be used; this is not a claim
of clean-build reproducibility.

The existing `rust-toolchain` Action input now supplies `RUSTUP_TOOLCHAIN` to
contract-build commands for both revisions. Omitted input preserves Rustup's
normal per-revision resolution. The native simulation helper retains its own
explicit Rust 1.95.0 toolchain. Tool installation remains the caller's duty; both
repository workflows include the verified Stellar CLI installation and target.
The default path uses the Stellar CLI. An explicitly supplied `build-command`
remains an escape hatch for projects with a different build process; WeighIn runs
it in each revision's own worktree. `skip-build: true` uses the fixture paths as
prebuilt artifacts. The `skip-build` input parses standard YAML 1.2 boolean spellings
(`true`, `True`, `TRUE`, `false`, `False`, `FALSE`) and defaults to `false` when omitted;
non-boolean values are rejected before starting Action work. These overrides bypass
the default builder's CLI/version, optimization and fresh-output checks, so their caller
owns those guarantees.

## Reference commands

After installing the official Stellar CLI release and Rust 1.95.0:

```bash
rustup target add wasm32v1-none --toolchain 1.95.0
stellar contract build --manifest-path contract/Cargo.toml --locked --optimize=true
npm ci
npm test
npm run test:native
npm run bundle
```

The reference artifact is
`contract/target/wasm32v1-none/release/contract_test.wasm`. The CLI measurement
command still consumes an existing artifact; the Action performs the two builds.

## Migration and limits

The reference fixture path changed with the target. Existing fallback logical
identities include the declared path, so old/new target paths are different
benchmark identities. Use the same explicit fixture/contract/case IDs in **both**
revisions before relocating an established benchmark, or establish a new baseline
at the migrated revision. Adding an ID only in HEAD cannot retroactively rename
BASE. An entirely unmatched migration comparison fails closed; it does not
silently pair filenames. The reference now uses a temporary duplicate declaration
to retain the exact historical identity while introducing `id:reference-contract`.
Both destinations receive the same modern build output. See the explicit
[two-step fixture migration](fixture-migration.md), including when the temporary
alias may be retired and how to prepare both artifacts for the CLI. The original local proof does not establish hosted execution by itself;
subsequent hosted proof is indexed in [Evidence](EVIDENCE.md).

Initial build proof: [verification](experiments/modern-build/verification.json).
`tests/experiments/verify-build-path.cjs` creates isolated temporary Git history,
fetches an actual local origin, creates actual worktrees, builds both source
revisions and runs the bundled Action against the pinned protocol-28 network.
The intentional HEAD change adds a persistent write while preserving `hello`'s
interface. No Git/build/RPC/meter stubs are used and no GitHub token is supplied.
Temporary experiment commits are local fixtures, not public project activity.

Reproduce with the official CLI on PATH and an isolated pinned network on port
18000:

```bash
npm run bundle
node tests/experiments/verify-build-path.cjs /tmp/weighin-modern-build-proof
```

This original build-path experiment uses a shared Cargo cache. Separate
[five-clean-build/live evidence](repeatability.md), [hosted CI](EVIDENCE.md), and
[local external-project proof](external-soroban-forge.md) retain their own
producer records. Other platforms/networks and hosted external-project CI are
not established by these experiments.
