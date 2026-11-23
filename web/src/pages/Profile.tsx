import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Banner } from "../components.js";
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

  if (error) return <Banner kind="err">{error}</Banner>;
  if (!p) return <p className="muted">Loading…</p>;
  // Marks that go on an account's public record read as danger once they are above zero.
  const stats: [label: string, value: number, mark: boolean][] = [
    ["Posted", p.stats.posted, false],
    ["Paid out", p.stats.paidAsPoster, false],
    ["Accepted, unpaid", p.stats.unpaid, true],
    ["Final rejections", p.stats.rejectedFinal, true],
    ["Unawarded contests", p.stats.noAward, true],
    ["Paid as worker", p.stats.paidAsWorker, false],
  ];
  return (
    <section className="stack page">
      <div className="stack tight">
        <span className="kicker">Public record</span>
        <h1>{p.identity ? `Verified ${p.identity.kind}` : "Account"}</h1>
        <p className="meta break">
          {account}
          {p.identity && ` · ${p.identity.idpName}`} ·{" "}
          <a href={p.link} target="_blank" rel="noreferrer">
            CCDExplorer
          </a>
        </p>
      </div>
      <div className="stats">
        {stats.map(([label, value, mark]) => (
          <div key={label} className={mark && value > 0 ? "card stat danger" : "card stat"}>
            <div className="stat-value">{value}</div>
            <div className="meta">{label}</div>
          </div>
        ))}
      </div>
      <h2>Bounties posted</h2>
      {posted.length === 0 ? (
        <p>None yet.</p>
      ) : (
        <div className="grid two">
          {posted.map((b) => (
            <BountyCard key={b.id} b={b} decimals={config?.decimals ?? 6} token={config?.rewardToken ?? "EUDemo"} />
          ))}
        </div>
      )}
    </section>
  );
}
