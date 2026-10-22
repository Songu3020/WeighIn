use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use soroban_env_host::{
    e2e_invoke::RecordingInvocationAuthMode,
    storage::{EntryWithLiveUntil, SnapshotSource},
    xdr::*,
    HostError, LedgerInfo, DEFAULT_XDR_RW_LIMITS,
};
use soroban_simulation::{
    simulation::{simulate_invoke_host_function_op, SimulationAdjustmentConfig},
    NetworkConfig,
};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::{self, Read},
    rc::Rc,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    key: String,
    xdr: Option<String>,
    extension_xdr: Option<String>,
    last_modified: Option<u32>,
    live_until: Option<u32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    schema_version: u32,
    header_xdr: String,
    network_passphrase: String,
    host_function_xdr: String,
    source_account_xdr: String,
    entries: Vec<Entry>,
    instruction_leeway: u32,
    seed: Vec<u8>,
}
struct Snapshot {
    entries: BTreeMap<Vec<u8>, Option<EntryWithLiveUntil>>,
    missing: RefCell<Vec<String>>,
}
impl SnapshotSource for Snapshot {
    fn get(
        &self,
        key: &Rc<LedgerKey>,
    ) -> std::result::Result<Option<EntryWithLiveUntil>, HostError> {
        let bytes = key.to_xdr(DEFAULT_XDR_RW_LIMITS)?;
        match self.entries.get(&bytes) {
            Some(entry) => Ok(entry.clone()),
            None => {
                self.missing
                    .borrow_mut()
                    .push(key.to_xdr_base64(DEFAULT_XDR_RW_LIMITS)?);
                Err((ScErrorType::Storage, ScErrorCode::MissingValue).into())
            }
        }
    }
}

#[derive(Serialize)]
struct FailureEnvelope<'a> {
    protocol_version: u32,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    keys: Option<Vec<String>>,
    message: String,
}

fn failure(
    status: &'static str,
    keys: Option<Vec<String>>,
    message: impl Into<String>,
) -> anyhow::Error {
    let envelope = FailureEnvelope {
        protocol_version: 1,
        status,
        keys,
        message: message.into(),
    };
    println!(
        "{}",
        serde_json::to_string(&envelope).expect("failure envelope serializes")
    );
    anyhow::anyhow!("native helper failure")
}

fn same_xdr<T: WriteXdr>(left: &T, right: &T) -> bool {
    left.to_xdr(DEFAULT_XDR_RW_LIMITS).ok() == right.to_xdr(DEFAULT_XDR_RW_LIMITS).ok()
}

