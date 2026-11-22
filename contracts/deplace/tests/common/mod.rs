#![allow(dead_code)]
//! Test helpers: a chain with the deplace contract and the accounts and keys the tests use.

use deplace::*;
use concordium_smart_contract_testing::*;
use ed25519_dalek::{Signer as _, SigningKey};
// The testing crate does not re-export these; the test files get them through `use common::*`.
pub use concordium_std::{Deserial, HashSha2256, PublicKeyEd25519, Serial, SignatureEd25519};

pub const ADMIN: AccountAddress = AccountAddress([1; 32]);
pub const OPERATOR: AccountAddress = AccountAddress([2; 32]);
pub const POSTER: AccountAddress = AccountAddress([3; 32]);
pub const WORKER: AccountAddress = AccountAddress([4; 32]);
pub const WORKER2: AccountAddress = AccountAddress([5; 32]);
pub const OTHER: AccountAddress = AccountAddress([6; 32]);

/// Block time the chain starts at, so deadlines and expiries can be in the past or future.
pub const START_MS: u64 = 1_800_000_000_000;
pub const REVIEW_MS: u64 = 60_000;
pub const PAYMENT_MS: u64 = 120_000;
pub const HOUR_MS: u64 = 3_600_000;
pub const REGISTRY: ContractAddress = ContractAddress { index: 12802, subindex: 0 };

pub const SPEC: HashSha2256 = HashSha2256([0xab; 32]);
pub const WORK: HashSha2256 = HashSha2256([0xcd; 32]);
pub const TX1: HashSha2256 = HashSha2256([0x11; 32]);
pub const TX2: HashSha2256 = HashSha2256([0x22; 32]);
pub const TX3: HashSha2256 = HashSha2256([0x33; 32]);

pub fn attestor() -> SigningKey { SigningKey::from_bytes(&[7u8; 32]) }
pub fn other_key() -> SigningKey { SigningKey::from_bytes(&[8u8; 32]) }
pub fn public(k: &SigningKey) -> PublicKeyEd25519 { PublicKeyEd25519(k.verifying_key().to_bytes()) }
pub fn sign(k: &SigningKey, msg: &[u8]) -> SignatureEd25519 { SignatureEd25519(k.sign(msg).to_bytes()) }

pub fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

pub fn ts(ms: u64) -> Timestamp { Timestamp::from_timestamp_millis(ms) }

pub type CallResult = Result<ContractInvokeSuccess, ContractInvokeError>;

/// The error value the contract rejected with.
pub fn reject_reason(result: CallResult) -> Error {
    let err = result.expect_err("call should have been rejected");
    err.parse_return_value::<Error>().expect("rejection carries an Error value")
}

/// All deplace events logged by a call, in order.
pub fn events(update: &ContractInvokeSuccess) -> Vec<Event> {
    update
        .events()
        .flat_map(|(_, evs)| evs.iter().map(|e| e.parse::<Event>().expect("event parses")))
        .collect()
}

pub struct Env {
    pub chain: Chain,
    pub contract: ContractAddress,
}

impl Env {
    pub fn new() -> Self {
        let mut chain = Chain::new();
        for a in [ADMIN, OPERATOR, POSTER, WORKER, WORKER2, OTHER] {
            chain.create_account(Account::new(a, Amount::from_ccd(10_000)));
        }
        chain.tick_block_time(Duration::from_millis(START_MS)).unwrap();
        let module = module_load_output().expect("module built by `cargo concordium test`");
        let deployment = chain.module_deploy_v1(Signer::with_one_key(), ADMIN, module).unwrap();
        let params = InitParams {
            admin: ADMIN,
            operator: OPERATOR,
            attestor: public(&attestor()),
            registry: REGISTRY,
            reward_token: "EUDemo".into(),
            review_window_ms: REVIEW_MS,
            payment_window_ms: PAYMENT_MS,
        };
        let init = chain
            .contract_init(Signer::with_one_key(), ADMIN, Energy::from(10_000), InitContractPayload {
                amount: Amount::zero(),
                mod_ref: deployment.module_reference,
                init_name: OwnedContractName::new_unchecked("init_deplace".into()),
                param: OwnedParameter::from_serial(&params).unwrap(),
            })
            .unwrap();
        Env { chain, contract: init.contract_address }
    }

    pub fn now_ms(&self) -> u64 { self.chain.block_time().timestamp_millis() }

    pub fn advance(&mut self, ms: u64) { self.chain.tick_block_time(Duration::from_millis(ms)).unwrap(); }

