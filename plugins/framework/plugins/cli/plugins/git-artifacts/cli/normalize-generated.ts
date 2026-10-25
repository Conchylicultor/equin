import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  spawnCaptured,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";
import {
  clearMergeMarkers,
  findClaudeMdConflicts,
  readMergeMarkers,
} from "@plugins/framework/plugins/cli/core";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

// Wedge-breaker for the local `git` metadata reads in this file — orders of
// magnitude above what any of them take, so only a wedged child trips it. A CLI
// process owns no deadline of its own, but that is a reason to bound these, not
// to leave them open: nothing else would ever break such a wedge (the
// fleet-level op-wedge watchdog was retired 2026-07-28).
const GIT_TIMEOUT_MS = 60_000;

async function exec(
  cmd: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<void> {
  const { exitCode } = await spawnPassthrough(cmd, { cwd, env });
  if (exitCode !== 0) process.exit(1);
}

async function isDirty(cwd: string): Promise<boolean> {
  const result = await spawnCaptured(["git", "status", "--porcelain"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    console.error(`git status failed (exit ${result.exitCode})`);
    if (result.stderr.trim()) console.error(result.stderr.trim());
    process.exit(1);
  }
  return result.stdout.trim().length > 0;
}

/**
 * Re-derive canonical content for every generated artifact a merge driver
 * auto-resolved, and fold the result into the head commit.
 *
 * WHY IT EXISTS: the `.gitattributes` drivers (`scripts/regen-*.sh`) resolve a
 * generated file by taking the UPSTREAM side verbatim — a knowingly-wrong tree
 * that is cheap to produce and trivially repairable, because the file is a pure
 * function of sources that git just merged correctly. Each driver records that
 * it fired by dropping a marker; this function is the repair the markers exist
 * to trigger.
 *
 * WHO CALLS IT: `push` (before and after its own rebase) and the
 * `post-rewrite` git hook (after ANY other rebase / amend). The hook is what
 * makes the repair independent of which command drove the rebase — a manual
 * `git fetch origin main && git rebase origin/main` self-heals exactly like a
 * push does. `build` reaches the same end state by regenerating everything
 * unconditionally, and clears the markers itself.
 *
 * WHY `force` EXISTS: zero markers used to mean "the merge was clean, there is
 * nothing to repair" and returned immediately. But it is indistinguishable from
 * "a marker was dropped somewhere nobody reads" — under a GIT_DIR a caller
 * exported, in rebase state that was discarded, or consumed by an earlier pass
 * — and the two readings are not equally cheap to get wrong. For an ordinary
 * branch main's generated artifact already agrees with the merged sources, so a
 * skipped repair changes nothing; for a branch that edits a GENERATOR, main's
 * artifact is WRONG for the merged sources by however much the generator moved,
 * so a skipped repair leaves push checking a commit whose doc contradicts its
 * own code. That is not hypothetical: it cost five failed pushes and is written
 * up in `research/2026-08-19-global-push-normalize-generated-doc-drift.md`.
 * So push's post-rebase call passes `force` and regenerates unconditionally,
 * while the `post-rewrite` hook stays marker-gated — the hook fires after EVERY
 * rebase and has to stay cheap, whereas push is already a multi-minute
 * operation and has to be correct rather than fast. That asymmetry is the only
 * reason this is a flag instead of the default.
 *
 * Under `force` the marker list cannot be trusted to say WHICH pipelines to
 * run either, so both run — the same pair `build` runs unconditionally, and
 * both are idempotent, so the cost of the redundant one is time.
 *
 * Two things it refuses to paper over:
 *   - a hand-edited branch-local migration (`regen-migrations` detects it and
 *     aborts before resetting anything);
 *   - a conflict marker left in CLAUDE.md PROSE, which no regeneration can fix.
 *
 * @param pushId stamped as a push trailer on the amend, so a push
 *        that normalizes keeps its commits grouped into one push event. Omitted
 *        by the hook, whose amend must preserve the message exactly as-is.
 * @param force regenerate without consulting the markers (see above).
 */
export async function normalizeGeneratedArtifacts(
  root: string,
  opts: { pushId?: string; force?: boolean } = {},
): Promise<void> {
  const markers = readMergeMarkers(root);
  if (!opts.force && markers.length === 0) return; // clean merge, no auto-resolve happened

  // `force` makes the marker list a diagnostic rather than a work list: it says
  // which drivers we can PROVE fired, not which artifacts are stale.
  const regenMigrations = opts.force || markers.includes("migrations");
  const regenGenerated = opts.force || markers.includes("generated");

  console.log(
    markers.length > 0
      ? `Normalizing artifacts auto-resolved during merge (${markers.join(", ")})...`
      : "Regenerating every artifact from the merged sources (no merge marker to go on)...",
  );

  if (regenMigrations) {
    await exec(
      ["bun", "plugins/framework/plugins/cli/bin/index.ts", "regen-migrations"],
      root,
    );
  }

  if (regenGenerated) {
    await exec(
      ["bun", "plugins/framework/plugins/cli/bin/index.ts", "regen-generated"],
      root,
    );
  }

  // Markers are consumed only once every regen above has SUCCEEDED — a regen
  // that exits non-zero kills this process with the marker still in place, so
  // the next push/check still sees the un-normalized state. The forced path
  // clears them too, and must: it just re-derived every artifact from source,
  // so a marker that survived it could only ever be a mis-delivered one, and
  // leaving it behind would trip `generated-artifacts-normalized` on a tree
  // that is in fact canonical.
  clearMergeMarkers(root);

  if (regenGenerated) {
    const conflicted = await findClaudeMdConflicts(await loadRepoFiles(root));
    if (conflicted.length) {
      console.error(
        [
          "",
          "Real merge conflict in plugin CLAUDE.md prose section(s):",
          ...conflicted.map((f) => `  ${f}`),
          "",
          "These are hand-written and require manual resolution. Edit the files,",
          "remove the conflict markers, then re-run ./equin push.",
        ].join("\n"),
      );
      process.exit(1);
    }
  }

  if (!(await isDirty(root))) return;
  console.log("Amending head commit with regenerated artifacts...");
  // The hook re-enters here via `git commit --amend`; the env flag closes that
  // loop. (The markers are already cleared above, so the guard is belt-and-
  // braces — but it makes the no-recursion property local to this call.)
  // SKIP_POST_REWRITE suppresses the `.githooks/post-rewrite` hook for a child
  // git process. Set by the two callers that own the normalize themselves:
  // `push`, around its own rebase (it installs the rebased lockfile BEFORE
  // normalizing, an ordering the hook cannot know about), and this amend, which
  // would otherwise re-enter the hook.
  const env = { ...process.env, ...envEntries({ SKIP_POST_REWRITE: "1" }) };
  await exec(["git", "add", "-A"], root, env);
  await exec(
    [
      "git",
      "-c",
      "trailer.ifexists=replace",
      "commit",
      "--amend",
      "--no-edit",
      ...(opts.pushId
        ? ["--trailer", `${LEGACY_IDS.pushTrailer}=${opts.pushId}`]
        : []),
    ],
    root,
    env,
  );
}
