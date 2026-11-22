mod common;

use bounty_board::*;
use common::*;
use concordium_smart_contract_testing::*;

fn payout(to: AccountAddress, amount: u64, tx: HashSha2256) -> RecordPayoutParams {
    RecordPayoutParams { id: 0, payouts: vec![Payout { to, amount, tx }] }
}

/// Posts an Exclusive bounty (reward 100), claims and submits it as WORKER.
fn submitted(env: &mut Env, escrowed: bool) -> u64 {
    let id = env.post(Kind::Exclusive, 100);
    if escrowed {
        env.fund(id).unwrap();
    }
    env.claim(id, WORKER).unwrap();
    env.submit(id, WORKER).unwrap();
    id
}

#[test]
fn happy_path_escrowed() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);

    let funded = env.fund(id).unwrap();
    assert_eq!(events(&funded), vec![Event::Funded { id, tx: TX1 }]);
    assert_eq!(env.bounty(id).funding, Funding::Escrowed { funding_tx: TX1 });

    let claimed = env.claim(id, WORKER).unwrap();
    assert_eq!(events(&claimed), vec![Event::Claimed { id, worker: WORKER, agent: None }]);
    assert_eq!(env.bounty(id).status, Status::Claimed { worker: WORKER, agent: None });

    let sub = env.submit(id, WORKER).unwrap();
    assert_eq!(events(&sub), vec![Event::Submitted { id, worker: WORKER, work_hash: WORK }]);

    let acc = env.call(POSTER, "accept", &id).unwrap();
    assert_eq!(events(&acc), vec![Event::Accepted { id, worker: WORKER, auto: false }]);

    let paid = env.call(OPERATOR, "record_payout", &payout(WORKER, 100, TX2)).unwrap();
    assert_eq!(events(&paid), vec![Event::PayoutRecorded { id, to: WORKER, amount: 100, tx: TX2 }]);
    assert_eq!(env.bounty(id).status, Status::Paid);
    assert_eq!(env.stats(POSTER).paid_as_poster, 1);
    assert_eq!(env.stats(WORKER).paid_as_worker, 1);
}

#[test]
fn happy_path_not_funded() {
    let mut env = Env::new();
    let id = submitted(&mut env, false);
    env.call(POSTER, "accept", &id).unwrap();
    env.call(OPERATOR, "record_payout", &payout(WORKER, 100, TX2)).unwrap();
    let b = env.bounty(id);
    assert_eq!(b.status, Status::Paid);
    assert_eq!(b.funding, Funding::NotFunded);
}

#[test]
fn claim_rejects_attestation_for_another_worker() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);
    let expiry = env.now_ms() + 60_000;
    let signature = env.work_signature(&attestor(), WorkKind::Claim, id, WORKER, None, expiry);
    let r = env.call(WORKER2, "claim", &ClaimParams { id, agent: None, attestation_expiry: ts(expiry), signature });
    assert_eq!(reject_reason(r), Error::BadSignature);
}

#[test]
fn claim_rejects_enter_attestation() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);
    let expiry = env.now_ms() + 60_000;
    let signature = env.work_signature(&attestor(), WorkKind::Enter, id, WORKER, None, expiry);
    let r = env.call(WORKER, "claim", &ClaimParams { id, agent: None, attestation_expiry: ts(expiry), signature });
    assert_eq!(reject_reason(r), Error::BadSignature);
}

#[test]
fn claim_after_deadline_fails() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);
    env.advance(HOUR_MS + 1);
    assert_eq!(reject_reason(env.claim(id, WORKER)), Error::DeadlinePassed);
}

#[test]
fn poster_cannot_claim_own_bounty() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);
    assert_eq!(reject_reason(env.claim(id, POSTER)), Error::InvalidParams);
}

#[test]
fn second_claim_fails() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);
    env.claim(id, WORKER).unwrap();
    assert_eq!(reject_reason(env.claim(id, WORKER2)), Error::WrongStatus);
}

#[test]
fn claim_on_contest_fails() {
    let mut env = Env::new();
    let id = env.post(Kind::Contest, 100);
    assert_eq!(reject_reason(env.claim(id, WORKER)), Error::WrongKind);
}

#[test]
fn submit_by_non_worker_fails() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);
    env.claim(id, WORKER).unwrap();
    assert_eq!(reject_reason(env.submit(id, WORKER2)), Error::Unauthorized);
}

