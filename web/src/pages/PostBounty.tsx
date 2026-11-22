import { useState } from "react";
import { api } from "../api.js";
import { FeeNotice } from "../components.js";
import { useSession } from "../session.js";
import type { Prepared } from "../types.js";

const inTwoHours = () => {
  const d = new Date(Date.now() + 2 * 3_600_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function PostBounty() {
  const { account, run, busy, config, setToast } = useSession();
  const [title, setTitle] = useState("Page facts for example.org");
  const [description, setDescription] = useState("Fetch the page and report its title, visible word count and the SHA-256 of the body.");
  const [taskKind, setTaskKind] = useState("page-facts");
  const [input, setInput] = useState('{"url":"https://example.org"}');
  const [kind, setKind] = useState<"Exclusive" | "Contest">("Exclusive");
  const [reward, setReward] = useState("1");
  const [deadline, setDeadline] = useState(inTwoHours);
  const [fundNow, setFundNow] = useState(true);
  const [prepared, setPrepared] = useState<Prepared | null>(null);

  async function submit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      setToast({ kind: "error", text: "Input must be valid JSON." });
      return;
    }
    const r = await run("Post bounty", async () => {
      const p = await api.post({ title, description, taskKind, input: parsed, kind, reward, deadline: new Date(deadline).getTime() });
      setPrepared(p.prepared);
      return p;
    });
    const id = r?.events.find((e) => e.type === "Posted")?.id;
    if (id === undefined) return;
    if (fundNow) await run("Fund escrow", () => api.act(String(id), "fund-transfer"));
    location.hash = `#/b/${id}`;
  }

  if (!account) return <p className="muted">Connect Concordium Wallet for Web to post a bounty.</p>;
  return (
    <section className="card stack form">
      <h1>Post a bounty</h1>
      <FeeNotice prepared={prepared} />
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </label>
      <div className="row gap wrap">
        <label>
          Task kind
          <input value={taskKind} onChange={(e) => setTaskKind(e.target.value)} />
        </label>
        <label className="grow">
          Input (JSON)
          <input value={input} onChange={(e) => setInput(e.target.value)} />
        </label>
      </div>
      <div className="row gap wrap">
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as "Exclusive" | "Contest")}>
            <option value="Exclusive">Exclusive (one worker claims)</option>
            <option value="Contest">Contest (many enter, you award one)</option>
          </select>
        </label>
        <label>
          Reward ({config?.rewardToken ?? "EUDemo"})
          <input value={reward} onChange={(e) => setReward(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Deadline
          <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
      </div>
      <label className="row gap">
        <input type="checkbox" checked={fundNow} onChange={(e) => setFundNow(e.target.checked)} />
        Escrow the reward now (custodial escrow account; otherwise the bounty is "Not funded" and paid on delivery)
      </label>
      <button className="primary" disabled={busy} onClick={submit}>
        Post bounty
      </button>
    </section>
  );
}
