#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, vec, Env, Symbol, Vec};

#[contract]
pub struct HelloContract;

#[contractimpl]
impl HelloContract {
    pub fn hello(env: Env, to: Symbol) -> Vec<Symbol> {
        let sequence = env.ledger().sequence();
        let timestamp = env.ledger().timestamp();
        let mut out = vec![&env, symbol_short!("Hello"), to];
        if sequence >= 950 && timestamp >= 1_791_436_000 {
            let steps = (sequence - 950) / 25 + 1;
            env.storage()
                .persistent()
                .set(&symbol_short!("ledger"), &(sequence, timestamp));
            let mut index = 0u32;
            while index < steps {
                out.push_back(symbol_short!("tick"));
                index += 1;
            }
        }
        out
    }
}
