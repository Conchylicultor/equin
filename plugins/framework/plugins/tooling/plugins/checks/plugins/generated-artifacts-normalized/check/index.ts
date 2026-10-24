import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  findClaudeMdConflicts,
  readMergeMarkers,
} from "@plugins/framework/plugins/cli/core";
import type {
  Check,
  CheckContext,
} from "@plugins/framework/plugins/tooling/core";

/**
 * The loud backstop for the generated-artifact merge contract.
 *
 * The `.gitattributes` merge drivers resolve a generated file by taking the
 * upstream side verbatim and dropping a marker; a normalize pass (the
 * `post-rewrite` hook, `push`, or a full `build`) then re-derives the canonical
 * content and consumes the marker. Every automatic path is covered — this check
 * exists for the case where none of them ran, because a surviving marker means
 * the checkout carries an artifact that does not match its own sources, and the
 * symptom of that (a `TS2307` inside a `*.generated.ts` nobody edited, or a
 * plugin registry listing a deleted plugin) points nowhere near the cause.
 *
 * It also re-asserts the one thing regeneration can NEVER fix: a conflict marker
 * left in the hand-written prose of a plugin CLAUDE.md. That assertion used to
 * live only inside push's normalize, so it was skipped entirely whenever some
 * other path did the normalizing.
 */
const check: Check = {
  id: "generated-artifacts-normalized",
  description:
    "no merge-driver auto-resolve is left un-normalized, and no plugin CLAUDE.md carries a conflict marker",
  // Reads git-dir state (the marker dir), which is outside the working-tree
  // hash. Never cache: a cached pass would survive the very rebase that breaks it.
  cacheSignature: () => null,
  async run(ctx: CheckContext) {
    const root = await getWorktreeRoot();

    const markers = readMergeMarkers(root);
    if (markers.length > 0) {
      return {
        ok: false,
        message:
          `A merge or rebase auto-resolved generated files (${markers.join(", ")}) and nothing normalized them afterwards.\n` +
          `The merge drivers in .gitattributes took MAIN's version of those artifacts verbatim, so this checkout is ` +
          `carrying generated content that does not match its own sources — typically a plugin registry still listing ` +
          `plugins this branch deleted, or missing ones it added.`,
        hint:
          "Run `./equin build` (regenerates everything and clears the marker), or " +
          "`./equin normalize-generated` for just the repair + amend. " +
          "If this fired after a plain `git rebase`, the `post-rewrite` hook did not run — " +
          "check `git config core.hooksPath` is `.githooks` and `.githooks/post-rewrite` is executable.",
      };
    }

    const conflicted = await findClaudeMdConflicts(await ctx.repo());
    if (conflicted.length > 0) {
      return {
        ok: false,
        message:
          `Conflict marker(s) left in plugin CLAUDE.md prose:\n` +
          conflicted.map((f) => `  ${f}`).join("\n"),
        hint:
          "These sections are hand-written, so no regeneration can resolve them. " +
          "Edit each file, keep the correct prose, and remove the <<<<<<< / ======= / >>>>>>> markers.",
      };
    }

    return { ok: true };
  },
};

export default check;
