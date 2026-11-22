import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useSession } from "../session.js";
import type { Bounty, Stats } from "../types.js";
import { BountyCard } from "./Board.js";

export function Profile({ account }: { account: string }) {
  const { config } = useSession();
  const [p, setP] = useState<{ stats: Stats; identity: { kind: string; idpName: string } | null; link: string } | null>(null);
  const [posted, setPosted] = useState<Bounty[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.profile(account).then(setP).catch((e) => setError((e as Error).message));
    api.bounties({ poster: account }).then((r) => setPosted(r.bounties)).catch(() => setPosted([]));
  }, [account]);

  if (error) return <div className="notice notice-error">{error}</div>;
  if (!p) return <p className="muted">Loading…</p>;
  return (
    <section className="stack">
      <h1 className="break">{account}</h1>
      <p className="muted">
        {p.identity ? `Verified ${p.identity.kind} (${p.identity.idpName})` : "Identity not found"} ·{" "}
        <a href={p.link} target="_blank" rel="noreferrer">
          CCDExplorer
        </a>
      </p>
      <div className="stats">
        {(
          [
            ["Posted", p.stats.posted],
            ["Paid out", p.stats.paidAsPoster],
            ["Accepted, unpaid", p.stats.unpaid],
            ["Final rejections", p.stats.rejectedFinal],
            ["Unawarded contests", p.stats.noAward],
            ["Paid as worker", p.stats.paidAsWorker],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="card stat">
            <div className="stat-value">{v}</div>
            <div className="muted small">{k}</div>
          </div>
        ))}
      </div>
      <h2>Bounties posted</h2>
      <div className="grid">
        {posted.map((b) => (
          <BountyCard key={b.id} b={b} decimals={config?.decimals ?? 6} token={config?.rewardToken ?? "EUDemo"} />
        ))}
      </div>
    </section>
  );
}
