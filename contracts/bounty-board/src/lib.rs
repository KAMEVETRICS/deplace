#![no_std]
//! bounty_board: state machine and audit trail for the Concordium Bounty Board.
//!
//! The contract records who posted, claimed, entered, submitted, accepted, awarded and
//! got paid. It does not hold the reward: Concordium smart contracts cannot hold PLTs,
//! so escrowed rewards sit in the board's operator account, and the operator records each
//! payout or refund here with the token transfer's hash.

use concordium_std::*;

mod attest;
mod state;

pub use attest::*;
pub use state::*;
// Explicit import: concordium_std also exports an `Entry` (the StateMap entry API).
pub use state::Entry;

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    admin: AccountAddress,
    operator: AccountAddress,
    attestor: PublicKeyEd25519,
    registry: ContractAddress,
    reward_token: String,
    review_window_ms: u64,
    payment_window_ms: u64,
    next_id: u64,
    bounties: StateMap<u64, Bounty, S>,
    entries: StateMap<(u64, u32), Entry, S>,
    entered: StateSet<(u64, AccountAddress), S>,
    stats: StateMap<AccountAddress, Stats, S>,
}

type ContractResult<T> = Result<T, Error>;

// --- helpers -----------------------------------------------------------------

fn sender_account(ctx: &ReceiveContext) -> ContractResult<AccountAddress> {
    match ctx.sender() {
        Address::Account(a) => Ok(a),
        Address::Contract(_) => Err(Error::Unauthorized),
    }
}

fn now(ctx: &ReceiveContext) -> Timestamp { ctx.metadata().slot_time() }

fn plus(t: Timestamp, ms: u64) -> Timestamp { Timestamp::from_timestamp_millis(t.timestamp_millis().saturating_add(ms)) }

fn load(host: &Host<State>, id: u64) -> ContractResult<Bounty> {
    host.state().bounties.get(&id).map(|b| b.clone()).ok_or(Error::NotFound)
}

fn store(host: &mut Host<State>, b: Bounty) { let _ = host.state_mut().bounties.insert(b.id, b); }

fn bump(host: &mut Host<State>, account: AccountAddress, f: impl FnOnce(&mut Stats)) {
    let mut s = host.state().stats.get(&account).map(|s| *s).unwrap_or_default();
    f(&mut s);
    let _ = host.state_mut().stats.insert(account, s);
}

fn ensure_admin(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<()> {
    ensure!(sender_account(ctx)? == host.state().admin, Error::Unauthorized);
    Ok(())
}

// --- init --------------------------------------------------------------------

#[init(contract = "bounty_board", parameter = "InitParams", event = "Event")]
fn init(ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    let p: InitParams = ctx.parameter_cursor().get()?;
    Ok(State {
        admin: p.admin,
        operator: p.operator,
        attestor: p.attestor,
        registry: p.registry,
        reward_token: p.reward_token,
        review_window_ms: p.review_window_ms,
        payment_window_ms: p.payment_window_ms,
        next_id: 0,
        bounties: state_builder.new_map(),
        entries: state_builder.new_map(),
        entered: state_builder.new_set(),
        stats: state_builder.new_map(),
    })
}

// --- posting -----------------------------------------------------------------

/// Posts a bounty. The sender is the poster; the attestation proves the board checked
/// the poster's Concordium identity (or agent badge) for exactly this spec.
#[receive(
    contract = "bounty_board",
    name = "post",
    parameter = "PostParams",
    return_value = "u64",
    error = "Error",
    mutable,
    enable_logger,
    crypto_primitives
)]
fn post(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger, crypto: &CryptoPrimitives) -> ContractResult<u64> {
    let poster = sender_account(ctx)?;
    let p: PostParams = ctx.parameter_cursor().get()?;
    let t = now(ctx);
    ensure!(p.reward > 0, Error::InvalidParams);
    ensure!(p.deadline > t, Error::InvalidParams);
    ensure!(t <= p.attestation_expiry, Error::AttestationExpired);
    let msg = post_message(&PostAttestation {
        contract: ctx.self_address(),
        poster,
        poster_agent: p.poster_agent,
        spec_hash: p.spec_hash,
        expiry: p.attestation_expiry,
    });
    ensure!(crypto.verify_ed25519_signature(host.state().attestor, p.signature, &msg), Error::BadSignature);

    let id = host.state().next_id;
    host.state_mut().next_id = id.checked_add(1).ok_or(Error::Overflow)?;
    store(host, Bounty {
        id,
        poster,
        poster_agent: p.poster_agent,
        kind: p.kind,
        spec_hash: p.spec_hash,
        reward: p.reward,
        funding: Funding::NotFunded,
        deadline: p.deadline,
        status: Status::Open,
        rejections: 0,
        last_rejected_at: None,
        entry_count: 0,
        created: t,
    });
    bump(host, poster, |s| s.posted += 1);
    logger.log(&Event::Posted {
        id,
        poster,
        poster_agent: p.poster_agent,
        kind: p.kind,
        reward: p.reward,
        spec_hash: p.spec_hash,
        deadline: p.deadline,
    })?;
    Ok(id)
}

