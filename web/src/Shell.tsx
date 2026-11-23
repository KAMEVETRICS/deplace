import type { ReactNode } from "react";
import { short } from "./components.js";
import { Icon, type IconName } from "./icons.js";

export type Route = "board" | "post" | "me" | "other";

interface Item {
  route: Route;
  href: string;
  label: string;
  icon: IconName;
}

const BOARD: Item[] = [
  { route: "board", href: "#/", label: "Board", icon: "board" },
  { route: "post", href: "#/post", label: "Post", icon: "post" },
];
const YOU: Item[] = [{ route: "me", href: "#/me", label: "My record", icon: "me" }];

function Brand({ className = "" }: { className?: string }) {
  return (
    <a className={`brand ${className}`} href="#/">
      <span className="stamp" aria-hidden>
        D
      </span>
      <span className="wordmark">Deplace</span>
    </a>
  );
}

/** D place's frame: sidebar on desktop, top bar, bottom dock on phones. */
export function Shell({
  route,
  account,
  label,
  busy,
  onConnect,
  children,
}: {
  route: Route;
  account: string | null;
  label: string | null;
  busy: boolean;
  onConnect(): void;
  children: ReactNode;
}) {
  const link = (i: Item) => (
    <a key={i.href} href={i.href} aria-current={i.route === route ? "page" : undefined}>
      <Icon name={i.icon} />
      {i.label}
    </a>
  );
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="side">
        <Brand />
        <div className="nav-label">Board</div>
        <nav aria-label="Board">{BOARD.map(link)}</nav>
        <div className="nav-label">You</div>
        <nav aria-label="You">{YOU.map(link)}</nav>
        <p className="meta foot">Concordium testnet</p>
      </aside>
      <header className="top">
        <Brand className="phone-brand" />
        <div className="greet desk-only">
          <p className="hello">Hello</p>
          <p>{account ? "Rewards in EUDemo. Fees paid by the board's sponsor." : "Connect Concordium Wallet for Web to post, claim or get paid."}</p>
        </div>
        {account ? (
          <a className="userchip" href="#/me" title={account}>
            <span className="avatar" aria-hidden>
              {(label ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{label ?? "Signed in"}</strong>
              <small>{short(account)}</small>
            </span>
          </a>
        ) : (
          <button className="btn money" disabled={busy} onClick={onConnect}>
            <Icon name="wallet" />
            Connect wallet
          </button>
        )}
      </header>
      <main id="main" className="main">
        {children}
      </main>
      <nav className="dock" aria-label="Primary">
        {[...BOARD, ...YOU].map(link)}
      </nav>
    </div>
  );
}
