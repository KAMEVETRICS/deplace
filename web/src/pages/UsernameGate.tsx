import { useState, type FormEvent } from "react";
import { Banner } from "../components.js";
import { useSession } from "../session.js";

/** The step every person takes after signing in, before anything else: pick a username. */
export function UsernameGate() {
  const { setUsername, signOut } = useSession();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await setUsername(name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="stack page" onSubmit={save}>
      <div className="stack tight">
        <h1>Pick a username</h1>
        <p className="lede">People see it on the bounties you post and the work you deliver. Your account stays your identity on chain.</p>
      </div>
      {error && <Banner kind="err">{error}</Banner>}
      <label className="field">
        <span>Username</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoFocus required minLength={3} maxLength={20} pattern="[A-Za-z0-9_]{3,20}" />
      </label>
      <p className="meta">3 to 20 letters, digits or underscores. It is saved in lowercase.</p>
      <div className="row">
        <button className="btn" type="submit" disabled={saving}>
          Save username
        </button>
        <button className="btn ghost" type="button" onClick={signOut}>
          Sign out
        </button>
      </div>
    </form>
  );
}
