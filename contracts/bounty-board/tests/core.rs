mod common;

use bounty_board::*;
use common::*;
use concordium_smart_contract_testing::*;

// Same golden vectors as packages/shared/test/attest.test.ts. If one side changes,
// both suites fail until the encodings agree again.
const CONTRACT_HEX: &str = "d2040000000000000000000000000000";
const EXPIRY_HEX: &str = "0807060504030201";

fn vectors() -> (String, String, String) {
    // contract, poster, poster_agent Some(5), kind Exclusive, spec_hash, reward 100, deadline 2, expiry
    let post = format!(
        "426f756e7479426f6172642f76312f706f7374{CONTRACT_HEX}{}01{}00{}{}{}{EXPIRY_HEX}",
        "07".repeat(32),
        "0500000000000000",
        "ab".repeat(32),
        "6400000000000000",
        "0200000000000000"
    );
    let claim =
        format!("426f756e7479426f6172642f76312f636c61696d{CONTRACT_HEX}2a00000000000000{}00{EXPIRY_HEX}", "09".repeat(32));
    let enter = format!(
        "426f756e7479426f6172642f76312f656e746572{CONTRACT_HEX}2a00000000000000{}010700000000000000{EXPIRY_HEX}",
        "09".repeat(32)
    );
    (post, claim, enter)
}

#[test]
fn attestation_vectors_match_typescript() {
    let contract = ContractAddress { index: 1234, subindex: 0 };
    let expiry = ts(0x0102030405060708);
    let (post_v, claim_v, enter_v) = vectors();

    let post = post_message(&PostAttestation {
        contract,
        poster: AccountAddress([7; 32]),
        poster_agent: Some(5),
        kind: Kind::Exclusive,
        spec_hash: HashSha2256([0xab; 32]),
        reward: 100,
        deadline: ts(2),
        expiry,
    });
    assert_eq!(hex(&post), post_v);

    let work = |agent| WorkAttestation { contract, bounty_id: 42, worker: AccountAddress([9; 32]), agent, expiry };
    assert_eq!(hex(&work_message(WorkKind::Claim, &work(None))), claim_v);
    assert_eq!(hex(&work_message(WorkKind::Enter, &work(Some(7)))), enter_v);
}

#[test]
fn post_with_valid_attestation_creates_open_bounty() {
    let mut env = Env::new();
    let deadline = env.now_ms() + HOUR_MS;
    let update = env.post_full(POSTER, Kind::Exclusive, None, 100, deadline).unwrap();
    let id: u64 = update.parse_return_value().unwrap();
    assert_eq!(id, 0);

    assert_eq!(events(&update), vec![Event::Posted {
        id: 0,
        poster: POSTER,
        poster_agent: None,
        kind: Kind::Exclusive,
        reward: 100,
        spec_hash: SPEC,
        deadline: ts(deadline),
    }]);

    let b = env.bounty(0);
    assert_eq!(b.poster, POSTER);
    assert_eq!(b.status, Status::Open);
    assert_eq!(b.funding, Funding::NotFunded);
    assert_eq!(b.reward, 100);
    assert_eq!(env.stats(POSTER).posted, 1);

    // Ids increase.
    assert_eq!(env.post(Kind::Contest, 5), 1);
}

#[test]
fn post_rejects_bad_signature() {
    let mut env = Env::new();
    let expiry = env.now_ms() + 60_000;
    let signature = env.post_signature(&other_key(), env.contract, POSTER, None, Kind::Exclusive, 100, env.now_ms() + HOUR_MS, expiry);
    let r = env.call(POSTER, "post", &PostParams {
        kind: Kind::Exclusive,
        poster_agent: None,
        spec_hash: SPEC,
        reward: 100,
        deadline: ts(env.now_ms() + HOUR_MS),
        attestation_expiry: ts(expiry),
        signature,
    });
    assert_eq!(reject_reason(r), Error::BadSignature);
}

#[test]
fn post_rejects_expired_attestation() {
    let mut env = Env::new();
    let expiry = env.now_ms() - 1;
    let signature = env.post_signature(&attestor(), env.contract, POSTER, None, Kind::Exclusive, 100, env.now_ms() + HOUR_MS, expiry);
    let r = env.call(POSTER, "post", &PostParams {
        kind: Kind::Exclusive,
        poster_agent: None,
        spec_hash: SPEC,
        reward: 100,
        deadline: ts(env.now_ms() + HOUR_MS),
        attestation_expiry: ts(expiry),
        signature,
    });
    assert_eq!(reject_reason(r), Error::AttestationExpired);
}

#[test]
fn post_rejects_signature_for_other_contract() {
    let mut env = Env::new();
    let expiry = env.now_ms() + 60_000;
    let elsewhere = ContractAddress { index: env.contract.index + 1, subindex: 0 };
    let signature = env.post_signature(&attestor(), elsewhere, POSTER, None, Kind::Exclusive, 100, env.now_ms() + HOUR_MS, expiry);
    let r = env.call(POSTER, "post", &PostParams {
        kind: Kind::Exclusive,
        poster_agent: None,
        spec_hash: SPEC,
        reward: 100,
        deadline: ts(env.now_ms() + HOUR_MS),
        attestation_expiry: ts(expiry),
        signature,
    });
    assert_eq!(reject_reason(r), Error::BadSignature);
}

