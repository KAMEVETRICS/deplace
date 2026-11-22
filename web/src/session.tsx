import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { WalletApi } from "@concordium/browser-wallet-api-helpers";
import { api, ApiError, setToken, type PreparedResponse } from "./api.js";
import type { BoardConfig, Identity } from "./types.js";
import { connectWallet, sendPrepared } from "./wallet.js";

export interface Toast {
  kind: "ok" | "error" | "info";
  text: string;
  link?: string;
  faucetUrl?: string;
}

interface Session {
  config: BoardConfig | null;
  account: string | null;
  identity: Identity | null;
  busy: boolean;
  toast: Toast | null;
  setToast(t: Toast | null): void;
  connect(): Promise<void>;
  /** Asks the board for a prepared transaction, has the wallet sign and send it, then reports it. */
  run(label: string, prepare: () => Promise<PreparedResponse>): Promise<{ events: { type: string; id?: string }[]; prepared: PreparedResponse } | null>;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

function message(e: unknown): Toast {
  if (e instanceof ApiError) return { kind: "error", text: e.message, faucetUrl: typeof e.data.faucetUrl === "string" ? e.data.faucetUrl : undefined };
  return { kind: "error", text: (e as Error).message ?? String(e) };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [schema, setSchema] = useState<string | null>(null);
  const [provider, setProvider] = useState<WalletApi | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    api.config().then(setConfig).catch((e) => setToast(message(e)));
    api.schema().then((s) => setSchema(s.value)).catch(() => setSchema(null));
  }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const w = await connectWallet();
      const ch = await api.challenge(w.account);
      const signature = await w.provider.signMessage(w.account, ch.message);
      const r = await api.login(w.account, ch.nonce, signature);
      setToken(r.token);
      setProvider(w.provider);
      setAccount(w.account);
      setIdentity(r.identity);
      setToast({ kind: "ok", text: `Signed in: ${r.identity.label}` });
    } catch (e) {
      setToast(message(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const run = useCallback<Session["run"]>(
    async (label, prepare) => {
      if (!provider || !account) {
        setToast({ kind: "error", text: "Connect your wallet first." });
        return null;
      }
      setBusy(true);
      setToast({ kind: "info", text: `${label}: confirm in your wallet…` });
      try {
        const prepared = await prepare();
        const hash = await sendPrepared(provider, account, prepared.prepared, schema);
        setToast({ kind: "info", text: `${label}: waiting for finalization…`, link: `https://ccdexplorer.io/testnet/transaction/${hash}` });
        const seen = await api.observe(hash);
        setToast({ kind: "ok", text: `${label}: done. Fee paid by the board's sponsor.`, link: seen.link });
        return { events: seen.events, prepared };
      } catch (e) {
        setToast(message(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [provider, account, schema],
  );

  const value = useMemo(() => ({ config, account, identity, busy, toast, setToast, connect, run }), [config, account, identity, busy, toast, connect, run]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
