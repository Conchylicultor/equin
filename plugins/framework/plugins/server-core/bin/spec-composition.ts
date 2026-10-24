import { readFileSync } from "fs";
import { join } from "path";
import { WORKTREE_SPEC_FILE } from "@plugins/infra/plugins/paths/core";

/**
 * Read WHICH APP this backend is, off the same `spec.json` the gateway read to
 * spawn it.
 *
 * The spec is the one durable statement of a namespace's identity
 * (`infra/worktree/server/internal/spec.ts` writes it, and its `composition`
 * field is documented there). This is the read side, kept here rather than
 * behind that plugin's barrel because it runs before any plugin is loaded and
 * that barrel's closure is the whole worktree/git stack. The FILENAME still
 * comes from one place — `WORKTREE_SPEC_FILE` in `infra/paths`, whose barrel is
 * free here: `bin/index.ts` already imports it, so nothing is added to the boot
 * import closure.
 *
 * **Why the file and not a spawn-time value.** The first cut had the gateway
 * pass the composition to the backend it spawns. But `./equin build`
 * rebuilds the backend and NOT the Go gateway (only `./equin start`
 * compiles that), so a running gateway is routinely older than the tree it
 * serves — it would not pass the variable at all, the backend would see no
 * composition, and it would boot the FULL app under a composition's own
 * namespace and database. Which is exactly the failure the composition field
 * exists to remove. Reading the file directly deletes the hop that can drop the
 * value: the gateway and the backend read the same bytes, so they cannot drift.
 *
 * Four ways to get "no composition", all of them the main app, which is what an
 * absent value has always meant:
 *
 *   1. No namespace — a hand-run backend, spawned by nobody.
 *   2. No spec file — not gateway-spawned, or a namespace not registered yet.
 *   3. A spec with no `composition` key — every pre-composition spec, and
 *      `central`, which serves no composition at all.
 *   4. An empty `composition` — handed straight through; `selectRegistry`
 *      already reads `""` as the main app.
 *
 * A spec that EXISTS but cannot be read or parsed is not one of them. That is a
 * corrupt contract, and it throws for the same reason `selectRegistry`'s second
 * arm throws: booting the wrong app under a namespace looks like it worked.
 *
 * @param worktreesDir the `worktrees` data dir holding `<namespace>/spec.json`
 *   — passed in rather than resolved here so this stays a pure function of
 *   (dir, namespace) with a tmpdir test, exactly like `selectRegistry`
 * @param namespace this backend's runtime namespace, which is the spec dir
 *   basename. Not validated here: `selectRegistry` owns that guard, and a
 *   namespace bogus enough to escape the dir simply names no spec file.
 */
export function readSpecComposition(
  worktreesDir: string,
  namespace: string | undefined,
): string | undefined {
  if (namespace === undefined || namespace === "") return undefined;

  // The spec file under the namespace's own data dir. The mapping is exact by
  // construction: `writeWorktreeSpec` writes exactly here and the gateway scans
  // exactly here, so there is no second convention to keep in step — and the
  // FILENAME is `paths`'s (`WORKTREE_SPEC_FILE`), so this reader cannot drift
  // from that writer either. Only the dir is joined here, because it is an
  // argument (see the `@param` above); `paths` also spells the whole path as
  // `worktreeArtifacts.spec(name)` for callers resolving this process's root.
  const path = join(worktreesDir, namespace, WORKTREE_SPEC_FILE);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // EACCES, EISDIR, an I/O error: the spec is there and we cannot read it.
    // Not "no composition" — unknown, which must not be guessed.
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Malformed spec at ${path}: ${(err as Error).message}. ` +
        `Refusing to guess which app this namespace serves.`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Malformed spec at ${path}: expected a JSON object. ` +
        `Refusing to guess which app this namespace serves.`,
    );
  }

  const composition = (parsed as { composition?: unknown }).composition;
  if (composition === undefined) return undefined;
  if (typeof composition !== "string") {
    throw new Error(
      `Malformed spec at ${path}: "composition" must be a string, got ` +
        `${typeof composition}.`,
    );
  }
  return composition;
}
