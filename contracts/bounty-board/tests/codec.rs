mod common;

use bounty_board::*;
use common::*;
use concordium_smart_contract_testing::*;

// Same golden vectors as packages/shared/test/codec.test.ts: the TS codec decodes and
// encodes exactly these bytes, so the server reads and writes what the contract does.

fn bytes<T: Serial>(v: &T) -> String { hex(&to_bytes(v)) }

#[test]
fn bounty_vector_matches_typescript() {
    let b = Some(Bounty {
        id: 7,
        poster: AccountAddress([3; 32]),
        poster_agent: Some(5),
        kind: Kind::Contest,
        spec_hash: HashSha2256([0xab; 32]),
        reward: 100,
        funding: Funding::Escrowed { funding_tx: HashSha2256([0x11; 32]) },
        deadline: ts(0x0102030405060708),
        status: Status::Submitted {
            worker: AccountAddress([4; 32]),
            agent: None,
            work_hash: HashSha2256([0xcd; 32]),
            at: ts(9),
        },
        rejections: 2,
        last_rejected_at: Some(ts(8)),
        entry_count: 3,
        created: ts(1),
    });
    let expected = format!(
        "01{}{}01{}01{}{}01{}{}02{}00{}{}02{}{}{}",
        "0700000000000000",
        "03".repeat(32),
        "0500000000000000",
        "ab".repeat(32),
        "6400000000000000",
        "11".repeat(32),
        "0807060504030201",
        "04".repeat(32),
        "cd".repeat(32),
        "0900000000000000",
        "010800000000000000",
        "03000000",
        "0100000000000000"
    );
    assert_eq!(bytes(&b), expected);
}

#[test]
fn event_vectors_match_typescript() {
    let payout = Event::PayoutRecorded { id: 7, to: AccountAddress([4; 32]), amount: 100, tx: HashSha2256([0x22; 32]) };
    assert_eq!(bytes(&payout), format!("0a0700000000000000{}6400000000000000{}", "04".repeat(32), "22".repeat(32)));

    let posted = Event::Posted {
        id: 0,
        poster: AccountAddress([3; 32]),
        poster_agent: None,
        kind: Kind::Exclusive,
        reward: 100,
        spec_hash: HashSha2256([0xab; 32]),
        deadline: ts(0x0102030405060708),
    };
    assert_eq!(
        bytes(&posted),
        format!("000000000000000000{}00006400000000000000{}0807060504030201", "03".repeat(32), "ab".repeat(32))
    );
}

#[test]
fn record_payout_vector_matches_typescript() {
    let p = RecordPayoutParams {
        id: 7,
        payouts: vec![
            Payout { to: AccountAddress([4; 32]), amount: 34, tx: HashSha2256([0x11; 32]) },
            Payout { to: AccountAddress([5; 32]), amount: 33, tx: HashSha2256([0x22; 32]) },
        ],
    };
    assert_eq!(
        bytes(&p),
        format!(
            "070000000000000002000000{}2200000000000000{}{}2100000000000000{}",
            "04".repeat(32),
            "11".repeat(32),
            "05".repeat(32),
            "22".repeat(32)
        )
    );
}
