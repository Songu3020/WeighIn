#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, vec, Env, Symbol, Vec};

/// Deterministic reference fixture for expected contract-error benchmarks.
///
/// `guarded` returns a declared business error (`Error(Contract, #1)`) when
/// `approve` is false. The success path is identical modulo the error branch,
/// so BASE/HEAD comparisons of the success case are unaffected.
#[contracterror]
#[derive(Copy, Clone)]
#[repr(u32)]
pub enum Error {
    Rejected = 1,
}

#[contract]
pub struct ExpectedErrorFixture;

#[contractimpl]
impl ExpectedErrorFixture {
    pub fn hello(env: Env, to: Symbol) -> Vec<Symbol> {
        vec![&env, symbol_short!("Hello"), to]
    }

    pub fn guarded(_env: Env, approve: bool) -> Result<Symbol, Error> {
        if approve {
            Ok(symbol_short!("ok"))
        } else {
            Err(Error::Rejected)
        }
    }
}