    pub fn call<P: Serial>(&mut self, sender: AccountAddress, entrypoint: &str, p: &P) -> CallResult {
        self.chain.contract_update(
            Signer::with_one_key(),
            sender,
            Address::Account(sender),
            Energy::from(500_000),
            UpdateContractPayload {
                amount: Amount::zero(),
                address: self.contract,
                receive_name: OwnedReceiveName::new_unchecked(format!("deplace.{entrypoint}")),
                message: OwnedParameter::from_serial(p).unwrap(),
            },
        )
    }

    pub fn view<P: Serial, R: Deserial>(&self, entrypoint: &str, p: &P) -> R {
        self.chain
            .contract_invoke(ADMIN, Address::Account(ADMIN), Energy::from(500_000), UpdateContractPayload {
                amount: Amount::zero(),
                address: self.contract,
                receive_name: OwnedReceiveName::new_unchecked(format!("deplace.{entrypoint}")),
                message: OwnedParameter::from_serial(p).unwrap(),
            })
            .expect("view succeeds")
            .parse_return_value()
            .expect("view return value parses")
    }

    pub fn bounty(&self, id: u64) -> Bounty {
        self.view::<_, Option<Bounty>>("view_bounty", &id).expect("bounty exists")
    }

    pub fn stats(&self, account: AccountAddress) -> Stats { self.view("view_stats", &account) }

    // --- posting -----------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn post_signature(
        &self,
        key: &ed25519_dalek::SigningKey,
        contract: ContractAddress,
        poster: AccountAddress,
        poster_agent: Option<u64>,
        kind: Kind,
        reward: u64,
        deadline_ms: u64,
        expiry_ms: u64,
    ) -> SignatureEd25519 {
        let msg = post_message(&PostAttestation {
            contract,
            poster,
            poster_agent,
            kind,
            spec_hash: SPEC,
            reward,
            deadline: ts(deadline_ms),
            expiry: ts(expiry_ms),
        });
        sign(key, &msg)
    }

    /// Posts a bounty as POSTER with a valid attestation. Deadline is one hour from now.
    pub fn post(&mut self, kind: Kind, reward: u64) -> u64 {
        let deadline = self.now_ms() + HOUR_MS;
        self.post_full(POSTER, kind, None, reward, deadline).expect("post succeeds").parse_return_value().unwrap()
    }

    pub fn post_full(
        &mut self,
        poster: AccountAddress,
        kind: Kind,
        poster_agent: Option<u64>,
        reward: u64,
        deadline_ms: u64,
    ) -> CallResult {
        let expiry = self.now_ms() + 60_000;
        let signature = self.post_signature(&attestor(), self.contract, poster, poster_agent, kind, reward, deadline_ms, expiry);
        self.call(poster, "post", &PostParams {
            kind,
            poster_agent,
            spec_hash: SPEC,
            reward,
            deadline: ts(deadline_ms),
            attestation_expiry: ts(expiry),
            signature,
        })
    }

    // --- working -----------------------------------------------------------

    pub fn work_signature(
        &self,
        key: &ed25519_dalek::SigningKey,
        kind: WorkKind,
        id: u64,
        worker: AccountAddress,
        agent: Option<u64>,
        expiry_ms: u64,
    ) -> SignatureEd25519 {
        let msg = work_message(kind, &WorkAttestation {
            contract: self.contract,
            bounty_id: id,
            worker,
            agent,
            expiry: ts(expiry_ms),
        });
        sign(key, &msg)
    }

    pub fn claim(&mut self, id: u64, worker: AccountAddress) -> CallResult {
        let expiry = self.now_ms() + 60_000;
        let signature = self.work_signature(&attestor(), WorkKind::Claim, id, worker, None, expiry);
        self.call(worker, "claim", &ClaimParams { id, agent: None, attestation_expiry: ts(expiry), signature })
    }

    pub fn submit(&mut self, id: u64, worker: AccountAddress) -> CallResult {
        self.call(worker, "submit", &SubmitParams { id, work_hash: WORK })
    }

    pub fn enter(&mut self, id: u64, worker: AccountAddress) -> CallResult {
        let expiry = self.now_ms() + 60_000;
        let signature = self.work_signature(&attestor(), WorkKind::Enter, id, worker, None, expiry);
        self.call(worker, "enter", &EnterParams {
            id,
            agent: None,
            work_hash: WORK,
            attestation_expiry: ts(expiry),
            signature,
        })
    }

    pub fn fund(&mut self, id: u64) -> CallResult {
        self.call(OPERATOR, "confirm_funding", &ConfirmFundingParams { id, tx: TX1 })
    }
}
