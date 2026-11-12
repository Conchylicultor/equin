import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { mentionScanner, type PluginMention } from "./mentions";

// `findPluginMentions`' per-file half as a fold kept along the directory tree
// (plugin-records' `foldFilesCached`): a pass after an edit scans the edited
// files only, and every other directory's mentions are one record. Its records
// are keyed by this module's whole closure, so it holds the fold and nothing
// else.

/** The plugins whose mentions are looked for, sorted. */
export type PluginMentionsContext = { ids: readonly string[] };

// One scanner per context: the fold hands every scan the same parsed object.
const scanners = new WeakMap<
  PluginMentionsContext,
  (file: string, text: string) => PluginMention[]
>();

/**
 * Every mention of `context.ids` (or their descendants) in the folded files,
 * in file order — what `findPluginMentions` answers, folded per directory.
 */
export const pluginMentionsFold: FileFold<
  PluginMentionsContext,
  PluginMention[]
> = {
  url: import.meta.url,
  scan(src, rel, context) {
    let scan = scanners.get(context);
    if (!scan) {
      scan = mentionScanner(context.ids as readonly PluginId[]);
      scanners.set(context, scan);
    }
    return scan(rel, src);
  },
  combine: (parts) => (parts.length === 1 ? parts[0]! : parts.flat()),
};
