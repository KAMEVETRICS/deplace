import type { ReactNode } from "react";
import { Icon } from "./icons.js";
import type { Funding, Prepared, Status } from "./types.js";

/** A message on the page. Errors are announced as alerts, everything else as status. */
export function Banner({ kind, role, onDismiss, children }: { kind: "ok" | "err" | "info" | "fund"; role?: "alert" | "status"; onDismiss?: () => void; children: ReactNode }) {
  return (
    <div className={kind === "info" ? "banner" : `banner ${kind}`} role={role ?? (kind === "err" ? "alert" : "status")}>
      <span className="grow">{children}</span>
      {onDismiss && (
        <button className="icon-btn ghost" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}

export const EXPLORER = "https://ccdexplorer.io/testnet";

/** Smallest units (decimal string) to a human amount, without trailing zeros. */
export function formatAmount(units: string, decimals: number): string {
  const v = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export const short = (s: string, n = 6) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

export function FundingBadge({ funding }: { funding: Funding }) {
  return funding.type === "Escrowed" ? (
    <span className="badge badge-escrow" title="The reward sits in the board's escrow account (custodial until Protocol-Level Locks reach testnet). Payout follows the contract state.">
      Escrowed (custodial)
    </span>
  ) : (
    <span className="badge badge-promise" title="The reward is the poster's promise, paid on delivery. Not paying leaves a public mark on the poster's record.">
      Not funded
    </span>
  );
}

export function KindBadge({ kind }: { kind: "Exclusive" | "Contest" }) {
  return <span className="badge badge-kind">{kind === "Exclusive" ? "Exclusive" : "Contest"}</span>;
}

const STATUS_LABEL: Record<Status["type"], string> = {
  Open: "Open",
  Claimed: "Claimed",
  Submitted: "Submitted",
  Accepted: "Accepted",
  Awarded: "Awarded",
  Splitting: "Splitting among entrants",
  Paid: "Paid",
  AcceptedUnpaid: "Accepted, unpaid",
  RejectedFinal: "Rejected (final)",
  NoAward: "No award",
  Expired: "Expired",
  Cancelled: "Cancelled",
  Refunded: "Refunded",
};

export function StatusPill({ status }: { status: Status }) {
  return <span className={`pill pill-${status.type.toLowerCase()}`}>{STATUS_LABEL[status.type]}</span>;
}

/** Shown whenever the board could not sponsor a transaction and the sender pays the fee. */
export function FeeNotice({ prepared }: { prepared: Prepared | null }) {
  if (!prepared || prepared.feeSponsored) return null;
  return (
    <div role="alert" className="notice notice-warn">
      {prepared.notice ?? "Network fee applies: your account pays a small CCD fee for this transaction."}
    </div>
  );
}

export function TxLink({ hash, children }: { hash: string; children?: ReactNode }) {
  return (
    <a href={`${EXPLORER}/transaction/${hash}`} target="_blank" rel="noreferrer">
      {children ?? short(hash, 8)}
    </a>
  );
}

export function AccountLink({ address }: { address: string }) {
  return (
    <a href={`#/p/${address}`} title={address}>
      {short(address)}
    </a>
  );
}
