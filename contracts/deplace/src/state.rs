//! Bounty records, parameters, events and errors.

use concordium_std::*;

/// Most entries a contest accepts. Bounds the split payout list and its energy.
pub const MAX_ENTRIES: u32 = 64;
/// The third rejection of an Exclusive bounty is final.
pub const FINAL_REJECTION: u8 = 3;

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Exclusive,
    Contest,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Funding {
    /// The reward is the poster's promise, paid on delivery.
    NotFunded,
    /// The reward sits in the board's (custodial) escrow account.
    Escrowed { funding_tx: HashSha2256 },
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub enum Status {
    Open,
    Claimed { worker: AccountAddress, agent: Option<u64> },
    Submitted { worker: AccountAddress, agent: Option<u64>, work_hash: HashSha2256, at: Timestamp },
    /// `work_hash` anchors exactly which submission was accepted.
    Accepted { worker: AccountAddress, at: Timestamp, work_hash: HashSha2256 },
    Awarded { entry_id: u32, at: Timestamp },
    Splitting { at: Timestamp },
    Paid,
    /// Accepted or awarded, not funded, and not paid within the payment window. Keeps the payee.
    AcceptedUnpaid { worker: AccountAddress, work_hash: HashSha2256 },
    RejectedFinal,
    NoAward,
    Expired,
    Cancelled,
    Refunded,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Bounty {
    pub id: u64,
    pub poster: AccountAddress,
    pub poster_agent: Option<u64>,
    pub kind: Kind,
    pub spec_hash: HashSha2256,
    /// In the reward token's smallest unit.
    pub reward: u64,
    pub funding: Funding,
    pub deadline: Timestamp,
    pub status: Status,
    pub rejections: u8,
    pub last_rejected_at: Option<Timestamp>,
    pub entry_count: u32,
    pub created: Timestamp,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Entry {
    pub worker: AccountAddress,
    pub agent: Option<u64>,
    pub work_hash: HashSha2256,
    pub at: Timestamp,
}

/// Public track record per account.
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Stats {
    pub posted: u32,
    pub paid_as_poster: u32,
    pub unpaid: u32,
    pub rejected_final: u32,
    pub no_award: u32,
    pub paid_as_worker: u32,
}

// --- parameters --------------------------------------------------------------

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct InitParams {
    pub admin: AccountAddress,
    pub operator: AccountAddress,
    pub attestor: PublicKeyEd25519,
    pub registry: ContractAddress,
    pub reward_token: String,
    pub review_window_ms: u64,
    pub payment_window_ms: u64,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct PostParams {
    pub kind: Kind,
    pub poster_agent: Option<u64>,
    pub spec_hash: HashSha2256,
    pub reward: u64,
    pub deadline: Timestamp,
    pub attestation_expiry: Timestamp,
    pub signature: SignatureEd25519,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct ClaimParams {
    pub id: u64,
    pub agent: Option<u64>,
    pub attestation_expiry: Timestamp,
    pub signature: SignatureEd25519,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct SubmitParams {
    pub id: u64,
    pub work_hash: HashSha2256,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct EnterParams {
    pub id: u64,
    pub agent: Option<u64>,
    pub work_hash: HashSha2256,
    pub attestation_expiry: Timestamp,
    pub signature: SignatureEd25519,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct ConfirmFundingParams {
    pub id: u64,
    pub tx: HashSha2256,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct RejectParams {
    pub id: u64,
    pub reason_hash: HashSha2256,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Payout {
    pub to: AccountAddress,
    pub amount: u64,
    pub tx: HashSha2256,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct RecordPayoutParams {
    pub id: u64,
    pub payouts: Vec<Payout>,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct RecordRefundParams {
    pub id: u64,
    pub tx: HashSha2256,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct AwardParams {
    pub id: u64,
    pub entry_id: u32,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct EntryKey {
    pub id: u64,
    pub entry_id: u32,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct SplitShare {
    pub to: AccountAddress,
    pub amount: u64,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct ConfigView {
    pub admin: AccountAddress,
    pub operator: AccountAddress,
    pub attestor: PublicKeyEd25519,
    pub registry: ContractAddress,
    pub reward_token: String,
    pub review_window_ms: u64,
    pub payment_window_ms: u64,
    pub next_id: u64,
}

// --- events and errors -------------------------------------------------------

/// Every state change is logged; these events are the board's on-chain audit trail.
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
#[concordium(repr(u8))]
pub enum Event {
    Posted {
        id: u64,
        poster: AccountAddress,
        poster_agent: Option<u64>,
        kind: Kind,
        reward: u64,
        spec_hash: HashSha2256,
        deadline: Timestamp,
    },
    Funded { id: u64, tx: HashSha2256 },
    Claimed { id: u64, worker: AccountAddress, agent: Option<u64> },
    Submitted { id: u64, worker: AccountAddress, work_hash: HashSha2256 },
    Entered { id: u64, entry_id: u32, worker: AccountAddress, agent: Option<u64>, work_hash: HashSha2256 },
    Accepted { id: u64, worker: AccountAddress, auto: bool },
    Rejected { id: u64, count: u8, reason_hash: HashSha2256 },
    RejectedFinal { id: u64 },
    Awarded { id: u64, entry_id: u32, worker: AccountAddress },
    SplitStarted { id: u64, entries: u32 },
    PayoutRecorded { id: u64, to: AccountAddress, amount: u64, tx: HashSha2256 },
    RefundRecorded { id: u64, tx: HashSha2256 },
    MarkedUnpaid { id: u64 },
    NoAward { id: u64 },
    Expired { id: u64 },
    Cancelled { id: u64 },
    /// 0 = attestor, 1 = operator, 2 = admin.
    AdminChanged { what: u8 },
}

#[derive(Serialize, SchemaType, Debug, PartialEq, Eq, Reject)]
pub enum Error {
    #[from(ParseError)]
    ParseError,
    #[from(LogError)]
    LogFull,
    Unauthorized,
    BadSignature,
    AttestationExpired,
    WrongStatus,
    WrongKind,
    NotEscrowed,
    DeadlinePassed,
    DeadlineNotPassed,
    WindowNotPassed,
    InvalidParams,
    NotFound,
    AlreadyEntered,
    ContestFull,
    RegistryCheckFailed,
    Overflow,
}