fn validate_correspondence(key: &LedgerKey, data: &LedgerEntryData) -> Result<()> {
    match (key, data) {
        (LedgerKey::Account(k), LedgerEntryData::Account(d))
            if same_xdr(&k.account_id, &d.account_id) =>
        {
            Ok(())
        }
        (LedgerKey::Trustline(k), LedgerEntryData::Trustline(d))
            if same_xdr(&k.account_id, &d.account_id) && same_xdr(&k.asset, &d.asset) =>
        {
            Ok(())
        }
        (LedgerKey::Offer(k), LedgerEntryData::Offer(d))
            if same_xdr(&k.seller_id, &d.seller_id) && k.offer_id == d.offer_id =>
        {
            Ok(())
        }
        (LedgerKey::Data(k), LedgerEntryData::Data(d))
            if same_xdr(&k.account_id, &d.account_id) && k.data_name == d.data_name =>
        {
            Ok(())
        }
        (LedgerKey::ClaimableBalance(k), LedgerEntryData::ClaimableBalance(d))
            if k.balance_id == d.balance_id =>
        {
            Ok(())
        }
        (LedgerKey::ContractData(k), LedgerEntryData::ContractData(d))
            if same_xdr(&k.contract, &d.contract)
                && same_xdr(&k.key, &d.key)
                && k.durability == d.durability =>
        {
            Ok(())
        }
        (LedgerKey::ContractCode(k), LedgerEntryData::ContractCode(d)) if k.hash == d.hash => {
            Ok(())
        }
        (LedgerKey::ConfigSetting(k), LedgerEntryData::ConfigSetting(d))
            if k.config_setting_id == d.discriminant() =>
        {
            Ok(())
        }
        (LedgerKey::Ttl(k), LedgerEntryData::Ttl(d)) if k.key_hash == d.key_hash => Ok(()),
        _ => bail!("ledger entry/key correspondence mismatch"),
    }
}
fn run() -> Result<()> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw)?;
    let input: Input = serde_json::from_str(&raw)?;
    if input.schema_version != 1 {
        bail!("unsupported helper input schema");
    }
    let header = LedgerHeader::from_xdr_base64(&input.header_xdr, DEFAULT_XDR_RW_LIMITS)?;
    if header.ledger_version != 28 {
        bail!(
            "unsupported protocol {}: helper supports 28",
            header.ledger_version
        );
    }
    let mut map = BTreeMap::new();
    for row in input.entries {
        let key = LedgerKey::from_xdr_base64(&row.key, DEFAULT_XDR_RW_LIMITS)?;
        if row.live_until.is_some_and(|ttl| ttl < header.ledger_seq) {
            bail!("archived ledger state is unsupported");
        }
        let value = if let Some(data) = row.xdr {
            let data = LedgerEntryData::from_xdr_base64(&data, DEFAULT_XDR_RW_LIMITS)?;
            validate_correspondence(&key, &data)?;
            let ext = LedgerEntryExt::from_xdr_base64(
                row.extension_xdr
                    .as_ref()
                    .context("missing ledger entry extension")?,
                DEFAULT_XDR_RW_LIMITS,
            )?;
            Some((
                Rc::new(LedgerEntry {
                    last_modified_ledger_seq: row
                        .last_modified
                        .context("missing last-modified ledger")?,
                    data,
                    ext,
                }),
                row.live_until,
            ))
        } else {
            None
        };
        if map
            .insert(key.to_xdr(DEFAULT_XDR_RW_LIMITS)?, value)
            .is_some()
        {
            bail!("duplicate snapshot key");
        }
    }
    let snapshot = Rc::new(Snapshot {
        entries: map,
        missing: RefCell::new(Vec::new()),
    });
    let config = NetworkConfig::load_from_snapshot(snapshot.as_ref())
        .context("incomplete/invalid network configuration")?;
    let mut ledger = LedgerInfo {
        protocol_version: header.ledger_version,
        sequence_number: header.ledger_seq,
        timestamp: header.scp_value.close_time.0,
        network_id: Sha256::digest(input.network_passphrase.as_bytes()).into(),
        base_reserve: header.base_reserve,
        ..Default::default()
    };
    config.fill_config_fields_in_ledger_info(&mut ledger);
    let mut adjustment = SimulationAdjustmentConfig::default_adjustment();
    adjustment.instructions.additive_factor = adjustment
        .instructions
        .additive_factor
        .max(input.instruction_leeway);
    let host_function =
        HostFunction::from_xdr_base64(&input.host_function_xdr, DEFAULT_XDR_RW_LIMITS)?;
    let source = AccountId::from_xdr_base64(&input.source_account_xdr, DEFAULT_XDR_RW_LIMITS)?;
    let seed: [u8; 32] = input
        .seed
        .try_into()
        .map_err(|_| anyhow::anyhow!("PRNG seed must be exactly 32 bytes"))?;
    // Match RPC default recording auth; protocol 28 supports upgraded credentials.
    let result = simulate_invoke_host_function_op(
        snapshot.clone(),
        &config,
        &adjustment,
        &ledger,
        host_function,
        RecordingInvocationAuthMode::recording(true, true),
        &source,
        seed,
        true,
    )?;
    let retval = match result.invoke_result {
        Ok(value) => value,
        Err(err) => {
            let missing = snapshot.missing.borrow().clone();
            if !missing.is_empty() {
                return Err(failure(
                    "uncaptured",
                    Some(missing),
                    "snapshot is missing ledger keys",
                ));
            }
            return Err(failure(
                "host_failure",
                None,
                format!("host invocation failed: {err:?}"),
            ));
        }
    };
    let txdata = result
        .transaction_data
        .context("successful simulation omitted transaction data")?;
    let resources = &txdata.resources;
    println!(
        "{}",
        json!({"schema_version":1,"source":"soroban-simulation","source_version":"28.0.1","protocol":28,"host_features":["recording_mode","testutils"],"auth_mode":"recording(true,true)","cpu_instructions_consumed":result.simulated_instructions,"memory_bytes_consumed":result.simulated_memory,"cpu_limit":config.tx_max_instructions,"memory_limit":config.tx_memory_limit,"instruction_budget":resources.instructions,"disk_read_bytes":resources.disk_read_bytes,"write_bytes":resources.write_bytes,"read_only_keys":resources.footprint.read_only.iter().map(|key|key.to_xdr_base64(DEFAULT_XDR_RW_LIMITS)).collect::<std::result::Result<Vec<_>,_>>()?,"read_write_keys":resources.footprint.read_write.iter().map(|key|key.to_xdr_base64(DEFAULT_XDR_RW_LIMITS)).collect::<std::result::Result<Vec<_>,_>>()?,"retval_xdr":retval.to_xdr_base64(DEFAULT_XDR_RW_LIMITS)?,"transaction_data_xdr":txdata.to_xdr_base64(DEFAULT_XDR_RW_LIMITS)?,"contract_events_xdr":result.contract_events.iter().map(|e|e.to_xdr_base64(DEFAULT_XDR_RW_LIMITS)).collect::<std::result::Result<Vec<_>,_>>()?,"modified_entries":result.modified_entries.len()})
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
