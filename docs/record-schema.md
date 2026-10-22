# Authoritative versioned schema for saved measurement records

WeighIn validates saved `ContractBenchmark` measurement records through a single
authoritative, version-aware runtime validator and machine-readable JSON Schema
(`src/record-schema.ts` and
[`docs/schemas/measurement-records.schema.json`](schemas/measurement-records.schema.json)).
Callers can validate individual records or saved record arrays directly from the
public package entry point (`weighin`) without an RPC endpoint, contract
deployment, or computing a diff, and `diffBenchmarks` reuses the exact same
validation contract for both matched and unmatched records.

## Supported measurement envelopes and version matrix

`SUPPORTED_MEASUREMENT_ENVELOPES` defines the five accepted saved record
envelopes (`["legacy", 2, 3, 4, 5]`), and
`SUPPORTED_RECORD_SCHEMA_VERSIONS` defines the explicitly numbered versions
(`[2, 3, 4, 5]`), with `CURRENT_RECORD_SCHEMA_VERSION = 5`:

| Envelope | Discriminator | Contract identity key | Benchmark identity key | Metric availability & provenance requirements | Compute provenance requirements |
| --- | --- | --- | --- | --- | --- |
| `legacy` | `schema_version`, `fixture_id`, and `logical_id` omitted | `["legacy", contract_id]` | `[function_name, null]` (`case_id` forbidden) | All 11 `METRIC_KEYS` required; `availability` optional (`"measured"` or `"unavailable"`); `unavailable` requires `consumed: null` and non-blank `reason`; measured/implicit requires non-negative safe integer `consumed` and `null` or non-negative safe integer `limit` | Optional `provenance`; validated if present |
| `2` | `schema_version: 2` | `["logical", fixture_id, logical_id]` | `[function_name, case_id]` (`fixture_id`, `logical_id`, and every `case_id` required and non-blank) | Same 11-metric value constraints as `legacy` | Optional `provenance`; validated if present |
| `3` | `schema_version: 3` | `["logical", fixture_id, logical_id]` | `[function_name, case_id]` | All 11 `METRIC_KEYS` require explicit `availability` (`"measured"` or `"unavailable"`); `"measured"` requires non-blank `source`; `"unavailable"` requires `consumed: null` and non-blank `reason` | Required `ComputeProvenance` (`source`, `source_version`, `protocol`, `helper_sha256`, `network_id`, `ledger`, `header_sha256`, `snapshot_sha256`, `config_sha256`, `compute_config_sha256`, `input_sha256`, 32-byte `seed`, `auth_mode`, non-blank `host_features[]`) |
| `4` | `schema_version: 4` | `["logical", fixture_id, logical_id]` | `[function_name, case_id]` | Schema 3 rules plus non-blank `limit_source` when a measured metric has a limit, or non-blank `limit_reason` when it does not | Schema 3 `ComputeProvenance` plus required 64-character lowercase hex `resource_limits_sha256` |
| `5` (current) | `schema_version: 5` | `["logical", fixture_id, logical_id]` | `[function_name, case_id]` | Schema 4 requirements plus each metric's availability, consumption source, limit source/reason, and unavailable reason must exactly match its approved metric-specific mapping | Schema 4 `ComputeProvenance`; metric mapping is versioned and documented in [metric provenance](metric-provenance.md) |

All envelopes require non-blank top-level `contract_id`, `git_commit`, and
`soroban_sdk_version` strings, a non-negative safe integer `timestamp`, a
`benchmarks` array of objects with non-blank `function_name` and `wasm_sha256`,
and no unknown object properties. Historical records are validated under their
declared envelope without silent conversion or retroactive digest hardening.
Schema 5 is a deliberate semantic migration: schema 4 records remain valid as
schema 4, but schema 4 and schema 5 cannot be compared. Remeasure both BASE and
HEAD with the schema-5 producer; do not relabel or rewrite archived records.
Future changes to approved source/cap semantics must add an explicitly
versioned schema and validator mapping rather than changing the meaning of
existing schema versions.

## Public standalone validation API

The validator and schema generator are exported from `weighin`
(`dist/measurement.js`), `dist/record-schema.js`, and `dist/diff.js`, with
matching TypeScript declarations (`.d.ts`) beside each module:

- `validateMeasurementRecord(value, index?)`: validates one `ContractBenchmark`
  record and returns it, or throws `MeasurementRecordValidationError`.
- `validateMeasurementRecords(value)`: validates a `ContractBenchmark[]` array
  (including per-record constraints, unique contract identity, and uniform
  envelope version) and returns the validated array, or throws
  `MeasurementRecordValidationError`.
- `inspectMeasurementRecord(value, index?)` and
  `inspectMeasurementRecords(value)`: non-throwing inspection functions returning
  `{ valid, version, diagnostics, record/records }` with structured field-path
  diagnostics (`{ path, version, code, message }`).
- `detectRecordEnvelopeVersion(value)`: returns `"legacy" | 2 | 3 | 4 | 5 | "unknown"`.
- `getMeasurementRecordJsonSchema()`: returns the Draft 2020-12 JSON Schema
  matching [`docs/schemas/measurement-records.schema.json`](schemas/measurement-records.schema.json).

Each `MeasurementRecordValidationError` exposes `.path` (for example
`$[0].benchmarks[0].metrics.cpu_instructions.consumed`), `.version`, `.code`,
and `.diagnostics`.

## Invariants enforced at runtime beyond static JSON Schema

[`docs/schemas/measurement-records.schema.json`](schemas/measurement-records.schema.json)
encodes structural, type, enum, required-property, numeric-bound, and version
discriminator constraints via `$defs` (`LegacyContractBenchmark`,
`Schema2ContractBenchmark`, `Schema3ContractBenchmark`,
`Schema4ContractBenchmark`, and `Schema5ContractBenchmark`). Schema 5's
per-metric `$defs` bind each field to its approved source and limit mapping.
`RUNTIME_RECORD_INVARIANTS` documents the
additional invariants enforced at runtime:

1. `UNIQUE_CONTRACT_IDENTITY`: within a saved measurement array, no two
   `ContractBenchmark` entries may share the same comparison key
   (`["legacy", contract_id]` for legacy envelopes or
   `["logical", fixture_id, logical_id]` for schema 2/3/4/5 envelopes).
2. `UNIQUE_BENCHMARK_IDENTITY`: within each contract's `benchmarks` array, no
   two `BenchmarkResult` entries may share the same
   `[function_name, case_id ?? null]` identity.
3. `HOMOGENEOUS_ENVELOPE_VERSION`: all `ContractBenchmark` entries within a
   saved measurement array must use the same envelope version.
4. `COMPARISON_ENVIRONMENT_COMPATIBILITY`: during `diffBenchmarks(base, head)`,
   versioned schemas must match across BASE and HEAD, and paired benchmarks with
   provenance must agree on `source`, `source_version`, `protocol`,
   `helper_sha256`, `network_id`, `compute_config_sha256`, `seed`, `auth_mode`,
   `host_features`, `resource_limits_sha256`, and schema-4/5 per-metric
   `availability`, `source`, `limit`, `limit_source`, and `limit_reason`.
   Schema 5 additionally rejects any source/cap mapping not explicitly
   approved for that metric, even when BASE and HEAD use the same fabricated
   value.
5. `SAFE_INTEGER_BOUNDS`: numeric `consumed`, `limit`, `timestamp`, `ledger`,
   and `protocol` fields must satisfy `Number.isSafeInteger` in JavaScript
   runtime evaluation in addition to JSON integer bounds.
