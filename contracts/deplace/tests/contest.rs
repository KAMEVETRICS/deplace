mod common;

use deplace::*;
use common::*;
use concordium_smart_contract_testing::*;

/// A Contest (reward 100) with entries from WORKER and WORKER2.
fn contest(env: &mut Env, escrowed: bool) -> u64 {
    let id = env.post(Kind::Contest, 100);
    if escrowed {
        env.fund(id).unwrap();
    }
    env.enter(id, WORKER).unwrap();
    env.enter(id, WORKER2).unwrap();
    id
}

#[test]
fn contest_award_happy_path() {
    let mut env = Env::new();
    let id = env.post(Kind::Contest, 100);
    env.fund(id).unwrap();
    let e = env.enter(id, WORKER).unwrap();
    assert_eq!(events(&e), vec![Event::Entered { id, entry_id: 0, worker: WORKER, agent: None, work_hash: WORK }]);
    env.enter(id, WORKER2).unwrap();
    assert_eq!(env.bounty(id).entry_count, 2);
    let entry: Option<Entry> = env.view("view_entry", &EntryKey { id, entry_id: 1 });
    assert_eq!(entry.unwrap().worker, WORKER2);

    env.advance(HOUR_MS);
    let a = env.call(POSTER, "award", &AwardParams { id, entry_id: 1 }).unwrap();
    assert_eq!(events(&a), vec![Event::Awarded { id, entry_id: 1, worker: WORKER2 }]);
    assert!(matches!(env.bounty(id).status, Status::Awarded { entry_id: 1, .. }));

    env.call(OPERATOR, "record_payout", &RecordPayoutParams { id, payouts: vec![Payout { to: WORKER2, amount: 100, tx: TX2 }] })
        .unwrap();
    assert_eq!(env.bounty(id).status, Status::Paid);
    assert_eq!(env.stats(WORKER2).paid_as_worker, 1);
    assert_eq!(env.stats(POSTER).paid_as_poster, 1);
}

#[test]
fn award_pays_only_the_winner() {
    let mut env = Env::new();
    let id = contest(&mut env, true);
    env.advance(HOUR_MS);
    env.call(POSTER, "award", &AwardParams { id, entry_id: 0 }).unwrap();
    let r = env.call(OPERATOR, "record_payout", &RecordPayoutParams { id, payouts: vec![Payout { to: WORKER2, amount: 100, tx: TX2 }] });
    assert_eq!(reject_reason(r), Error::InvalidParams);
}

#[test]
fn enter_twice_same_worker_fails() {
    let mut env = Env::new();
    let id = env.post(Kind::Contest, 100);
    env.enter(id, WORKER).unwrap();
    assert_eq!(reject_reason(env.enter(id, WORKER)), Error::AlreadyEntered);
}

#[test]
fn enter_rules() {
    let mut env = Env::new();
    let exclusive = env.post(Kind::Exclusive, 100);
    assert_eq!(reject_reason(env.enter(exclusive, WORKER)), Error::WrongKind);

    let id = env.post(Kind::Contest, 100);
    assert_eq!(reject_reason(env.enter(id, POSTER)), Error::InvalidParams);

    // A claim attestation does not work for an entry.
    let expiry = env.now_ms() + 60_000;
    let signature = env.work_signature(&attestor(), WorkKind::Claim, id, WORKER, None, expiry);
    let r = env.call(WORKER, "enter", &EnterParams { id, agent: None, work_hash: WORK, attestation_expiry: ts(expiry), signature });
    assert_eq!(reject_reason(r), Error::BadSignature);

    env.advance(HOUR_MS + 1);
    assert_eq!(reject_reason(env.enter(id, WORKER)), Error::DeadlinePassed);
}

#[test]
fn award_timing_and_caller() {
    let mut env = Env::new();
    let id = contest(&mut env, true);
    assert_eq!(reject_reason(env.call(POSTER, "award", &AwardParams { id, entry_id: 0 })), Error::DeadlineNotPassed);
    env.advance(HOUR_MS);
    assert_eq!(reject_reason(env.call(WORKER, "award", &AwardParams { id, entry_id: 0 })), Error::Unauthorized);
    assert_eq!(reject_reason(env.call(POSTER, "award", &AwardParams { id, entry_id: 7 })), Error::NotFound);
    env.advance(REVIEW_MS);
    assert_eq!(reject_reason(env.call(POSTER, "award", &AwardParams { id, entry_id: 0 })), Error::DeadlinePassed);
}

