import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { DigestAnnotate, DigestTask } from "./digest";

/**
 * Extra words on a digest line, from the plugin that owns the fact (the task's
 * track, whether it is armed, its report…). The digest names none of them:
 * every contribution is asked about every shown task, and a task's words are
 * every contribution's, in contribution order.
 */
export interface DigestAnnotationEntry {
  id: string;
  annotate: (
    tasks: readonly DigestTask[],
  ) => Promise<ReadonlyMap<string, readonly string[]>>;
}

const AnnotationToken = defineServerContribution<DigestAnnotationEntry>(
  "treeDigestAnnotation",
  { docLabel: (a) => a.id },
);

/** `TreeDigest.Annotation({ id, annotate })` — words a plugin adds to the
 * digest lines of the tasks it knows something about. */
export const TreeDigest = { Annotation: AnnotationToken };

/** Every contribution's words, merged per task id. */
export const annotateFromContributions: DigestAnnotate = async (tasks) => {
  const entries = AnnotationToken.getContributions();
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id))
      throw new Error(`TreeDigest.Annotation "${e.id}" is contributed twice`);
    ids.add(e.id);
  }
  const notes = await Promise.all(entries.map((e) => e.annotate(tasks)));
  const merged = new Map<string, string[]>();
  for (const note of notes) {
    for (const [taskId, words] of note) {
      const list = merged.get(taskId) ?? [];
      list.push(...words);
      merged.set(taskId, list);
    }
  }
  return merged;
};
