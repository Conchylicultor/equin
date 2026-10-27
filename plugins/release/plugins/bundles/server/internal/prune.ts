import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { isPointerName } from "./pointer";
import { releaseRunIdKind } from "../../core/internal/run-id";

/**
 * What a sweep did. A batch outcome, so a partial reclaim is still reportable —
 * `removed` and `kept` together account for every run dir that was there.
 */
export interface PruneResult {
  removed: string[];
  kept: string[];
}

/**
 * When a run was cut, in epoch ms, read by the run-id kind — `-1` for a dir
 * that is not a release run id. The kind reads the current seconds stamp and
 * the legacy millis one alike, so the two generations order correctly against
 * each other (a digit-count-blind parse would rank every new run as the
 * oldest).
 */
function runIdMs(runId: string): number {
  return releaseRunIdKind.stampedAtMs(runId) ?? -1;
}

/**
 * Keep the `keep` newest run dirs in `compDir` — one `<composition>-<target>`
 * dir, as `compositionReleaseDir` names it — and delete the rest, never
 * touching a run some `latest-<platform>` pointer names.
 *
 * Takes the directory rather than `(namespace, composition, target)` because
 * its caller holds the run's own `out` dir and prunes its parent: a pinned
 * release runs inside a private checkout whose name is not the namespace the
 * run was filed under, so re-deriving the namespace there names the wrong dir.
 *
 * `~/.equin/state/releases/` had no retention policy at all, and a run dir
 * is a whole staged app — hundreds of megabytes. This is the only thing that
 * bounds it: a release's own supervised-run transcript is capped separately, by
 * the shared per-kind run prune, and reaping a transcript reclaims kilobytes.
 * Invoked by the release CLI right after the pointer write, so the pinned set is
 * already current.
 *
 * **Known bound, stated rather than papered over:** the pinned set is the
 * pointer set only. A *live Studio preview* running out of an older run dir is
 * not visible from here — previews live in the release engine's in-process map,
 * and this module is deliberately DB- and engine-free so a CLI process can
 * import it. With `keep = 3` a preview would have to be running against the 4th
 * newest run of the same composition to be hit.
 */
export function pruneReleaseRunDirs(compDir: string, keep = 3): PruneResult {
  if (!existsSync(compDir)) return { removed: [], kept: [] };

  const entries = readdirSync(compDir);
  const pinned = new Set<string>();
  for (const name of entries.filter(isPointerName)) {
    try {
      pinned.add(basename(realpathSync(join(compDir, name))));
    } catch (err) {
      // A dangling pointer pins nothing — the run it named is already gone.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const runs = entries
    .filter((e) => !isPointerName(e))
    .sort((a, b) => runIdMs(b) - runIdMs(a) || b.localeCompare(a));

  const removed: string[] = [];
  const kept: string[] = [];
  for (const [i, runId] of runs.entries()) {
    if (i < keep || pinned.has(runId)) {
      kept.push(runId);
      continue;
    }
    rmSync(join(compDir, runId), { recursive: true, force: true });
    removed.push(runId);
  }
  return { removed, kept };
}
