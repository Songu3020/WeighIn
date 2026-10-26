#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

#[contract]
pub struct AuthContract;

#[contractimpl]
impl AuthContract {
    pub fn auth_call(_env: Env, caller: Address) -> Symbol {
        caller.require_auth();
        symbol_short!("authed")
    }
}