#[test]
fn accept_and_reject_are_poster_only() {
    let mut env = Env::new();
    let id = submitted(&mut env, false);
    assert_eq!(reject_reason(env.call(WORKER, "accept", &id)), Error::Unauthorized);
    let r = env.call(WORKER, "reject", &RejectParams { id, reason_hash: SPEC });
    assert_eq!(reject_reason(r), Error::Unauthorized);
}

#[test]
fn three_rejections_finalise() {
    let mut env = Env::new();
    let id = submitted(&mut env, true);

    for n in 1..=2u8 {
        let r = env.call(POSTER, "reject", &RejectParams { id, reason_hash: SPEC }).unwrap();
        assert_eq!(events(&r), vec![Event::Rejected { id, count: n, reason_hash: SPEC }]);
        let b = env.bounty(id);
        assert_eq!(b.status, Status::Claimed { worker: WORKER, agent: None });
        assert_eq!(b.rejections, n);
        env.submit(id, WORKER).unwrap();
    }

    let r = env.call(POSTER, "reject", &RejectParams { id, reason_hash: SPEC }).unwrap();
    assert_eq!(events(&r), vec![Event::Rejected { id, count: 3, reason_hash: SPEC }, Event::RejectedFinal { id }]);
    assert_eq!(env.bounty(id).status, Status::RejectedFinal);
    assert_eq!(env.stats(POSTER).rejected_final, 1);

    // Escrowed money goes back to the poster.
    let refund = env.call(OPERATOR, "record_refund", &RecordRefundParams { id, tx: TX3 }).unwrap();
    assert_eq!(events(&refund), vec![Event::RefundRecorded { id, tx: TX3 }]);
    assert_eq!(env.bounty(id).status, Status::Refunded);
}

#[test]
fn rejection_near_deadline_leaves_time_to_resubmit() {
    let mut env = Env::new();
    let id = submitted(&mut env, true);
    // Poster rejects 30 s before the deadline.
    env.advance(HOUR_MS - 30_000);
    env.call(POSTER, "reject", &RejectParams { id, reason_hash: SPEC }).unwrap();
    // The deadline passes, but the worker is still inside the grace window (REVIEW_MS after the rejection).
    env.advance(30_000 + 1);
    assert_eq!(reject_reason(env.call(OTHER, "expire", &id)), Error::DeadlineNotPassed);
    env.submit(id, WORKER).unwrap();
}

#[test]
fn claimed_bounty_expires_after_grace_window() {
    let mut env = Env::new();
    let id = submitted(&mut env, true);
    env.advance(HOUR_MS - 30_000);
    env.call(POSTER, "reject", &RejectParams { id, reason_hash: SPEC }).unwrap();
    env.advance(REVIEW_MS + 1);
    assert_eq!(reject_reason(env.submit(id, WORKER)), Error::DeadlinePassed);
    env.call(OTHER, "expire", &id).unwrap();
    assert_eq!(env.bounty(id).status, Status::Expired);
}

#[test]
fn open_bounty_expires_after_deadline() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);
    assert_eq!(reject_reason(env.call(OTHER, "expire", &id)), Error::DeadlineNotPassed);
    env.advance(HOUR_MS + 1);
    let r = env.call(OTHER, "expire", &id).unwrap();
    assert_eq!(events(&r), vec![Event::Expired { id }]);
    assert_eq!(env.bounty(id).status, Status::Expired);
}

#[test]
fn auto_accept_requires_escrow_and_window() {
    let mut env = Env::new();
    let unfunded = submitted(&mut env, false);
    env.advance(REVIEW_MS);
    assert_eq!(reject_reason(env.call(OTHER, "auto_accept", &unfunded)), Error::NotEscrowed);

    let id = env.post(Kind::Exclusive, 100);
    env.fund(id).unwrap();
    env.claim(id, WORKER).unwrap();
    env.submit(id, WORKER).unwrap();
    assert_eq!(reject_reason(env.call(OTHER, "auto_accept", &id)), Error::WindowNotPassed);
    env.advance(REVIEW_MS);
    let r = env.call(OTHER, "auto_accept", &id).unwrap();
    assert_eq!(events(&r), vec![Event::Accepted { id, worker: WORKER, auto: true }]);
}

