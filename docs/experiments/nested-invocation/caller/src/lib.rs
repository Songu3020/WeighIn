#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, vec, Address, Env, Vec};

#[contract]
pub struct NestedCaller;

/// Self-contained runtime client for the callee contract. The caller has no
/// compile-time dependency on the callee crate: the nested call is a real host
/// invocation addressed by the runtime `Address` argument, so a callee-only
/// source change cannot alter the caller's WASM, hash or runtime contract ID.
mod nested_callee {
    use soroban_sdk::{symbol_short, vec, Address, Env};

    pub struct Client<'a> {
        env: &'a Env,
        contract: Address,
    }

    impl<'a> Client<'a> {
        pub fn new(env: &'a Env, contract: &Address) -> Self {
            Self {
                env,
                contract: contract.clone(),
            }
        }

        pub fn work(&self, rounds: u32) -> u32 {
            self.env.invoke_contract(
                &self.contract,
                &symbol_short!("work"),
                vec![self.env, rounds.into()],
            )
        }

        pub fn boom(&self) -> u32 {
            self.env
                .invoke_contract(&self.contract, &symbol_short!("boom"), vec![self.env])
        }
    }
}

/// Deterministic caller for the nested caller/callee resource-attribution
/// proof. `run` performs one caller-side persistent write, performs a real
/// nested host call into the callee addressed by its argument, records the
/// callee result and emits exactly one caller contract event. All resources of
/// the nested call are charged to this single measured invocation.
#[contractimpl]
impl NestedCaller {
    pub fn run(env: Env, callee: Address, rounds: u32) -> Vec<u32> {
        let last = symbol_short!("last");
        env.storage().persistent().set(&last, &0u32);
        let value = nested_callee::Client::new(&env, &callee).work(rounds);
        env.storage().persistent().set(&last, &value);
        env.events().publish((symbol_short!("caller"),), value);
        vec![&env, value]
    }

    /// Reaches the callee's failing entrypoint through the same nested call
    /// path so application failures are observed on the real caller/callee
    /// invocation rather than on an independent callee call.
    pub fn run_failing(env: Env, callee: Address) -> u32 {
        nested_callee::Client::new(&env, &callee).boom()
    }
}