#[test]
fn post_rejects_attestation_for_another_poster() {
    let mut env = Env::new();
    let expiry = env.now_ms() + 60_000;
    // The board attested OTHER, but POSTER sends it.
    let signature = env.post_signature(&attestor(), env.contract, OTHER, None, Kind::Exclusive, 100, env.now_ms() + HOUR_MS, expiry);
    let r = env.call(POSTER, "post", &PostParams {
        kind: Kind::Exclusive,
        poster_agent: None,
        spec_hash: SPEC,
        reward: 100,
        deadline: ts(env.now_ms() + HOUR_MS),
        attestation_expiry: ts(expiry),
        signature,
    });
    assert_eq!(reject_reason(r), Error::BadSignature);
}

#[test]
fn post_rejects_unattested_agent() {
    let mut env = Env::new();
    let expiry = env.now_ms() + 60_000;
    // Attested without an agent, but the parameters claim agent 3.
    let signature = env.post_signature(&attestor(), env.contract, POSTER, None, Kind::Exclusive, 100, env.now_ms() + HOUR_MS, expiry);
    let r = env.call(POSTER, "post", &PostParams {
        kind: Kind::Exclusive,
        poster_agent: Some(3),
        spec_hash: SPEC,
        reward: 100,
        deadline: ts(env.now_ms() + HOUR_MS),
        attestation_expiry: ts(expiry),
        signature,
    });
    assert_eq!(reject_reason(r), Error::BadSignature);
}

#[test]
fn post_rejects_attestation_for_other_terms() {
    // The board attested reward 100, Exclusive, deadline D; the poster tries to change one of them.
    let mut env = Env::new();
    let expiry = env.now_ms() + 60_000;
    let deadline = env.now_ms() + HOUR_MS;
    let signature = env.post_signature(&attestor(), env.contract, POSTER, None, Kind::Exclusive, 100, deadline, expiry);
    let params = |kind, reward, deadline_ms| PostParams {
        kind,
        poster_agent: None,
        spec_hash: SPEC,
        reward,
        deadline: ts(deadline_ms),
        attestation_expiry: ts(expiry),
        signature,
    };
    assert_eq!(reject_reason(env.call(POSTER, "post", &params(Kind::Exclusive, 1_000, deadline))), Error::BadSignature);
    assert_eq!(reject_reason(env.call(POSTER, "post", &params(Kind::Contest, 100, deadline))), Error::BadSignature);
    assert_eq!(reject_reason(env.call(POSTER, "post", &params(Kind::Exclusive, 100, deadline + HOUR_MS))), Error::BadSignature);
    env.call(POSTER, "post", &params(Kind::Exclusive, 100, deadline)).unwrap();
}

#[test]
fn post_rejects_zero_reward() {
    let mut env = Env::new();
    let deadline = env.now_ms() + HOUR_MS;
    assert_eq!(reject_reason(env.post_full(POSTER, Kind::Exclusive, None, 0, deadline)), Error::InvalidParams);
}

#[test]
fn post_rejects_deadline_not_in_future() {
    let mut env = Env::new();
    let deadline = env.now_ms();
    assert_eq!(reject_reason(env.post_full(POSTER, Kind::Exclusive, None, 100, deadline)), Error::InvalidParams);
}

#[test]
fn cancel_only_poster_only_open() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);
    assert_eq!(reject_reason(env.call(OTHER, "cancel", &id)), Error::Unauthorized);

    let update = env.call(POSTER, "cancel", &id).unwrap();
    assert_eq!(events(&update), vec![Event::Cancelled { id }]);
    assert_eq!(env.bounty(id).status, Status::Cancelled);
    assert_eq!(reject_reason(env.call(POSTER, "cancel", &id)), Error::WrongStatus);

    assert_eq!(reject_reason(env.call(POSTER, "cancel", &99u64)), Error::NotFound);
}

#[test]
fn set_attestor_admin_only_and_rotates() {
    let mut env = Env::new();
    assert_eq!(reject_reason(env.call(OTHER, "set_attestor", &public(&other_key()))), Error::Unauthorized);

    env.call(ADMIN, "set_attestor", &public(&other_key())).unwrap();

    // The old key no longer works ...
    let deadline = env.now_ms() + HOUR_MS;
    assert_eq!(reject_reason(env.post_full(POSTER, Kind::Exclusive, None, 100, deadline)), Error::BadSignature);

    // ... and the new one does.
    let expiry = env.now_ms() + 60_000;
    let signature = env.post_signature(&other_key(), env.contract, POSTER, None, Kind::Exclusive, 100, env.now_ms() + HOUR_MS, expiry);
    env.call(POSTER, "post", &PostParams {
        kind: Kind::Exclusive,
        poster_agent: None,
        spec_hash: SPEC,
        reward: 100,
        deadline: ts(deadline),
        attestation_expiry: ts(expiry),
        signature,
    })
    .unwrap();
}

#[test]
fn set_operator_and_admin_are_admin_only() {
    let mut env = Env::new();
    assert_eq!(reject_reason(env.call(OTHER, "set_operator", &OTHER)), Error::Unauthorized);
    assert_eq!(reject_reason(env.call(OTHER, "set_admin", &OTHER)), Error::Unauthorized);

    env.call(ADMIN, "set_operator", &OTHER).unwrap();
    let cfg: ConfigView = env.view("view_config", &());
    assert_eq!(cfg.operator, OTHER);

    env.call(ADMIN, "set_admin", &OTHER).unwrap();
    // ADMIN is no longer admin.
    assert_eq!(reject_reason(env.call(ADMIN, "set_operator", &ADMIN)), Error::Unauthorized);
    let cfg: ConfigView = env.view("view_config", &());
    assert_eq!(cfg.admin, OTHER);
}