#[test]
fn mark_unpaid_requires_not_funded_and_window() {
    let mut env = Env::new();
    let escrowed = submitted(&mut env, true);
    env.call(POSTER, "accept", &escrowed).unwrap();
    env.advance(PAYMENT_MS);
    assert_eq!(reject_reason(env.call(OTHER, "mark_unpaid", &escrowed)), Error::WrongStatus);

    let id = env.post(Kind::Exclusive, 100);
    env.claim(id, WORKER).unwrap();
    env.submit(id, WORKER).unwrap();
    env.call(POSTER, "accept", &id).unwrap();
    assert_eq!(reject_reason(env.call(OTHER, "mark_unpaid", &id)), Error::WindowNotPassed);
    env.advance(PAYMENT_MS);
    let r = env.call(OTHER, "mark_unpaid", &id).unwrap();
    assert_eq!(events(&r), vec![Event::MarkedUnpaid { id }]);
    assert_eq!(env.bounty(id).status, Status::AcceptedUnpaid { worker: WORKER, work_hash: WORK });
    assert_eq!(env.stats(POSTER).unpaid, 1);

    // A late payment still clears the bounty; the unpaid mark stays on the record.
    env.call(OPERATOR, "record_payout", &RecordPayoutParams { id, payouts: vec![Payout { to: WORKER, amount: 100, tx: TX2 }] })
        .unwrap();
    assert_eq!(env.bounty(id).status, Status::Paid);
    assert_eq!(env.stats(POSTER).unpaid, 1);
}

#[test]
fn record_payout_checks_recipient_amount_and_count() {
    let mut env = Env::new();
    let id = submitted(&mut env, true);
    env.call(POSTER, "accept", &id).unwrap();
    let bad = |env: &mut Env, p: RecordPayoutParams| reject_reason(env.call(OPERATOR, "record_payout", &p));
    assert_eq!(bad(&mut env, payout(WORKER2, 100, TX2)), Error::InvalidParams);
    assert_eq!(bad(&mut env, payout(WORKER, 99, TX2)), Error::InvalidParams);
    let two = RecordPayoutParams {
        id,
        payouts: vec![Payout { to: WORKER, amount: 50, tx: TX2 }, Payout { to: WORKER, amount: 50, tx: TX3 }],
    };
    assert_eq!(bad(&mut env, two), Error::InvalidParams);
    assert_eq!(reject_reason(env.call(OTHER, "record_payout", &payout(WORKER, 100, TX2))), Error::Unauthorized);
}

#[test]
fn record_payout_before_accept_fails() {
    let mut env = Env::new();
    let id = submitted(&mut env, true);
    let r = env.call(OPERATOR, "record_payout", &RecordPayoutParams { id, payouts: vec![Payout { to: WORKER, amount: 100, tx: TX2 }] });
    assert_eq!(reject_reason(r), Error::WrongStatus);
}

#[test]
fn record_refund_only_escrowed() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);
    env.call(POSTER, "cancel", &id).unwrap();
    assert_eq!(reject_reason(env.call(OPERATOR, "record_refund", &RecordRefundParams { id, tx: TX3 })), Error::NotEscrowed);

    let id = env.post(Kind::Exclusive, 100);
    env.fund(id).unwrap();
    env.call(POSTER, "cancel", &id).unwrap();
    assert_eq!(reject_reason(env.call(OTHER, "record_refund", &RecordRefundParams { id, tx: TX3 })), Error::Unauthorized);
    env.call(OPERATOR, "record_refund", &RecordRefundParams { id, tx: TX3 }).unwrap();
    assert_eq!(env.bounty(id).status, Status::Refunded);
}

#[test]
fn confirm_funding_rules() {
    let mut env = Env::new();
    let id = env.post(Kind::Exclusive, 100);
    assert_eq!(reject_reason(env.call(OTHER, "confirm_funding", &ConfirmFundingParams { id, tx: TX1 })), Error::Unauthorized);
    env.fund(id).unwrap();
    assert_eq!(reject_reason(env.fund(id)), Error::WrongStatus);

    // Funding after acceptance is a payment, not escrow.
    let id = submitted(&mut env, false);
    env.call(POSTER, "accept", &id).unwrap();
    assert_eq!(reject_reason(env.fund(id)), Error::WrongStatus);

    // A claimed or submitted bounty can still be upgraded to Escrowed.
    let id = env.post(Kind::Exclusive, 100);
    env.claim(id, WORKER).unwrap();
    env.fund(id).unwrap();
}

#[test]
fn acceptance_records_the_accepted_work_hash() {
    let mut env = Env::new();
    let id = submitted(&mut env, true);
    env.call(POSTER, "accept", &id).unwrap();
    assert!(matches!(env.bounty(id).status, Status::Accepted { worker: WORKER, work_hash: WORK, .. }));
}
