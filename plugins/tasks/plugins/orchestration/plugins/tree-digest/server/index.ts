import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { taskTree, treeDigest } from "./internal/tree-digest";
export type { DigestArgs } from "./internal/tree-digest";
export { TreeDigest } from "./internal/annotation";
export type { DigestAnnotationEntry } from "./internal/annotation";
export type { DigestTask, TreeDigestResult } from "./internal/digest";

export default {
  description:
    "The tree digest: what an agent is shown of its mandate's task subtree — treeDigest (the whole subtree the first time, then only the tasks created or changed since the conversation's digest_cursors row, capped at 40 lines, advancing the cursor) and taskTree (the whole subtree, read-only). Each line is a task's id, title and derived status plus the words every TreeDigest.Annotation contribution adds; names no track or workflow.",
} satisfies ServerPluginDefinition;
