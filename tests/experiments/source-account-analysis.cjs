// Acceptance analysis for the source-account effect experiment (#201).
// Pure verification over the retained evidence bundle: no network, no helper.
const assert = require("node:assert/strict");

const METRIC_KEYS = [
  "cpu_instructions",
  "memory_bytes",
  "ledger_read_entries",
  "ledger_read_bytes",
  "ledger_write_entries",
  "ledger_write_bytes",
  "historical_data_read_bytes",
  "contract_data_hard_limit",
  "tx_size_bytes",
  "events_count",
  "event_data_bytes",
];

function consumed(metric) {
  return metric && Number.isFinite(metric.consumed) ? metric.consumed : null;
}

/** Verify that the retained evidence satisfies every acceptance criterion of
 *  the source-account effect experiment. Throws on the first violation. */
function verifySourceAccountEffects(bundle) {
  const { report, control, invalid, accounts, environment } = bundle;
  assert.ok(report, "The experiment must retain a source-account report");
  assert.equal(report.schema_version, 1);
  assert.ok(
    report.variants.length >= 1,
    "At least one variant account must be compared with the baseline",
  );
  assert.equal(
    report.effects.length,
    report.variants.length,
    "Every variant must have a measured effect",
  );
  assert.equal(accounts.accounts.length, report.variants.length + 1);

  // Every measured run must record the account that produced it.
  const runs = [report.baseline, ...report.variants];
  const declared = new Set(accounts.accounts.map((a) => a.public_key));
  for (const run of runs) {
    assert.ok(
      declared.has(run.source_account),
      `Measured run ${run.label} must use a declared source account`,
    );
    assert.equal(
      run.provenance.source_account,
      run.source_account,
      `Provenance of ${run.label} must record its source account`,
    );
  }

  // Code, arguments, protocol and calibration are held fixed.
  assert.equal(report.held_fixed.wasm_sha256, report.wasm_sha256);
  assert.equal(report.held_fixed.wasm_sha256, environment.wasm_sha256);
  for (const run of runs) {
    assert.equal(run.provenance.protocol, report.held_fixed.protocol);
    assert.equal(run.provenance.auth_mode, report.held_fixed.auth_mode);
    assert.deepStrictEqual(
      run.provenance.host_features,
      report.held_fixed.host_features,
    );
    assert.deepStrictEqual(run.provenance.seed, report.held_fixed.seed);
    assert.equal(run.provenance.network_id, report.held_fixed.network_id);
    assert.equal(run.provenance.helper_sha256, report.held_fixed.helper_sha256);
    assert.equal(
      run.provenance.compute_config_sha256,
      report.held_fixed.compute_config_sha256,
    );
    assert.equal(
      run.provenance.resource_limits_sha256 ?? "",
      report.held_fixed.resource_limits_sha256,
    );
    assert.equal(run.auth_mode, report.held_fixed.auth_mode);
  }

  // The reported effects must match the recorded measurements exactly.
  for (const effect of report.effects) {
    const variant = report.variants.find((v) => v.label === effect.label);
    assert.ok(variant, `Effect ${effect.label} must reference a measured run`);
    assert.equal(effect.source_account, variant.source_account);
    assert.equal(effect.effects.length, METRIC_KEYS.length);
    for (const metric of effect.effects) {
      const base = consumed(report.baseline.metrics[metric.metric]);
      const other = consumed(variant.metrics[metric.metric]);
      assert.equal(metric.baseline, base, `Baseline ${metric.metric} mismatch`);
      assert.equal(metric.variant, other, `Variant ${metric.metric} mismatch`);
      const delta = base === null || other === null ? null : other - base;
      assert.equal(metric.delta, delta, `Delta ${metric.metric} mismatch`);
      assert.equal(metric.changed, delta !== null && delta !== 0);
    }
    assert.deepStrictEqual(
      effect.changed_metrics,
      effect.effects.filter((m) => m.changed).map((m) => m.metric),
    );
  }

  // The verdict must follow from the measured effects.
  const changed = new Set(
    report.effects.flatMap((effect) => effect.changed_metrics),
  );
  assert.equal(report.comparison.metrics_changed, changed.size > 0);
  assert.deepStrictEqual(
    [...report.comparison.changed_metrics].sort(),
    [...changed].sort(),
  );
  assert.equal(
    report.comparison.cross_run_comparison_valid,
    changed.size === 0,
    "Cross-run comparability must follow from the measured effect",
  );
  assert.ok(report.comparison.isolated);

  // Repeatability control: an identical rerun must not change any metric.
  assert.ok(control, "The experiment must retain a repeatability control");
  assert.equal(control.fixture_id, report.fixture_id);
  assert.equal(control.logical_id, report.logical_id);
  assert.equal(control.function_name, report.function_name);
  assert.equal(control.case_id, report.case_id);
  assert.equal(control.wasm_sha256, report.wasm_sha256);
  assert.deepStrictEqual(
    control.effects.flatMap((effect) => effect.changed_metrics),
    [],
    "The repeatability control must not report a changed metric",
  );
  for (const effect of control.effects) {
    for (const metric of effect.effects) {
      assert.ok(
        metric.delta === 0 || metric.delta === null,
        `Repeatability control must not change ${metric.metric}`,
      );
      assert.equal(
        metric.changed,
        false,
        `Repeatability control must not report ${metric.metric} as changed`,
      );
    }
  }

  // Fail-closed evidence for invalid source accounts.
  assert.equal(invalid.malformed_key_rejected, true);
  assert.equal(invalid.malformed_key_rpc_calls, 0);
  assert.match(
    invalid.malformed_key_message,
    /public_key must be an Ed25519 account public key/,
  );
  assert.equal(invalid.missing_account_rejected, true);
  assert.match(
    invalid.missing_account_message,
    /is not available on the network/,
  );

  return {
    status: "VERIFIED",
    scenario: "source_account_effects",
    issue: 201,
    result: "pass",
    protocol: report.baseline.protocol,
    contract_id: report.contract_id,
    function_name: report.function_name,
    case_id: report.case_id,
    source_accounts_compared: runs.length,
    metrics_changed: [...changed],
    cross_run_comparison_valid: report.comparison.cross_run_comparison_valid,
    repeatability_control_changed_metrics: [],
    invalid_source_accounts_rejected: true,
    held_fixed: report.held_fixed,
  };
}

module.exports = { verifySourceAccountEffects, METRIC_KEYS };
