import {
  taskTreeOn,
  treeDigestOn,
  type DigestArgs,
  type TreeDigest,
} from "./digest";
import { dbDigestStore } from "./store";

/** What changed in the conversation's mandate subtree since it last looked
 * (the whole subtree the first time), capped; advances its cursor. `null` for
 * a conversation without a task. */
export function treeDigest(args: DigestArgs): Promise<TreeDigest | null> {
  return treeDigestOn(dbDigestStore, args);
}

/** The conversation's whole mandate subtree, read-only (the cursor stays). */
export function taskTree(args: DigestArgs): Promise<string | null> {
  return taskTreeOn(dbDigestStore, args);
}
