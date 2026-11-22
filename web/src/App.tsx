import { useEffect, useState } from "react";
import { short } from "./components.js";
import { BountyPage } from "./pages/BountyPage.js";
import { Board } from "./pages/Board.js";
import { PostBounty } from "./pages/PostBounty.js";
import { Profile } from "./pages/Profile.js";
import { useSession } from "./session.js";

function useHash(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function Page({ hash }: { hash: string }) {
  const { account } = useSession();
  let m: RegExpMatchArray | null;
  if ((m = hash.match(/^#\/b\/(\d+)$/))) return <BountyPage id={m[1]!} />;
  if ((m = hash.match(/^#\/p\/([1-9A-HJ-NP-Za-km-z]{40,60})$/))) return <Profile account={m[1]!} />;
  if (hash === "#/post") return <PostBounty />;
  if (hash === "#/me") return account ? <Profile account={account} /> : <p className="muted">Connect your wallet to see your record.</p>;
  return <Board />;
}

export function App() {
  const hash = useHash();
  const { identity, account, connect, busy, toast, setToast } = useSession();
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          Deplace <span className="muted small">on Concordium testnet</span>
        </a>
        <nav className="row gap">
          <a href="#/">Board</a>
          <a href="#/post">Post</a>
          <a href="#/me">My record</a>
          {account ? (
            <span className="who" title={account}>
              {identity?.label ?? "Signed in"} · {short(account)}
            </span>
          ) : (
            <button className="primary" disabled={busy} onClick={connect}>
              Connect wallet
            </button>
          )}
        </nav>
      </header>
      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status">
          <span>{toast.text}</span>
          {toast.link && (
            <a href={toast.link} target="_blank" rel="noreferrer">
              View on CCDExplorer
            </a>
          )}
          {toast.faucetUrl && (
            <a href={toast.faucetUrl} target="_blank" rel="noreferrer">
              Get on the allow list (faucet)
            </a>
          )}
          <button className="link" aria-label="Dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
      <main className="container">
        <Page hash={hash} />
      </main>
      <footer className="container muted small">
        Escrow is custodial: escrowed rewards sit in the board's operator account and move only as the deplace contract's state allows. Protocol-Level Locks replace it once they reach testnet.
      </footer>
    </>
  );
}
