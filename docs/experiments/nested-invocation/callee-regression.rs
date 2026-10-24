#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env};

#[contract]
pub struct NestedCallee;

/// Callee-only regression for the nested proof: identical interface and event,
/// one additional persistent audit write per round.
#[contractimpl]
impl NestedCallee {
    pub fn work(env: Env, rounds: u32) -> u32 {
        let key = symbol_short!("counter");
        let audit = symbol_short!("audit");
        let mut value: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        for _ in 0..rounds {
            value += 1;
            env.storage().persistent().set(&key, &value);
            env.storage().persistent().set(&audit, &value);
        }
        env.events().publish((symbol_short!("work"),), value);
        value
    }

    pub fn boom(_env: Env) -> u32 {
        panic!("nested callee failure")
    }
}
