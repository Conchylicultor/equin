import { lstat } from "@plugins/packages/plugins/timed-fs/core";

// The identity of a conversation's session chain — the single definition of "did
// the chain change?", owned by the plugin that owns the chain.
//
// Two consumers share it, and they MUST agree byte-for-byte: the watcher captures
// it before each read (and primes a signed memo with it), and `jsonl-events`'
// `revalidate` probes it on the read path. A conservative over-approximation — it
// changes whenever the chain's parsed VALUE could change (serving stale is a
// correctness bug; a needless recompute is merely a missed optimization).
//
// The value is the MERGE of a conversation's whole session chain, so the signature
// must cover every file in it. Each file contributes a (path, mtimeMs, size)
// triple: an append changes both mtime and size, and folding in the resolved path
// means a session whose transcript path changes never matches a prior file's
// signature. It fingerprints the FILES — the source of truth — not any in-memory
// cache (which is empty after a restart, exactly when this matters).
//
// `lstat`, never `Bun.file().lastModified`: the latter is integer-ms, the former a
// sub-ms float, so the two produce different strings for the same file. Routing
// every producer through `statChain` is what makes the watcher's primed signature
// match the resource's probe. Split them and every prime silently misses, degrading
// the memo to a full chain re-read on every push. One stat API, one authority.

/** One file's contribution to a chain signature. */
export function chainFileEtag(path: string, mtimeMs: number, size: number): string {
  return `${path}|${mtimeMs}|${size}`;
}

/** One chain file's stat triple. */
export interface ChainStat {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Signature of a whole session chain.
 *
 * `chainLength` is how many files the resolver returned; `files` are the ones that
 * still existed when stat'd. Both are folded in, so all three ways the value can
 * move produce a different string:
 *   - an append to any file     → that file's (mtimeMs, size) changes;
 *   - a NEW chain entry         → `chainLength` grows and a new triple appears;
 *   - a file vanishing under us → its triple disappears while `chainLength` stands.
 *
 * An empty chain is `"none"`, which never matches a real signature, so it degrades
 * to a recompute (safe) rather than a stale match.
 */
export function chainEtag(
  chainLength: number,
  files: readonly ChainStat[],
): string {
  if (chainLength === 0) return "none";
  return `${chainLength}|${files.map((f) => chainFileEtag(f.path, f.mtimeMs, f.size)).join("|")}`;
}

// `lstat` every chain file for its (mtimeMs, size). ENOENT is the expected case for
// a file that vanished between resolve and stat — omit its triple, which moves the
// signature (`chainEtag` still folds in `paths.length`) and degrades to a recompute.
// Any OTHER error is unexpected and re-thrown so it fails loudly rather than
// producing a signature built on a silent read failure.
export async function statChain(paths: readonly string[]): Promise<ChainStat[]> {
  const files: ChainStat[] = [];
  for (const path of paths) {
    try {
      const st = await lstat(path);
      files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return files;
}

/**
 * A resolved chain's signature, and when its files last changed (the newest
 * mtime among them; undefined when none exists) — read from one stat pass.
 */
export async function transcriptChainState(
  paths: readonly string[],
): Promise<{ signature: string; changedAt: number | undefined }> {
  const files = await statChain(paths);
  let changedAt: number | undefined;
  for (const f of files)
    if (changedAt === undefined || f.mtimeMs > changedAt) changedAt = f.mtimeMs;
  return { signature: chainEtag(paths.length, files), changedAt };
}

/** The bound signature of a resolved chain: the two halves above, never apart. */
export async function transcriptChainSignature(
  paths: readonly string[],
): Promise<string> {
  return (await transcriptChainState(paths)).signature;
}