/// The poster withdraws an Open bounty nobody has claimed or entered.
#[receive(contract = "bounty_board", name = "cancel", parameter = "u64", error = "Error", mutable, enable_logger)]
fn cancel(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let mut b = load(host, id)?;
    ensure!(sender_account(ctx)? == b.poster, Error::Unauthorized);
    ensure!(b.status == Status::Open && b.entry_count == 0, Error::WrongStatus);
    b.status = Status::Cancelled;
    store(host, b);
    logger.log(&Event::Cancelled { id })?;
    Ok(())
}

fn ensure_operator(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<()> {
    ensure!(sender_account(ctx)? == host.state().operator, Error::Unauthorized);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn verify_work(
    ctx: &ReceiveContext,
    host: &Host<State>,
    crypto: &CryptoPrimitives,
    kind: WorkKind,
    id: u64,
    worker: AccountAddress,
    agent: Option<u64>,
    expiry: Timestamp,
    signature: SignatureEd25519,
) -> ContractResult<()> {
    ensure!(now(ctx) <= expiry, Error::AttestationExpired);
    let msg = work_message(kind, &WorkAttestation { contract: ctx.self_address(), bounty_id: id, worker, agent, expiry });
    ensure!(crypto.verify_ed25519_signature(host.state().attestor, signature, &msg), Error::BadSignature);
    Ok(())
}

/// After a rejection the worker may resubmit until the later of the deadline and one
/// review window after the rejection, so a late rejection cannot run out the clock.
fn resubmit_until(b: &Bounty, review_window_ms: u64) -> Timestamp {
    match b.last_rejected_at {
        Some(r) => {
            let grace = plus(r, review_window_ms);
            if grace > b.deadline { grace } else { b.deadline }
        }
        None => b.deadline,
    }
}

fn entry_worker(host: &Host<State>, id: u64, entry_id: u32) -> ContractResult<AccountAddress> {
    host.state().entries.get(&(id, entry_id)).map(|e| e.worker).ok_or(Error::NotFound)
}

/// Equal shares of the reward for every entry; the remainder goes to the earliest entry.
fn split_shares(host: &Host<State>, b: &Bounty) -> ContractResult<Vec<SplitShare>> {
    let n = b.entry_count;
    if n == 0 {
        return Ok(Vec::new());
    }
    let base = b.reward / u64::from(n);
    let rest = b.reward % u64::from(n);
    let mut shares = Vec::with_capacity(n as usize);
    for i in 0..n {
        let to = entry_worker(host, b.id, i)?;
        shares.push(SplitShare { to, amount: if i == 0 { base + rest } else { base } });
    }
    Ok(shares)
}

// --- funding -----------------------------------------------------------------

/// The operator saw an exact funding transfer (memo `fund:<id>`) arrive in escrow.
#[receive(contract = "bounty_board", name = "confirm_funding", parameter = "ConfirmFundingParams", error = "Error", mutable, enable_logger)]
fn confirm_funding(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    ensure_operator(ctx, host)?;
    let p: ConfirmFundingParams = ctx.parameter_cursor().get()?;
    let mut b = load(host, p.id)?;
    ensure!(b.funding == Funding::NotFunded, Error::WrongStatus);
    ensure!(matches!(b.status, Status::Open | Status::Claimed { .. } | Status::Submitted { .. }), Error::WrongStatus);
    b.funding = Funding::Escrowed { funding_tx: p.tx };
    store(host, b);
    logger.log(&Event::Funded { id: p.id, tx: p.tx })?;
    Ok(())
}

// --- exclusive flow ----------------------------------------------------------

#[receive(contract = "bounty_board", name = "claim", parameter = "ClaimParams", error = "Error", mutable, enable_logger, crypto_primitives)]
fn claim(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger, crypto: &CryptoPrimitives) -> ContractResult<()> {
    let worker = sender_account(ctx)?;
    let p: ClaimParams = ctx.parameter_cursor().get()?;
    let mut b = load(host, p.id)?;
    ensure!(b.kind == Kind::Exclusive, Error::WrongKind);
    ensure!(b.status == Status::Open, Error::WrongStatus);
    ensure!(now(ctx) < b.deadline, Error::DeadlinePassed);
    ensure!(worker != b.poster, Error::InvalidParams);
    verify_work(ctx, host, crypto, WorkKind::Claim, p.id, worker, p.agent, p.attestation_expiry, p.signature)?;
    b.status = Status::Claimed { worker, agent: p.agent };
    store(host, b);
    logger.log(&Event::Claimed { id: p.id, worker, agent: p.agent })?;
    Ok(())
}

#[receive(contract = "bounty_board", name = "submit", parameter = "SubmitParams", error = "Error", mutable, enable_logger)]
fn submit(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let sender = sender_account(ctx)?;
    let p: SubmitParams = ctx.parameter_cursor().get()?;
    let mut b = load(host, p.id)?;
    ensure!(b.kind == Kind::Exclusive, Error::WrongKind);
    let (worker, agent) = match b.status {
        Status::Claimed { worker, agent } => (worker, agent),
        _ => return Err(Error::WrongStatus),
    };
    ensure!(sender == worker, Error::Unauthorized);
    let t = now(ctx);
    ensure!(t < resubmit_until(&b, host.state().review_window_ms), Error::DeadlinePassed);
    b.status = Status::Submitted { worker, agent, work_hash: p.work_hash, at: t };
    store(host, b);
    logger.log(&Event::Submitted { id: p.id, worker, work_hash: p.work_hash })?;
    Ok(())
}

#[receive(contract = "bounty_board", name = "accept", parameter = "u64", error = "Error", mutable, enable_logger)]
fn accept(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let mut b = load(host, id)?;
    ensure!(sender_account(ctx)? == b.poster, Error::Unauthorized);
    let (worker, work_hash) = match b.status {
        Status::Submitted { worker, work_hash, .. } => (worker, work_hash),
        _ => return Err(Error::WrongStatus),
    };
    b.status = Status::Accepted { worker, at: now(ctx), work_hash };
    store(host, b);
    logger.log(&Event::Accepted { id, worker, auto: false })?;
    Ok(())
}

/// The poster sends the work back. The third rejection is final and goes on the poster's record.
#[receive(contract = "bounty_board", name = "reject", parameter = "RejectParams", error = "Error", mutable, enable_logger)]
fn reject(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let p: RejectParams = ctx.parameter_cursor().get()?;
    let mut b = load(host, p.id)?;
    ensure!(sender_account(ctx)? == b.poster, Error::Unauthorized);
    let (worker, agent) = match b.status {
        Status::Submitted { worker, agent, .. } => (worker, agent),
        _ => return Err(Error::WrongStatus),
    };
    b.rejections = b.rejections.saturating_add(1);
    let count = b.rejections;
    let poster = b.poster;
    let fin = count >= FINAL_REJECTION;
    if fin {
        b.status = Status::RejectedFinal;
    } else {
        b.status = Status::Claimed { worker, agent };
        b.last_rejected_at = Some(now(ctx));
    }
    store(host, b);
    logger.log(&Event::Rejected { id: p.id, count, reason_hash: p.reason_hash })?;
    if fin {
        bump(host, poster, |s| s.rejected_final += 1);
        logger.log(&Event::RejectedFinal { id: p.id })?;
    }
    Ok(())
}

/// Anyone may accept escrowed work the poster left unreviewed for a full review window.
#[receive(contract = "bounty_board", name = "auto_accept", parameter = "u64", error = "Error", mutable, enable_logger)]
fn auto_accept(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let mut b = load(host, id)?;
    let (worker, at, work_hash) = match b.status {
        Status::Submitted { worker, at, work_hash, .. } => (worker, at, work_hash),
        _ => return Err(Error::WrongStatus),
    };
    ensure!(matches!(b.funding, Funding::Escrowed { .. }), Error::NotEscrowed);
    let t = now(ctx);
    ensure!(t >= plus(at, host.state().review_window_ms), Error::WindowNotPassed);
    b.status = Status::Accepted { worker, at: t, work_hash };
    store(host, b);
    logger.log(&Event::Accepted { id, worker, auto: true })?;
    Ok(())
}

/// Closes a bounty nobody delivered on in time (or a contest nobody entered).
#[receive(contract = "bounty_board", name = "expire", parameter = "u64", error = "Error", mutable, enable_logger)]
fn expire(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let mut b = load(host, id)?;
    let t = now(ctx);
    let until = match (b.kind, &b.status) {
        (Kind::Exclusive, Status::Open) => b.deadline,
        (Kind::Exclusive, Status::Claimed { .. }) => resubmit_until(&b, host.state().review_window_ms),
        (Kind::Contest, Status::Open) if b.entry_count == 0 => b.deadline,
        _ => return Err(Error::WrongStatus),
    };
    ensure!(t > until, Error::DeadlineNotPassed);
    b.status = Status::Expired;
    store(host, b);
    logger.log(&Event::Expired { id })?;
    Ok(())
}

/// Puts an accepted or awarded, not-funded bounty that was not paid in time on the poster's record.
#[receive(contract = "bounty_board", name = "mark_unpaid", parameter = "u64", error = "Error", mutable, enable_logger)]
fn mark_unpaid(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let mut b = load(host, id)?;
    ensure!(b.funding == Funding::NotFunded, Error::WrongStatus);
    let (worker, since, work_hash) = match b.status {
        Status::Accepted { worker, at, work_hash } => (worker, at, work_hash),
        Status::Awarded { entry_id, at } => {
            let e = host.state().entries.get(&(id, entry_id)).map(|e| e.clone()).ok_or(Error::NotFound)?;
            (e.worker, at, e.work_hash)
        }
        _ => return Err(Error::WrongStatus),
    };
    ensure!(now(ctx) >= plus(since, host.state().payment_window_ms), Error::WindowNotPassed);
    let poster = b.poster;
    b.status = Status::AcceptedUnpaid { worker, work_hash };
    store(host, b);
    bump(host, poster, |s| s.unpaid += 1);
    logger.log(&Event::MarkedUnpaid { id })?;
    Ok(())
}

// --- payouts and refunds (operator) --------------------------------------------

/// Records the token transfer(s) that paid a bounty: from escrow, or the poster's
/// direct x402 payment for a not-funded bounty. Recipients and amounts must match state.
#[receive(contract = "bounty_board", name = "record_payout", parameter = "RecordPayoutParams", error = "Error", mutable, enable_logger)]
fn record_payout(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    ensure_operator(ctx, host)?;
    let p: RecordPayoutParams = ctx.parameter_cursor().get()?;
    let mut b = load(host, p.id)?;
    let single = |to: AccountAddress| p.payouts.len() == 1 && p.payouts[0].to == to && p.payouts[0].amount >= b.reward;
    let valid = match b.status {
        Status::Accepted { worker, .. } | Status::AcceptedUnpaid { worker, .. } => single(worker),
        Status::Awarded { entry_id, .. } => single(entry_worker(host, p.id, entry_id)?),
        Status::Splitting { .. } => {
            let shares = split_shares(host, &b)?;
            shares.len() == p.payouts.len() && shares.iter().zip(p.payouts.iter()).all(|(s, q)| s.to == q.to && s.amount == q.amount)
        }
        _ => return Err(Error::WrongStatus),
    };
    ensure!(valid, Error::InvalidParams);
    let poster = b.poster;
    b.status = Status::Paid;
    store(host, b);
    bump(host, poster, |s| s.paid_as_poster += 1);
    for q in &p.payouts {
        bump(host, q.to, |s| s.paid_as_worker += 1);
        logger.log(&Event::PayoutRecorded { id: p.id, to: q.to, amount: q.amount, tx: q.tx })?;
    }
    Ok(())
}

#[receive(contract = "bounty_board", name = "record_refund", parameter = "RecordRefundParams", error = "Error", mutable, enable_logger)]
fn record_refund(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    ensure_operator(ctx, host)?;
    let p: RecordRefundParams = ctx.parameter_cursor().get()?;
    let mut b = load(host, p.id)?;
    ensure!(matches!(b.funding, Funding::Escrowed { .. }), Error::NotEscrowed);
    ensure!(matches!(b.status, Status::Cancelled | Status::Expired | Status::RejectedFinal), Error::WrongStatus);
    b.status = Status::Refunded;
    store(host, b);
    logger.log(&Event::RefundRecorded { id: p.id, tx: p.tx })?;
    Ok(())
}

// --- contest flow --------------------------------------------------------------

#[receive(contract = "bounty_board", name = "enter", parameter = "EnterParams", error = "Error", mutable, enable_logger, crypto_primitives)]
fn enter(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger, crypto: &CryptoPrimitives) -> ContractResult<()> {
    let worker = sender_account(ctx)?;
    let p: EnterParams = ctx.parameter_cursor().get()?;
    let mut b = load(host, p.id)?;
    ensure!(b.kind == Kind::Contest, Error::WrongKind);
    ensure!(b.status == Status::Open, Error::WrongStatus);
    let t = now(ctx);
    ensure!(t < b.deadline, Error::DeadlinePassed);
    ensure!(worker != b.poster, Error::InvalidParams);
    verify_work(ctx, host, crypto, WorkKind::Enter, p.id, worker, p.agent, p.attestation_expiry, p.signature)?;
    ensure!(!host.state().entered.contains(&(p.id, worker)), Error::AlreadyEntered);
    ensure!(b.entry_count < MAX_ENTRIES, Error::ContestFull);
    let entry_id = b.entry_count;
    b.entry_count += 1;
    let _ = host.state_mut().entries.insert((p.id, entry_id), Entry { worker, agent: p.agent, work_hash: p.work_hash, at: t });
    let _ = host.state_mut().entered.insert((p.id, worker));
    store(host, b);
    logger.log(&Event::Entered { id: p.id, entry_id, worker, agent: p.agent, work_hash: p.work_hash })?;
    Ok(())
}

/// The poster picks the winning entry between the deadline and the end of the review window.
#[receive(contract = "bounty_board", name = "award", parameter = "AwardParams", error = "Error", mutable, enable_logger)]
fn award(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let p: AwardParams = ctx.parameter_cursor().get()?;
    let mut b = load(host, p.id)?;
    ensure!(sender_account(ctx)? == b.poster, Error::Unauthorized);
    ensure!(b.kind == Kind::Contest, Error::WrongKind);
    ensure!(b.status == Status::Open, Error::WrongStatus);
    let t = now(ctx);
    ensure!(t >= b.deadline, Error::DeadlineNotPassed);
    ensure!(t < plus(b.deadline, host.state().review_window_ms), Error::DeadlinePassed);
    ensure!(p.entry_id < b.entry_count, Error::NotFound);
    let worker = entry_worker(host, p.id, p.entry_id)?;
    b.status = Status::Awarded { entry_id: p.entry_id, at: t };
    store(host, b);
    logger.log(&Event::Awarded { id: p.id, entry_id: p.entry_id, worker })?;
    Ok(())
}

/// An escrowed contest the poster did not award in time is split among all entrants.
#[receive(contract = "bounty_board", name = "split_unawarded", parameter = "u64", error = "Error", mutable, enable_logger)]
fn split_unawarded(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let mut b = load(host, id)?;
    ensure!(b.kind == Kind::Contest, Error::WrongKind);
    ensure!(b.status == Status::Open && b.entry_count > 0, Error::WrongStatus);
    ensure!(matches!(b.funding, Funding::Escrowed { .. }), Error::NotEscrowed);
    let t = now(ctx);
    ensure!(t >= plus(b.deadline, host.state().review_window_ms), Error::WindowNotPassed);
    let entries = b.entry_count;
    b.status = Status::Splitting { at: t };
    store(host, b);
    logger.log(&Event::SplitStarted { id, entries })?;
    Ok(())
}

/// A not-funded contest the poster did not award in time: closed, and on the poster's record.
#[receive(contract = "bounty_board", name = "no_award", parameter = "u64", error = "Error", mutable, enable_logger)]
fn no_award(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let mut b = load(host, id)?;
    ensure!(b.kind == Kind::Contest, Error::WrongKind);
    ensure!(b.status == Status::Open && b.entry_count > 0 && b.funding == Funding::NotFunded, Error::WrongStatus);
    ensure!(now(ctx) >= plus(b.deadline, host.state().review_window_ms), Error::WindowNotPassed);
    let poster = b.poster;
    b.status = Status::NoAward;
    store(host, b);
    bump(host, poster, |s| s.no_award += 1);
    logger.log(&Event::NoAward { id })?;
    Ok(())
}

// --- admin -------------------------------------------------------------------

#[receive(contract = "bounty_board", name = "set_attestor", parameter = "PublicKeyEd25519", error = "Error", mutable, enable_logger)]
fn set_attestor(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    ensure_admin(ctx, host)?;
    host.state_mut().attestor = ctx.parameter_cursor().get()?;
    logger.log(&Event::AdminChanged { what: 0 })?;
    Ok(())
}

#[receive(contract = "bounty_board", name = "set_operator", parameter = "AccountAddress", error = "Error", mutable, enable_logger)]
fn set_operator(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    ensure_admin(ctx, host)?;
    host.state_mut().operator = ctx.parameter_cursor().get()?;
    logger.log(&Event::AdminChanged { what: 1 })?;
    Ok(())
}

#[receive(contract = "bounty_board", name = "set_admin", parameter = "AccountAddress", error = "Error", mutable, enable_logger)]
fn set_admin(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    ensure_admin(ctx, host)?;
    host.state_mut().admin = ctx.parameter_cursor().get()?;
    logger.log(&Event::AdminChanged { what: 2 })?;
    Ok(())
}

// --- views -------------------------------------------------------------------

#[receive(contract = "bounty_board", name = "view_bounty", parameter = "u64", return_value = "Option<Bounty>", error = "Error")]
fn view_bounty(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<Option<Bounty>> {
    let id: u64 = ctx.parameter_cursor().get()?;
    Ok(host.state().bounties.get(&id).map(|b| b.clone()))
}

#[receive(contract = "bounty_board", name = "view_entry", parameter = "EntryKey", return_value = "Option<Entry>", error = "Error")]
fn view_entry(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<Option<Entry>> {
    let k: EntryKey = ctx.parameter_cursor().get()?;
    Ok(host.state().entries.get(&(k.id, k.entry_id)).map(|e| e.clone()))
}

/// The shares an unawarded escrowed contest pays out (the escrow worker uses this).
#[receive(contract = "bounty_board", name = "view_split", parameter = "u64", return_value = "Vec<SplitShare>", error = "Error")]
fn view_split(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<Vec<SplitShare>> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let b = load(host, id)?;
    split_shares(host, &b)
}

#[receive(contract = "bounty_board", name = "view_stats", parameter = "AccountAddress", return_value = "Stats", error = "Error")]
fn view_stats(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<Stats> {
    let account: AccountAddress = ctx.parameter_cursor().get()?;
    Ok(host.state().stats.get(&account).map(|s| *s).unwrap_or_default())
}

#[receive(contract = "bounty_board", name = "view_config", return_value = "ConfigView", error = "Error")]
fn view_config(_ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<ConfigView> {
    let s = host.state();
    Ok(ConfigView {
        admin: s.admin,
        operator: s.operator,
        attestor: s.attestor,
        registry: s.registry,
        reward_token: s.reward_token.clone(),
        review_window_ms: s.review_window_ms,
        payment_window_ms: s.payment_window_ms,
        next_id: s.next_id,
    })
}
