import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Detail } from "../api.js";
import { AccountLink, Amount, Banner, FeeNotice, FundingBadge, KindBadge, StatusPill, TxLink, formatAmount } from "../components.js";
import { Icon } from "../icons.js";
import { useSession } from "../session.js";
import { relative } from "../time.js";

type Work = { workHash: string; worker: string; full: string; hashMatches: boolean }[];

export function BountyPage({ id }: { id: string }) {
  const { config, account, run, busy, setToast, names, learnNames } = useSession();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [full, setFull] = useState("");
  const [reason, setReason] = useState("");
  const [work, setWork] = useState<Work | null>(null);
  const [lastPrepared, setLastPrepared] = useState<import("../types.js").Prepared | null>(null);

  const load = useCallback(() => {
    api
      .bounty(id)
      .then((x) => {
        learnNames(x.names);
        setD(x);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [id, learnNames]);
  useEffect(load, [load]);

  if (error) return <Banner kind="err">{error}</Banner>;
  if (!d) return <p className="muted">Loading…</p>;

  const b = d.bounty;
  const decimals = config?.decimals ?? 6;
  const token = config?.rewardToken ?? "EUDemo";
  const isPoster = account === b.poster;
  const now = Date.now();
  const beforeDeadline = now < Number(b.deadline);
  const s = b.status;

  async function act(label: string, action: string, body: unknown = {}) {
    const r = await run(label, async () => {
      const p = await api.act(id, action, body);
      setLastPrepared(p.prepared);
      return p;
    });
    if (r) load();
  }

  async function fetchWork() {
    try {
      setWork((await api.work(id)).items);
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) setToast({ kind: "info", text: "This delivery is paid on delivery: pay the worker first." });
      else setToast({ kind: "error", text: (e as Error).message });
    }
  }

  const owedNotFunded = b.funding.type === "NotFunded" && ["Accepted", "AcceptedUnpaid", "Awarded"].includes(s.type);
  const workReleased = (b.funding.type === "Escrowed" && ["Accepted", "Awarded", "Splitting", "Paid"].includes(s.type)) || s.type === "Paid";

  return (
    <article className="stack page">
      <div className="page-head">
        <a href="#/board" className="icon-btn" aria-label="Back to the board">
          <Icon name="back" />
        </a>
      </div>

      <header className="stack tight">
        <div className="row">
          <StatusPill status={s} />
          <FundingBadge funding={b.funding} />
          <KindBadge kind={b.kind} />
        </div>
        <h1>{d.spec?.title ?? `Bounty ${b.id}`}</h1>
        <p>
          Posted by <AccountLink address={b.poster} name={names[b.poster]} />
        </p>
        <Amount units={b.reward} decimals={decimals} token={token} big />
        <p className="meta">
          deadline {relative(Number(b.deadline))}
          {b.rejections > 0 && ` · ${b.rejections} of 2 rejections used`}
        </p>
      </header>

      <div className="columns">
        <div className="stack">
          <section className="card stack">
            <h2>Task</h2>
            <p>{d.spec?.description}</p>
            <dl className="kv">
              <dt>Task kind</dt>
              <dd>
                <code>{d.spec?.taskKind}</code>
              </dd>
              <dt>Input</dt>
              <dd>
                <code>{JSON.stringify(d.spec?.input)}</code>
              </dd>
              <dt>Spec hash (on chain)</dt>
              <dd>
                <code className="break">{b.specHash}</code>
              </dd>
            </dl>
          </section>

          <section className="card stack">
            <h2>What you can do</h2>
            <FeeNotice prepared={lastPrepared} />
            {!account && <p>Connect Concordium Wallet for Web to claim, submit or manage this bounty.</p>}

            {account && !isPoster && b.kind === "Exclusive" && s.type === "Open" && beforeDeadline && (
              <div className="row">
                <button className="btn" disabled={busy} onClick={() => act("Claim", "claim")}>
                  Claim this bounty
                </button>
              </div>
            )}

            {account && !isPoster && ((b.kind === "Exclusive" && s.type === "Claimed" && s.worker === account) || (b.kind === "Contest" && s.type === "Open" && beforeDeadline)) && (
              <div className="stack">
                <label className="field">
                  <span>Preview (shown to the poster now)</span>
                  <textarea value={preview} onChange={(e) => setPreview(e.target.value)} rows={2} />
                </label>
                <label className="field">
                  <span>Full work (released on acceptance or payment; only its SHA-256 goes on chain)</span>
                  <textarea value={full} onChange={(e) => setFull(e.target.value)} rows={5} />
                </label>
                <div className="row">
                  <button className="btn" disabled={busy || !full} onClick={() => act(b.kind === "Contest" ? "Enter" : "Submit", "submit", { preview, full })}>
                    {b.kind === "Contest" ? "Enter the contest" : "Submit work"}
                  </button>
                </div>
              </div>
            )}

            {isPoster && b.funding.type === "NotFunded" && ["Open", "Claimed", "Submitted"].includes(s.type) && (
              <div className="row">
                <button className="btn money" disabled={busy} onClick={() => act("Fund escrow", "fund-transfer")} title="Move the reward into the board's custodial escrow account; payout then follows the contract.">
                  Fund escrow ({formatAmount(b.reward, decimals)} {token})
                </button>
              </div>
            )}

            {isPoster && s.type === "Open" && b.entryCount === 0 && (
              <div className="row">
                <button className="btn ghost" disabled={busy} onClick={() => act("Cancel", "cancel")}>
                  Cancel bounty
                </button>
              </div>
            )}

            {isPoster && s.type === "Submitted" && (
              <div className="stack">
                <div className="quote">{d.submission?.preview ?? "No preview stored."}</div>
                <div className="row">
                  <button className="btn money" disabled={busy} onClick={() => act("Accept", "accept")}>
                    Accept
                  </button>
                </div>
                <div className="row">
                  <input className="input" placeholder="Reason for rejecting" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button className="btn danger" disabled={busy || !reason} onClick={() => act("Reject", "reject", { reason })} title="The third rejection is final and goes on your public record.">
                    Reject ({b.rejections}/2 used)
                  </button>
                </div>
              </div>
            )}

            {isPoster && b.kind === "Contest" && s.type === "Open" && !beforeDeadline && d.entries.length > 0 && (
              <div className="stack">
                <p>Pick the winner before the review window ends, or an escrowed reward is split among all entrants.</p>
                <ul className="ledger">
                  {d.entries.map((e) => (
                    <li key={e.entryId}>
                      <span>
                        #{e.entryId} by <AccountLink address={e.worker} name={names[e.worker]} />: <span className="muted">{e.preview ?? "no preview"}</span>
                      </span>
                      <button className="btn" disabled={busy} onClick={() => act("Award", "award", { entryId: e.entryId })}>
                        Award
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isPoster && owedNotFunded && (
              <div className="row">
                <button className="btn money" disabled={busy} onClick={() => act("Pay the worker", "pay-transfer")} title="Pays the worker directly (fee sponsored); the board records it as the payout.">
                  Pay the worker and unlock the work
                </button>
              </div>
            )}

            {isPoster && workReleased && (
              <div className="row">
                <button className="btn ghost" onClick={fetchWork}>
                  Show the delivered work
                </button>
              </div>
            )}
            {work && (
              <div className="stack">
                {work.map((w) => (
                  <div key={w.workHash} className="stack tight">
                    <pre className="well">{w.full}</pre>
                    <span className="meta">SHA-256 matches the hash recorded on chain: {w.hashMatches ? "yes" : "NO"}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="stack">
          <section className="card stack">
            <h2>Poster</h2>
            <p>
              <AccountLink address={b.poster} name={names[b.poster]} />
              {d.posterProfile.identity && (
                <span>
                  {" "}
                  · verified {d.posterProfile.identity.kind} ({d.posterProfile.identity.idpName})
                </span>
              )}
            </p>
            <dl className="kv">
              <dt>Posted</dt>
              <dd>{d.posterProfile.stats.posted}</dd>
              <dt>Paid out</dt>
              <dd>{d.posterProfile.stats.paidAsPoster}</dd>
              <dt>Accepted, unpaid</dt>
              <dd className={d.posterProfile.stats.unpaid > 0 ? "danger" : ""}>{d.posterProfile.stats.unpaid}</dd>
              <dt>Final rejections</dt>
              <dd className={d.posterProfile.stats.rejectedFinal > 0 ? "danger" : ""}>{d.posterProfile.stats.rejectedFinal}</dd>
              <dt>Unawarded contests</dt>
              <dd className={d.posterProfile.stats.noAward > 0 ? "danger" : ""}>{d.posterProfile.stats.noAward}</dd>
            </dl>
          </section>
          <section className="card stack">
            <h2>On-chain record</h2>
            {d.events.length === 0 && <p className="meta">No events recorded by this board yet.</p>}
            <ol className="ledger">
              {d.events.map((e) => (
                <li key={`${e.tx}:${e.index}`}>
                  <span>{e.event.type}</span>
                  <TxLink hash={e.tx} />
                </li>
              ))}
            </ol>
            <a href={d.links.contract} target="_blank" rel="noreferrer" className="meta">
              deplace contract on CCDExplorer
            </a>
          </section>
        </aside>
      </div>
    </article>
  );
}
