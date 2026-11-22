//! Messages the board's attestor key signs and this contract verifies.
//!
//! Layout: ASCII domain tag (not length-prefixed) followed by the Concordium binary
//! serialization of the struct. Must stay byte-identical to packages/shared/src/attest.ts;
//! both test suites assert the same golden vectors.

use concordium_std::*;

pub const POST_DOMAIN: &[u8] = b"Deplace/v1/post";
pub const CLAIM_DOMAIN: &[u8] = b"Deplace/v1/claim";
pub const ENTER_DOMAIN: &[u8] = b"Deplace/v1/enter";

/// The board checked the poster's identity (and agent badge, if any) for this spec, with
/// exactly these terms: the on-chain record cannot differ from what the board showed.
#[derive(Serial, Debug, Clone)]
pub struct PostAttestation {
    pub contract: ContractAddress,
    pub poster: AccountAddress,
    pub poster_agent: Option<u64>,
    pub kind: crate::state::Kind,
    pub spec_hash: HashSha2256,
    pub reward: u64,
    pub deadline: Timestamp,
    pub expiry: Timestamp,
}

/// The board checked the worker's identity or badge, challenge signature and payout eligibility.
#[derive(Serial, Debug, Clone)]
pub struct WorkAttestation {
    pub contract: ContractAddress,
    pub bounty_id: u64,
    pub worker: AccountAddress,
    pub agent: Option<u64>,
    pub expiry: Timestamp,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum WorkKind {
    Claim,
    Enter,
}

fn message<T: Serial>(domain: &[u8], body: &T) -> Vec<u8> {
    let mut out = Vec::from(domain);
    body.serial(&mut out).unwrap_abort();
    out
}

pub fn post_message(a: &PostAttestation) -> Vec<u8> { message(POST_DOMAIN, a) }

pub fn work_message(kind: WorkKind, a: &WorkAttestation) -> Vec<u8> {
    match kind {
        WorkKind::Claim => message(CLAIM_DOMAIN, a),
        WorkKind::Enter => message(ENTER_DOMAIN, a),
    }
}
