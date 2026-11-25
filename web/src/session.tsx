import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { WalletApi } from "@concordium/browser-wallet-api-helpers";
import { api, ApiError, setToken, type PreparedResponse } from "./api.js";
import type { BoardConfig, Identity, Names } from "./types.js";
import { untilLoaded } from "./retry.js";
import { connectWallet, sendPrepared, signChallenge } from "./wallet.js";

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
  /** Forgets the wallet and the board session. */
  signOut(): void;
  /** Saves the signed-in person's username; throws the board's message when it cannot be used. */
  setUsername(name: string): Promise<void>;
  /** Display names learned from the board ("@name", "Agent #N"), by account. */
  names: Names;
  learnNames(names: Names | undefined): void;
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

  // The board may be briefly unreachable when the page opens: keep trying, and clear the
  // error once it answers (unless another message has replaced it meanwhile).
  useEffect(() => {
    const page = new AbortController();
    let shown: Toast | null = null;
    void untilLoaded(() => api.config(), {
      signal: page.signal,
      onError: (e, attempt) => {
        if (attempt === 1) setToast((shown = message(e)));
      },
    }).then((c) => {
      if (!c) return;
      setConfig(c);
      if (shown) setToast((t) => (t === shown ? null : t));
    });
    void untilLoaded(() => api.schema(), { signal: page.signal }).then((s) => {
      if (s) setSchema(s.value);
    });
    return () => page.abort();
  }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const w = await connectWallet();
      const ch = await api.challenge(w.account);
      const signature = await signChallenge(w.provider, w.account, ch.message);
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

  const [names, setNames] = useState<Names>({});
  const learnNames = useCallback((more: Names | undefined) => {
    if (more && Object.keys(more).length > 0) setNames((n) => ({ ...n, ...more }));
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setProvider(null);
    setAccount(null);
    setIdentity(null);
    setToast(null);
  }, []);

  // The board session belongs to the account that signed in. When the wallet switches to another
  // account or disconnects this site, sign out instead of carrying on as an account it left.
  useEffect(() => {
    if (!provider || !account) return;
    const changed = (next: string) => {
      if (next === account) return;
      signOut();
      setToast({ kind: "info", text: "Your wallet switched accounts, so you're signed out. Connect again to continue with the account it shows now." });
    };
    const disconnected = () => {
      signOut();
      setToast({ kind: "info", text: "Your wallet disconnected this site, so you're signed out." });
    };
    provider.on("accountChanged", changed);
    provider.on("accountDisconnected", disconnected);
    return () => {
      provider.removeListener("accountChanged", changed);
      provider.removeListener("accountDisconnected", disconnected);
    };
  }, [provider, account, signOut]);

  const setUsername = useCallback(
    async (name: string) => {
      const r = await api.setUsername(name);
      setIdentity((i) => (i ? { ...i, username: r.username } : i));
      if (account) learnNames({ [account]: `@${r.username}` });
      setToast({ kind: "ok", text: `Welcome, @${r.username}.` });
    },
    [account, learnNames],
  );

  const value = useMemo(
    () => ({ config, account, identity, busy, toast, setToast, connect, signOut, setUsername, names, learnNames, run }),
    [config, account, identity, busy, toast, connect, signOut, setUsername, names, learnNames, run],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
