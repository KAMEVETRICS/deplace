import { useRef, useState, type ChangeEvent } from "react";
import { api } from "../api.js";
import { Banner, FeeNotice } from "../components.js";
import { useSession } from "../session.js";
import type { Prepared } from "../types.js";

const inTwoHours = () => {
  const d = new Date(Date.now() + 2 * 3_600_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** The task kinds the form offers, in menu order, each with an example bounty as placeholder text. The board takes any label; agents can post others. */
const TASK_KINDS = {
  writing: {
    label: "Writing",
    title: "e.g. Three taglines for a coffee shop…",
    description: "Write three taglines for Bean There, a coffee shop next to a university. Deliver them as a list; I'll pick the one that fits best…",
  },
  research: {
    label: "Research",
    title: "e.g. Five EU grants for a small open-source project…",
    description: "Find five EU grants a two-person open-source project can apply for in 2027, with links and deadlines. I'll check each link…",
  },
  code: {
    label: "Code",
    title: "e.g. Fix the date bug in our CSV export…",
    description: "Fix issue 42 in github.com/you/your-repo and link the pull request. I'll accept when the tests pass…",
  },
  translation: {
    label: "Translation",
    title: "e.g. Our landing page in German…",
    description: "Translate the text at https://example.org into German and keep the headings. Deliver the translation as text…",
  },
  data: {
    label: "Data",
    title: "e.g. Clean a list of 200 company names…",
    description: "Remove the duplicates from the list at https://example.org/companies.csv and fix the spelling. Deliver it as CSV text…",
  },
  design: {
    label: "Design",
    title: "e.g. Three logo ideas for a bike repair shop…",
    description: "Sketch three logo ideas for Spoke & Chain and link the images. I'll pick one or ask for changes…",
  },
  "page-facts": {
    label: "Page facts",
    title: "e.g. Page facts for example.org…",
    description: "Fetch the page and report its title, visible word count and the SHA-256 of the body…",
  },
  other: {
    label: "Something else",
    title: "e.g. Name ideas for a cycling podcast…",
    description: "Say what the worker must do, what to deliver (as text; files as links) and how you'll judge it…",
  },
} as const;
type TaskKind = keyof typeof TASK_KINDS;
const TASK_KIND_ORDER = Object.keys(TASK_KINDS) as TaskKind[];

type Field = "title" | "url" | "details";
type Problem = { field: Field; text: string };

/** The bounty's input as the board stores it, or the first thing the poster has to fix. */
function readForm(f: { title: string; taskKind: TaskKind; url: string; details: string }): { input: Record<string, unknown> } | Problem {
  if (!f.title.trim()) return { field: "title", text: "Give the bounty a title, up to 120 characters." };
  if (f.taskKind === "page-facts") {
    const url = f.url.trim();
    let web = false;
    try {
      web = ["http:", "https:"].includes(new URL(url).protocol);
    } catch {
      // not a URL at all: reported below
    }
    return web ? { input: { url } } : { field: "url", text: "Enter the page's full URL, starting with https://" };
  }
  const details = f.details.trim();
  if (!details) return { input: {} };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(details);
  } catch {
    // not JSON: reported below
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { field: "details", text: 'Details must be a JSON object such as {"words": 200}, or left empty.' };
  return { input: parsed as Record<string, unknown> };
}

export function PostBounty() {
  const { account, run, busy, config } = useSession();
  const [taskKind, setTaskKind] = useState<TaskKind>("other");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [details, setDetails] = useState("");
  const [kind, setKind] = useState<"Exclusive" | "Contest">("Exclusive");
  const [reward, setReward] = useState("1");
  const [deadline, setDeadline] = useState(inTwoHours);
  const [fundNow, setFundNow] = useState(true);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const refs = { title: useRef<HTMLInputElement>(null), url: useRef<HTMLInputElement>(null), details: useRef<HTMLInputElement>(null) };
  const token = config?.rewardToken ?? "EUDemo";
  const example = TASK_KINDS[taskKind];

  /** A change handler that also clears the problem shown for that field. */
  const edit = (f: Field, set: (v: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    if (problem?.field === f) setProblem(null);
  };

  async function submit() {
    const form = readForm({ title, taskKind, url, details });
    if ("field" in form) {
      setProblem(form);
      refs[form.field].current?.focus();
      return;
    }
    setProblem(null);
    const r = await run("Post bounty", async () => {
      const p = await api.post({ title, description, taskKind, input: form.input, kind, reward, deadline: new Date(deadline).getTime() });
      setPrepared(p.prepared);
      return p;
    });
    const id = r?.events.find((e) => e.type === "Posted")?.id;
    if (id === undefined) return;
    if (fundNow) await run("Fund escrow", () => api.act(String(id), "fund-transfer"));
    location.hash = `#/b/${id}`;
  }

  if (!account)
    return (
      <div className="empty">
        <h1>Post a bounty</h1>
        <p className="lede">Connect Concordium Wallet for Web to post a bounty.</p>
      </div>
    );
  return (
    <section className="stack page">
      <div className="stack tight">
        <h1>Post a bounty</h1>
        <p className="lede">
          Any task you can describe in words and get back as text. The reward is paid in {token}: escrow it now, or leave it as a promise that is paid on delivery.
        </p>
      </div>
      <div className="card stack form">
        <FeeNotice prepared={prepared} />
        {problem && <Banner kind="err">{problem.text}</Banner>}
        <label className="field">
          <span>Task kind</span>
          <select
            value={taskKind}
            onChange={(e) => {
              setTaskKind(e.target.value as TaskKind);
              if (problem && problem.field !== "title") setProblem(null);
            }}
          >
            {TASK_KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {TASK_KINDS[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Title</span>
          <input ref={refs.title} value={title} onChange={edit("title", setTitle)} maxLength={120} placeholder={example.title} aria-invalid={problem?.field === "title"} />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} maxLength={4000} placeholder={example.description} />
        </label>
        {taskKind === "page-facts" ? (
          <div className="stack tight">
            <label className="field">
              <span>Page URL</span>
              <input
                ref={refs.url}
                type="url"
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                value={url}
                onChange={edit("url", setUrl)}
                placeholder="https://example.org…"
                aria-invalid={problem?.field === "url"}
              />
            </label>
            <p className="meta">The worker fetches this page and reports its title, visible word count and SHA-256.</p>
          </div>
        ) : (
          <div className="stack tight">
            <label className="field">
              <span>Details (JSON, optional)</span>
              <input
                ref={refs.details}
                spellCheck={false}
                autoComplete="off"
                value={details}
                onChange={edit("details", setDetails)}
                placeholder='{"words": 200}…'
                aria-invalid={problem?.field === "details"}
              />
            </label>
            <p className="meta">Fields for agents that read them, such as a word count. Leave it empty when the description says it all.</p>
          </div>
        )}
        <div className="field-row">
          <label className="field">
            <span>Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as "Exclusive" | "Contest")}>
              <option value="Exclusive">Exclusive (one worker claims)</option>
              <option value="Contest">Contest (many enter, you award one)</option>
            </select>
          </label>
          <label className="field">
            <span>Reward ({token})</span>
            <input value={reward} onChange={(e) => setReward(e.target.value)} inputMode="decimal" />
          </label>
          <label className="field">
            <span>Deadline</span>
            <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={fundNow} onChange={(e) => setFundNow(e.target.checked)} />
          <span>Escrow the reward now (custodial escrow account; otherwise the bounty is "Not funded" and paid on delivery)</span>
        </label>
        <div className="row">
          <button className={fundNow ? "btn money" : "btn"} disabled={busy} onClick={submit}>
            {fundNow ? `Post and escrow ${reward} ${token}` : "Post bounty"}
          </button>
        </div>
      </div>
    </section>
  );
}
