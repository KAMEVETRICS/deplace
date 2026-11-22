// UI development only: serves fixture data on :8787 so the web app can be viewed without
// testnet. Writes (claim, post, ...) answer 503. Run: npx tsx scripts/mock-api.ts
import express from "express";

const H = (c: string) => c.repeat(64).slice(0, 64);
const POSTER = "3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8";
const WORKER = "4UC8o4m8AgTxt5VBFMdLwMCwwJQVJwjesNzW7RPXkACynrULmd";
const now = Date.now();
const spec = (title: string, kind: string, url: string) => ({
  title,
  description: `Fetch ${url} and report its title, visible word count and the SHA-256 of the body.`,
  taskKind: "page-facts",
  input: { url },
  kind,
  reward: "2",
  rewardToken: "EUDemo",
  deadline: now + 7_200_000,
  poster: POSTER,
  posterAgent: null,
});
const bounties = [
  { id: "2", poster: POSTER, posterAgent: null, kind: "Contest", specHash: H("c"), reward: "5000000", funding: { type: "Escrowed", fundingTx: H("1") }, deadline: String(now + 5_400_000), status: { type: "Open" }, rejections: 0, lastRejectedAt: null, entryCount: 2, created: String(now - 600_000), spec: { ...spec("Best summary of the Concordium x402 spec", "Contest", "https://docs.x402.org"), reward: "5" } },
  { id: "1", poster: POSTER, posterAgent: null, kind: "Exclusive", specHash: H("b"), reward: "2000000", funding: { type: "NotFunded" }, deadline: String(now + 3_600_000), status: { type: "Submitted", worker: WORKER, agent: "1392", workHash: H("d"), at: String(now - 60_000) }, rejections: 0, lastRejectedAt: null, entryCount: 0, created: String(now - 1_800_000), spec: spec("Page facts for concordium.com", "Exclusive", "https://www.concordium.com") },
  { id: "0", poster: POSTER, posterAgent: null, kind: "Exclusive", specHash: H("a"), reward: "1000000", funding: { type: "Escrowed", fundingTx: H("2") }, deadline: String(now + 7_200_000), status: { type: "Open" }, rejections: 0, lastRejectedAt: null, entryCount: 0, created: String(now - 3_600_000), spec: spec("Page facts for example.org", "Exclusive", "https://example.org") },
];
const stats = { posted: 3, paidAsPoster: 1, unpaid: 0, rejectedFinal: 0, noAward: 0, paidAsWorker: 0 };

const app = express();
app.get("/config", (_q, r) => r.json({ rewardToken: "EUDemo", decimals: 6, contract: { index: "13001", subindex: "0" }, escrowAccount: POSTER, sponsorAccount: WORKER, faucetUrl: null }));
app.get("/contract/schema", (_q, r) => r.status(404).json({ error: "mock" }));
app.get("/bounties", (q, r) =>
  r.json({
    bounties: bounties.filter(
      (b) => (!q.query.status || b.status.type === q.query.status) && (!q.query.kind || b.kind === q.query.kind) && (!q.query.funding || b.funding.type === q.query.funding) && (!q.query.poster || b.poster === q.query.poster),
    ),
  }),
);
app.get("/bounties/:id", (q, r) => {
  const b = bounties.find((x) => x.id === q.params.id);
  if (!b) return void r.status(404).json({ error: "no such bounty" });
  r.json({
    bounty: b,
    spec: b.spec,
    submission: b.status.type === "Submitted" ? { workHash: H("d"), preview: 'Fetched https://www.concordium.com: title "Concordium", 412 words. Full result on acceptance.' } : null,
    entries: b.kind === "Contest" ? [0, 1].map((i) => ({ entryId: i, worker: WORKER, workHash: H(String(i + 5)), agent: null, at: "0", preview: `Entry ${i + 1} preview` })) : [],
    events: [
      { tx: H("e"), index: 0, at: now - 3_000_000, link: "#", event: { type: "Posted" } },
      { tx: H("f"), index: 0, at: now - 2_000_000, link: "#", event: { type: "Funded" } },
    ],
    posterProfile: { stats, identity: { kind: "person", idpName: "Concordium testnet IP" } },
    links: { contract: "https://ccdexplorer.io/testnet/instance/13001/0", poster: `https://ccdexplorer.io/testnet/account/${POSTER}`, posterAgent: null },
  });
});
app.get("/profiles/:a", (q, r) => r.json({ account: q.params.a, stats, identity: { kind: "person", idpName: "Concordium testnet IP" }, link: `https://ccdexplorer.io/testnet/account/${q.params.a}` }));
app.use((_q, r) => r.status(503).json({ error: "mock API: writes need the real board server" }));
app.listen(8787, () => console.log("mock API on http://localhost:8787"));
