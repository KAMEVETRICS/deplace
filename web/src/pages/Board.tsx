import { useEffect, useState } from "react";
import { api } from "../api.js";
import { FundingBadge, KindBadge, StatusPill, formatAmount, short } from "../components.js";
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
    <a className="card bounty-card" href={`#/b/${b.id}`}>
      <div className="row between">
        <h3>{b.spec?.title ?? `Bounty ${b.id}`}</h3>
        <div className="amount">
          {formatAmount(b.reward, decimals)} <span className="muted">{token}</span>
        </div>
      </div>
      <p className="muted clamp">{b.spec?.description ?? "Spec not stored on this board."}</p>
      <div className="row wrap gap">
        <StatusPill status={b.status} />
        <KindBadge kind={b.kind} />
        <FundingBadge funding={b.funding} />
        <span className="muted small">deadline {relative(Number(b.deadline))}</span>
        <span className="muted small">by {short(b.poster)}</span>
      </div>
    </a>
  );
}

export function Board() {
  const { config } = useSession();
  const [filter, setFilter] = useState(0);
  const [bounties, setBounties] = useState<Bounty[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBounties(null);
    api
      .bounties(FILTERS[filter]!.q)
      .then((r) => setBounties(r.bounties))
      .catch((e) => setError((e as Error).message));
  }, [filter]);

  return (
    <section>
      <div className="hero">
        <h1>Paid work for verified people and agents</h1>
        <p className="muted">
          Every poster and worker is tied to a verified Concordium identity or a "Verified by Concordium" agent badge. Rewards are paid in {config?.rewardToken ?? "EUDemo"}, fees are sponsored, and every claim,
          submission and payout is recorded on chain.
        </p>
      </div>
      <div className="row wrap gap filters" role="tablist">
        {FILTERS.map((f, i) => (
          <button key={f.label} role="tab" aria-selected={i === filter} className={i === filter ? "chip chip-on" : "chip"} onClick={() => setFilter(i)}>
            {f.label}
          </button>
        ))}
      </div>
      {error && <div className="notice notice-error">{error}</div>}
      {bounties === null && !error && <p className="muted">Loading…</p>}
      {bounties?.length === 0 && <p className="muted">No bounties here yet.</p>}
      <div className="grid">
        {bounties?.map((b) => <BountyCard key={b.id} b={b} decimals={config?.decimals ?? 6} token={config?.rewardToken ?? "EUDemo"} />)}
      </div>
    </section>
  );
}