#[test]
fn split_unawarded_amounts() {
    let mut env = Env::new();
    let id = env.post(Kind::Contest, 100);
    env.fund(id).unwrap();
    env.enter(id, WORKER).unwrap();
    env.enter(id, WORKER2).unwrap();
    env.enter(id, OTHER).unwrap();

    env.advance(HOUR_MS);
    assert_eq!(reject_reason(env.call(OTHER, "split_unawarded", &id)), Error::WindowNotPassed);
    env.advance(REVIEW_MS);
    let r = env.call(OTHER, "split_unawarded", &id).unwrap();
    assert_eq!(events(&r), vec![Event::SplitStarted { id, entries: 3 }]);

    let shares: Vec<SplitShare> = env.view("view_split", &id);
    assert_eq!(shares, vec![
        SplitShare { to: WORKER, amount: 34 },
        SplitShare { to: WORKER2, amount: 33 },
        SplitShare { to: OTHER, amount: 33 },
    ]);

    let wrong = RecordPayoutParams {
        id,
        payouts: vec![Payout { to: WORKER, amount: 34, tx: TX1 }, Payout { to: WORKER2, amount: 33, tx: TX2 }],
    };
    assert_eq!(reject_reason(env.call(OPERATOR, "record_payout", &wrong)), Error::InvalidParams);

    let right = RecordPayoutParams {
        id,
        payouts: vec![
            Payout { to: WORKER, amount: 34, tx: TX1 },
            Payout { to: WORKER2, amount: 33, tx: TX2 },
            Payout { to: OTHER, amount: 33, tx: TX3 },
        ],
    };
    env.call(OPERATOR, "record_payout", &right).unwrap();
    assert_eq!(env.bounty(id).status, Status::Paid);
    for w in [WORKER, WORKER2, OTHER] {
        assert_eq!(env.stats(w).paid_as_worker, 1);
    }
}

#[test]
fn split_requires_escrow() {
    let mut env = Env::new();
    let id = contest(&mut env, false);
    env.advance(HOUR_MS + REVIEW_MS);
    assert_eq!(reject_reason(env.call(OTHER, "split_unawarded", &id)), Error::NotEscrowed);
}

#[test]
fn no_award_requires_not_funded_and_increments_stats() {
    let mut env = Env::new();
    let escrowed = contest(&mut env, true);
    env.advance(HOUR_MS + REVIEW_MS);
    assert_eq!(reject_reason(env.call(OTHER, "no_award", &escrowed)), Error::WrongStatus);

    let id = contest(&mut env, false);
    env.advance(HOUR_MS);
    assert_eq!(reject_reason(env.call(OTHER, "no_award", &id)), Error::WindowNotPassed);
    env.advance(REVIEW_MS);
    let r = env.call(OTHER, "no_award", &id).unwrap();
    assert_eq!(events(&r), vec![Event::NoAward { id }]);
    assert_eq!(env.bounty(id).status, Status::NoAward);
    assert_eq!(env.stats(POSTER).no_award, 1);
}

#[test]
fn awarded_but_unpaid_contest_is_marked() {
    let mut env = Env::new();
    let id = contest(&mut env, false);
    env.advance(HOUR_MS);
    env.call(POSTER, "award", &AwardParams { id, entry_id: 1 }).unwrap();
    assert_eq!(reject_reason(env.call(OTHER, "mark_unpaid", &id)), Error::WindowNotPassed);
    env.advance(PAYMENT_MS);
    env.call(OTHER, "mark_unpaid", &id).unwrap();
    assert_eq!(env.bounty(id).status, Status::AcceptedUnpaid { worker: WORKER2, work_hash: WORK });
    assert_eq!(env.stats(POSTER).unpaid, 1);
}

#[test]
fn contest_with_no_entries_expires_and_refunds() {
    let mut env = Env::new();
    let id = env.post(Kind::Contest, 100);
    env.fund(id).unwrap();
    env.advance(HOUR_MS + 1);
    env.call(OTHER, "expire", &id).unwrap();
    assert_eq!(env.bounty(id).status, Status::Expired);
    env.call(OPERATOR, "record_refund", &RecordRefundParams { id, tx: TX3 }).unwrap();
}

#[test]
fn contest_with_entries_cannot_be_cancelled_or_expired() {
    let mut env = Env::new();
    let id = contest(&mut env, true);
    assert_eq!(reject_reason(env.call(POSTER, "cancel", &id)), Error::WrongStatus);
    env.advance(HOUR_MS + 1);
    assert_eq!(reject_reason(env.call(OTHER, "expire", &id)), Error::WrongStatus);
}

#[test]
fn contest_entry_cap() {
    let mut env = Env::new();
    let id = env.post(Kind::Contest, 1_000);
    for i in 0..MAX_ENTRIES {
        let w = AccountAddress([100 + (i as u8); 32]);
        env.chain.create_account(Account::new(w, Amount::from_ccd(10)));
        env.enter(id, w).unwrap();
    }
    let late = AccountAddress([250; 32]);
    env.chain.create_account(Account::new(late, Amount::from_ccd(10)));
    assert_eq!(reject_reason(env.enter(id, late)), Error::ContestFull);
}
