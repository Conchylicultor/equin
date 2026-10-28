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

/** The conversation's whole mandate subtree, read-only (the cursor stays). */
export function taskTree(args: DigestArgs): Promise<string | null> {
  return taskTreeOn(dbDigestStore, {
    conversationId: args.conversationId,
    annotate: annotateFromContributions,
  });
}
