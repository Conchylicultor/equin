import { taskTreeOn, treeDigestOn, type TreeDigestResult } from "./digest";
import { annotateFromContributions } from "./annotation";
import { dbDigestStore } from "./store";

export interface DigestArgs {
  conversationId: string;
}

/** What changed in the conversation's mandate subtree since it last looked
 * (the whole subtree the first time), capped; advances its cursor. `null` for
 * a conversation without a task. Each line carries every
 * `TreeDigest.Annotation`'s words. */
export function treeDigest(args: DigestArgs): Promise<TreeDigestResult | null> {
  return treeDigestOn(dbDigestStore, {
    conversationId: args.conversationId,
    annotate: annotateFromContributions,
  });
}

/** The whole mandate subtree, capped like a digest, and the cursor advanced:
 * what an agent process starts with, so the `add_task` digests after it list
 * only what changed since. `null` for a conversation without a task. */
export function treeSnapshot(
  args: DigestArgs,
): Promise<TreeDigestResult | null> {
  return treeDigestOn(dbDigestStore, {
    conversationId: args.conversationId,
    annotate: annotateFromContributions,
    whole: true,
  });
}

/** The conversation's whole mandate subtree, read-only (the cursor stays). */
export function taskTree(args: DigestArgs): Promise<string | null> {
  return taskTreeOn(dbDigestStore, {
    conversationId: args.conversationId,
    annotate: annotateFromContributions,
  });
}
