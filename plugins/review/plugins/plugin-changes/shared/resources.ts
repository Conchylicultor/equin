import { liveValue } from "@plugins/network/plugins/live/core";
import { PluginChangesSchema } from "../core";

// The plugins a conversation's worktree added or modified relative to `main`,
// each with its files and raw facet data (the client diffs the facets). One
// payload per conversation, recomputed whole. Not loaded yet is `pending` — a
// value has no placeholder, so an unloaded review never reads as "no plugin
// changes".
export const pluginChanges = liveValue("review.plugin-changes", {
  schema: PluginChangesSchema,
  params: ["conversationId"],
});

// The plugins one push added or modified, by its id: the push's range
// (code-explorer's `resolvePushRange` — its `pushes` rows ordered by git
// ancestry) diffed `baseSha..headSha`, each plugin with its files and raw facet
// data — the same payload as `pluginChanges`. Recomputed when a row of the push
// lands (the rows are its declared reads); the trees of a known range never
// move. Refused: `missing` (no such push, or a commit of it is not in the
// repository), `no-base` (its earliest commit is a root commit, so the push has
// no base to diff from).
export const pushPluginChanges = liveValue("review.push-plugin-changes", {
  schema: PluginChangesSchema,
  params: ["pushId"],
  refusals: ["missing", "no-base"],
});
