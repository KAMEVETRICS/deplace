import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Amount, Banner, FundingBadge, KindBadge, StatusPill, short } from "../components.js";
import { useSession } from "../session.js";
import type { Bounty } from "../types.js";
import { relative } from "../time.js";

const FILTERS: { label: string; q: Record<string, string> }[] = [
  { label: "All", q: {} },
  { label: "Open", q: { status: "Open" } },
  { label: "Escrowed", q: { funding: "Escrowed" } },
  { label: "Not funded", q: { funding: "NotFunded" } },
  { label: "Contests", q: { kind: "Contest" } },
  { label: "Paid", q: { status: "Paid" } },
];

export function BountyCard({ b, decimals, token }: { b: Bounty; decimals: number; token: string }) {
  return (
    <a className="card ticket" href={`#/b/${b.id}`}>
      <div className="row between">
        <div className="row">
          <StatusPill status={b.status} />
          <FundingBadge funding={b.funding} />
        </div>
        <KindBadge kind={b.kind} />
      </div>
      <h3>{b.spec?.title ?? `Bounty ${b.id}`}</h3>
      <p className="clamp">{b.spec?.description ?? "Spec not stored on this board."}</p>
      <div className="card-foot">
        <Amount units={b.reward} decimals={decimals} token={token} />
        <span className="meta">
          deadline {relative(Number(b.deadline))} · by {short(b.poster)}
        </span>
      </div>
    </a>
  );
}

export function Board() {
  const { config } = useSession();
  const [filter, setFilter] = useState(0);
  const [bounties, setBounties] = useState<Bounty[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = config?.rewardToken ?? "EUDemo";

  useEffect(() => {
    setBounties(null);
    api
      .bounties(FILTERS[filter]!.q)
      .then((r) => setBounties(r.bounties))
      .catch((e) => setError((e as Error).message));
  }, [filter]);

  return (
    <section className="stack page">
      <div className="page-head">
        <div className="stack tight">
          <h1>Bounties</h1>
          <p className="lede">
            Every poster and worker is tied to a verified Concordium identity or a "Verified by Concordium" agent badge. Rewards are paid in {token}, fees are sponsored, and every claim, submission and
            payout is recorded on chain.
          </p>
        </div>
        <a className="btn" href="#/post">
          Post a bounty
        </a>
      </div>
      <div className="tabs" role="tablist" aria-label="Filter bounties">
        {FILTERS.map((f, i) => (
          <button key={f.label} role="tab" aria-selected={i === filter} onClick={() => setFilter(i)}>
            {f.label}
          </button>
        ))}
      </div>
      {error && <Banner kind="err">{error}</Banner>}
      {bounties === null && !error && <p className="muted">Loading…</p>}
      {bounties?.length === 0 && (
        <div className="empty">
          <p className="lede">No bounties here yet.</p>
        </div>
      )}
      <div className="grid two">
        {bounties?.map((b) => <BountyCard key={b.id} b={b} decimals={config?.decimals ?? 6} token={token} />)}
      </div>
    </section>
  );
}
