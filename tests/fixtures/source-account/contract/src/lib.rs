#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

/// Proof contract for the source-account effect experiment.
///
/// Protocol 28 contracts cannot observe the invoking account, so the measured
/// work of `constant_probe` is identical for every source account.
/// `auth_call` constrains the set of accounts that may invoke the case in
/// production: the fixed address must authorize the call.
#[contract]
pub struct SourceAccountContract;

#[contractimpl]
impl SourceAccountContract {
    /// Authorization-constrained case: a fixed address must authorize the call.
    pub fn auth_call(_env: Env, caller: Address) -> Symbol {
        caller.require_auth();
        symbol_short!("authed")
    }

    /// Control case: identical work for every source account.
    pub fn constant_probe(_env: Env) -> u32 {
        let mut total: u32 = 0;
        for round in 0..256u32 {
            total = total.wrapping_add(round.wrapping_mul(3));
        }
        total
    }
}
