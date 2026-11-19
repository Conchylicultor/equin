/**
 * The `after` list a task is queued behind — `add_task`'s and `adopt_task`'s
 * — checked one way: trimmed and deduplicated, never empty, never the task
 * itself, every id an existing task. Answers the ids in order, or why the list
 * is refused (nothing is written either way: the caller wires the edges).
 */
export async function checkAfterIds(
  ids: readonly string[],
  opts: {
    /** The task being queued, when it exists already (it cannot wait on
     * itself). */
    self?: string;
    exists: (taskId: string) => Promise<boolean>;
  },
): Promise<{ ok: true; after: string[] } | { ok: false; message: string }> {
  const after = [...new Set(ids.map((id) => id.trim()))];
  if (after.length === 0 || after.some((id) => id === ""))
    return {
      ok: false,
      message: "`after` names no task: omit it, or name the tasks.",
    };
  if (opts.self !== undefined && after.includes(opts.self))
    return { ok: false, message: "A task cannot run after itself." };
  for (const id of after)
    if (!(await opts.exists(id)))
      return { ok: false, message: `\`after\` task "${id}" not found` };
  return { ok: true, after };
}
