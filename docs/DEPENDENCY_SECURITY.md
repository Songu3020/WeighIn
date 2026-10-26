# Dependency inventory

`docs/dependency-inventory.json` is generated as a CycloneDX 1.6 JSON bill of
materials from the committed `package-lock.json`,
`native/simulation/Cargo.lock`, both Action bundles, and the package file list.
The output contains no build timestamp or machine-specific paths.

Regenerate or verify it with:

```bash
npm run inventory:generate
npm run inventory:check
```

## Identity and inclusion

Each external component is identified by ecosystem, package name, and exact
locked version in its Package URL (`pkg:npm/...` or `pkg:cargo/...`). Different
versions and ecosystems remain separate. Repeated npm installations with the
same identity become one component with all sorted install locations and the
union of their dependency edges. Conflicting package records are not resolved
by guessing a version.

The `weighin:classification` property distinguishes:

- `shipped-runtime`: the production npm lock graph, including packages
  conservatively retained when they are not statically visible in a bundle;
- `native-helper`: the Cargo lock graph for the Linux x64 simulation helper;
  `weighin:target-inclusion` records whether Cargo selects each locked package
  for that target, so platform-conditional lock entries remain visible without
  implying that they are built for Linux x64;
- `build-tooling`: npm development dependencies used by build, bundle, lint,
  and test tooling, plus their locked transitive dependencies;
- `dev-only`: remaining npm development dependencies.

`weighin:bundle-evidence` names the bundle containing a package installation
marker. A production package with no such marker carries
`weighin:bundle-inclusion=not-statically-emitted...`; it remains in the
inventory because the production lock graph is included conservatively. The
application component records `package.json`'s `files` entries and both
committed bundle paths. Cargo components retain their lock source and checksum,
the helper target (`x86_64-unknown-linux-gnu`), Cargo's target-filtered active
features, and target inclusion resolved by `cargo metadata --filter-platform`.
Generation requires the repository's pinned Cargo 1.95.0 toolchain and locally
available locked crates; Cargo metadata runs offline and does not update the
lockfile.

Missing source, integrity, or checksum data is represented by a
`weighin:metadata-gap` property. Exact versions are never inferred from a
manifest range. The packed consumer check confirms that the generated BOM and
the files it describes are present in the normal npm package.

This is a reproducible component and provenance inventory. It is not
vulnerability clearance, a license/legal certification, or a claim that every
locked component is statically reachable at runtime.
