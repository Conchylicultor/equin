import { serveValue } from "@plugins/network/plugins/live/machine";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { getConfig, watchConfig } from "@plugins/config_v2/server";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";
import {
  conversationCategoriesEntity,
  conversationCategoryConfig,
} from "@plugins/conversations/plugins/conversation-category/server";
import { commitsConfig } from "../../shared/config";
import {
  commitsCounts,
  commitsCountsByCategory,
  commitsLines,
  commitsLinesByExt,
} from "../../shared/values";
import { deduplicateByPushId, getCommits, type CommitInfo } from "./commit-log";
import { buildItemMap, getConfigItemOrder, itemFor } from "./category-map";
import {
  countByItemPoints,
  countPoints,
  linesByExtPoints,
  linesPoints,
} from "./series";

// Every value is external: the truth is `git log` of the main checkout. It
// moves when a tracked ref advances — `recomputeOn: [refHeadServed]`
// recomputes every subscribed tuple (git-watcher tracks `main` and this
// checkout's own branch; the main checkout's HEAD is `main`, so an advance of
// the other ref costs one recompute that answers the same) — and when the
// config a value reads changes (`whileSubscribed` watches it for as long as a
// tuple is read). All are `load: "on-demand"`: a recompute invalidates, and
// each open chart re-reads over HTTP.

/**
 * Notify on every change of one config descriptor. `watchConfig` calls back
 * immediately with the current values — that is not a change, so it is
 * skipped.
 */
function onConfigChange<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  notify: () => void,
): () => void {
  let initial = true;
  const watcher = watchConfig(descriptor, () => {
    if (initial) return;
    notify();
  });
  initial = false;
  return () => watcher.dispose();
}

/** The commits the line stats count: the configured excluded paths left out. */
async function lineCommits(dedup: boolean): Promise<CommitInfo[]> {
  const { excludedPaths } = getConfig(commitsConfig);
  const active = excludedPaths.filter((p) => p.enabled).map((p) => p.path);
  const commits = await getCommits(active);
  return dedup ? deduplicateByPushId(commits) : commits;
}

async function countCommits(dedup: boolean): Promise<CommitInfo[]> {
  const commits = await getCommits();
  return dedup ? deduplicateByPushId(commits) : commits;
}

export const commitsCountsServed = serveValue(commitsCounts, {
  source: "external",
  changes: "notified",
  recomputeOn: [refHeadServed],
  loader: async ({ series, dedup }) => ({
    points: countPoints(await countCommits(dedup), series),
  }),
});

export const commitsCountsByCategoryServed = serveValue(
  commitsCountsByCategory,
  {
    source: "external",
    changes: "notified",
    // Beside git, the loader reads which item each conversation carries in the
    // category, and the category's item order from its config.
    reads: {
      tables: [conversationCategoriesEntity],
      reason:
        "every commit is attributed through its conversation's assignment in the category, so (re)classifying any conversation may move any point",
    },
    recomputeOn: [refHeadServed],
    // The classifier assigns a category after every turn: a burst of
    // assignments is one re-read.
    throttleMs: 2_000,
    loader: async ({ series, dedup, categoryId }) => {
      const commits = await countCommits(dedup);
      const itemMap = await buildItemMap(categoryId);
      return {
        points: countByItemPoints(commits, series, (c) =>
          itemFor(itemMap, c.conversationId),
        ),
        items: getConfigItemOrder(categoryId),
      };
    },
    whileSubscribed: (_q, notify) =>
      onConfigChange(conversationCategoryConfig, notify),
  },
);

export const commitsLinesServed = serveValue(commitsLines, {
  source: "external",
  changes: "notified",
  recomputeOn: [refHeadServed],
  loader: async ({ series, dedup }) => ({
    points: linesPoints(await lineCommits(dedup), series),
  }),
  whileSubscribed: (_q, notify) => onConfigChange(commitsConfig, notify),
});

export const commitsLinesByExtServed = serveValue(commitsLinesByExt, {
  source: "external",
  changes: "notified",
  recomputeOn: [refHeadServed],
  loader: async ({ series, dedup }) => ({
    points: linesByExtPoints(await lineCommits(dedup), series),
  }),
  whileSubscribed: (_q, notify) => onConfigChange(commitsConfig, notify),
});
