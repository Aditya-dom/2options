//! Emits wire-format test vectors (borsh bytes, digest, ed25519 signature) for agent-signed
//! messages, and proves the contract accepts the signatures by running `post_spot` and
//! `settle_funding` on a real `Perennia` instance. Lets an off-chain signer in any language
//! check its encoding byte for byte (agent/tests/test_wire.py).
//!
//!   cd contracts/perennia
//!   cargo run --example wire_vectors > ../../agent/tests/fixtures/wire_vectors.json

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{Base64VecU8, I128, U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, AccountId, CurveType, PublicKey};
use perennia::types::{FundingUpdate, Kind, Quote, Side, SpotUpdate, Underlying};
use perennia::Perennia;

const CONTRACT: &str = "perennia.testnet";
const SEC: u64 = 1_000_000_000;
/// 2026-11-10T00:00:00Z, the start of funding epoch 498408.
const T0: u64 = 1_794_268_800 * SEC;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn digest<T: BorshSerialize>(domain: &[u8], msg: &T) -> (Vec<u8>, Vec<u8>) {
    let body = near_sdk::borsh::to_vec(msg).unwrap();
    let mut bytes = domain.to_vec();
    bytes.extend_from_slice(&(CONTRACT.len() as u32).to_le_bytes());
    bytes.extend_from_slice(CONTRACT.as_bytes());
    bytes.extend_from_slice(&body);
    (body, env::sha256(&bytes))
}

fn vector<T: BorshSerialize + Serialize>(kind: &str, domain: &[u8], msg: &T, key: &SigningKey) -> (Value, Base64VecU8) {
    let (body, d) = digest(domain, msg);
    let sig = key.sign(&d).to_bytes().to_vec();
    let b64 = Base64VecU8(sig.clone());
    let v = json!({
        "kind": kind,
        "domain": String::from_utf8(domain.to_vec()).unwrap(),
        "message": serde_json::to_value(msg).unwrap(),
        "borsh_hex": hex(&body),
        "digest_hex": hex(&d),
        "signature_b64": serde_json::to_value(&b64).unwrap(),
    });
    (v, b64)
}

fn ctx(now: u64) -> near_sdk::VMContext {
    VMContextBuilder::new()
        .current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id("keeper.testnet".parse().unwrap())
        .block_timestamp(now)
        .build()
}

fn main() {
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let pk = PublicKey::from_parts(CurveType::ED25519, key.verifying_key().to_bytes().to_vec()).unwrap();
    testing_env!(ctx(T0));
    let owner: AccountId = "owner.testnet".parse().unwrap();
    let mut c = Perennia::new(owner.clone(), "usdc.fakes.testnet".parse().unwrap(), vec![pk.clone()]);
    testing_env!(VMContextBuilder::new().current_account_id(CONTRACT.parse().unwrap()).predecessor_account_id(owner).block_timestamp(T0).build());
    c.add_series(Underlying::ETH, U128(2_100 * 100_000_000), Kind::Call);

    let mut vectors = Vec::new();

    let spots = [
        SpotUpdate { underlying: Underlying::ETH, price: U128(211_215_000_000), ts_ns: U64(T0 + SEC), seq: U64(1_794_268_801_000) },
        SpotUpdate { underlying: Underlying::ETH, price: U128(211_400_123_456), ts_ns: U64(T0 + 11 * SEC), seq: U64(1_794_268_811_000) },
        SpotUpdate { underlying: Underlying::NEAR, price: U128(362_645_000), ts_ns: U64(T0 + 2 * SEC), seq: U64(7) },
    ];
    for s in &spots {
        let (v, sig) = vector("spot", b"perennia:spot:v1", s, &key);
        testing_env!(ctx(s.ts_ns.0 + SEC));
        c.post_spot(s.clone(), sig); // panics if the signature or encoding were wrong
        vectors.push(v);
    }

    let fundings = [
        FundingUpdate { series: "ETH-2100-C".into(), epoch: U64(498_408), rate: I128(40_000_000), mark: U128(7_450_000) },
        FundingUpdate { series: "ETH-2100-C".into(), epoch: U64(498_409), rate: I128(-12_345_678), mark: U128(6_900_001) },
    ];
    for (i, f) in fundings.iter().enumerate() {
        let (v, sig) = vector("funding", b"perennia:funding:v1", f, &key);
        let now = T0 + (i as u64) * 3_600 * SEC + 20 * SEC;
        // Keep the spot fresh for the band check, then settle.
        let s = SpotUpdate { underlying: Underlying::ETH, price: U128(210_000_000_000), ts_ns: U64(now - SEC), seq: U64(2_000_000_000_000 + i as u64) };
        let (_, ssig) = vector("spot", b"perennia:spot:v1", &s, &key);
        testing_env!(ctx(now));
        c.post_spot(s, ssig);
        c.settle_funding(f.clone(), sig);
        vectors.push(v);
    }

    let quotes = [
        Quote { series: "ETH-2100-C".into(), taker: "aditya.testnet".parse().unwrap(), side: Side::Buy, size: U128(1_000_000), price: U128(7_480_000), nonce: U64(1_794_268_800_123_456), expiry_ns: U64(T0 + 10 * SEC) },
        Quote { series: "ETH-2100-C".into(), taker: "a-much-longer-account-name.testnet".parse().unwrap(), side: Side::Sell, size: U128(2_500), price: U128(0), nonce: U64(u64::MAX), expiry_ns: U64(u64::MAX) },
    ];
    for q in &quotes {
        // trade() needs a funded account and vault, so quotes are checked byte for byte only; the
        // digest and signature path is the same verify_agent_signature that post_spot exercises.
        vectors.push(vector("quote", b"perennia:quote:v1", q, &key).0);
    }

    println!("{}", json!({
        "generator": "contracts/perennia/examples/wire_vectors.rs",
        "contract_id": CONTRACT,
        "agent_secret_key_hex": hex(&[7u8; 32]),
        "agent_public_key": serde_json::to_value(&pk).unwrap(),
        "accepted_by_contract": ["spot", "funding"],
        "vectors": vectors,
    }));
}
