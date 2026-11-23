import { useEffect, useState } from "react";
import { Banner } from "./components.js";
import { BountyPage } from "./pages/BountyPage.js";
import { Board } from "./pages/Board.js";
import { PostBounty } from "./pages/PostBounty.js";
import { Profile } from "./pages/Profile.js";
import { useSession } from "./session.js";
import { Shell, type Route } from "./Shell.js";

function useHash(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function routeOf(hash: string, account: string | null): Route {
  if (hash === "#/" || hash.startsWith("#/b/")) return "board";
  if (hash === "#/post") return "post";
  if (hash === "#/me" || (account !== null && hash === `#/p/${account}`)) return "me";
  return "other";
}

function Page({ hash }: { hash: string }) {
  const { account } = useSession();
  let m: RegExpMatchArray | null;
  if ((m = hash.match(/^#\/b\/(\d+)$/))) return <BountyPage id={m[1]!} />;
  if ((m = hash.match(/^#\/p\/([1-9A-HJ-NP-Za-km-z]{40,60})$/))) return <Profile account={m[1]!} />;
  if (hash === "#/post") return <PostBounty />;
  if (hash === "#/me")
    return account ? (
      <Profile account={account} />
    ) : (
      <div className="empty">
        <h1>Your record</h1>
        <p className="lede">Connect your wallet to see what you posted, paid and earned.</p>
      </div>
    );
  return <Board />;
}

export function App() {
  const hash = useHash();
  const { identity, account, connect, busy, toast, setToast } = useSession();
  return (
    <Shell route={routeOf(hash, account)} account={account} label={identity?.label ?? null} busy={busy} onConnect={connect}>
      <div className="stack page">
        {toast && (
          <Banner kind={toast.kind === "error" ? "err" : toast.kind} onDismiss={() => setToast(null)}>
            {toast.text}
            {toast.link && (
              <>
                {" "}
                <a href={toast.link} target="_blank" rel="noreferrer">
                  View on CCDExplorer
                </a>
              </>
            )}
            {toast.faucetUrl && (
              <>
                {" "}
                <a href={toast.faucetUrl} target="_blank" rel="noreferrer">
                  Get on the allow list (faucet)
                </a>
              </>
            )}
          </Banner>
        )}
        <Page hash={hash} />
      </div>
      <p className="meta foot-note">
        Escrow is custodial: escrowed rewards sit in the board's operator account and move only as the deplace contract's state allows. Protocol-Level Locks replace it once they reach testnet.
      </p>
    </Shell>
  );
}
