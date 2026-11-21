import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";

const CARD_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;

/**
 * Serves hosted Agent Cards byte-for-byte. The badge check hashes the bytes served at
 * agent_uri and compares them with the on-chain metadata_hash, so the file is sent as
 * read from disk: never parsed, re-serialized or compressed.
 */
export function agentCardRouter(dir: string): Router {
  const r = Router();
  r.get("/:name", async (req, res) => {
    const name = req.params.name;
    if (!CARD_NAME.test(name)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dir, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      throw e;
    }
    res.status(200).set({ "content-type": "application/json", "cache-control": "no-transform, max-age=60" }).end(bytes);
  });
  return r;
}
