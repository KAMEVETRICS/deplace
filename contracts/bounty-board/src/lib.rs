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
