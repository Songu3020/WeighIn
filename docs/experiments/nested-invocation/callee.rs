#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env};

#[contract]
pub struct NestedCallee;

/// Deterministic callee used by the nested caller/callee resource-attribution
/// proof. `work` performs a bounded read-modify-write of one persistent counter
/// and emits exactly one contract event. It uses no randomness, no ledger
/// parameters and no authorization, so its resources depend only on its own
/// code and storage.
#[contractimpl]
impl NestedCallee {
    pub fn work(env: Env, rounds: u32) -> u32 {
        let key = symbol_short!("counter");
        let mut value: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        for _ in 0..rounds {
            value += 1;
            env.storage().persistent().set(&key, &value);
        }
        env.events().publish((symbol_short!("work"),), value);
        value
    }

    /// Application-failure anchor: the nested caller reaches this through a
    /// real cross-contract call so the proof can classify a callee panic as an
    /// application (host) failure rather than an infrastructure failure.
    pub fn boom(_env: Env) -> u32 {
        panic!("nested callee failure")
    }
}
