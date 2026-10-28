/**
 * The tree digest, as policy over a store port: which tasks a conversation is
 * shown (the whole subtree the first time, then only what changed since), how
 * each reads, the line cap, and when the cursor advances. Production binds the
 * store to the database (`store.ts`); a test binds it to memory.
 *
 * Names no workflow or track: what a task's line says beyond its id, title and
 * status comes from the caller's `annotate` (the plugin that owns the track or
 * the auto-start marker knows how to say it).
 */

/** One task of the digested subtree. */
export interface DigestTask {
  id: string;
  folderId: string | null;
  title: string;
  status: string;
  /** Fractional rank, ordering siblings (compared by code point). */
  rank: string;
}

/** Extra words per task id, appended to its line (e.g. its track). */
export type DigestAnnotate = (
  tasks: readonly DigestTask[],
) => Promise<ReadonlyMap<string, readonly string[]>>;

export interface DigestStore {
  /** The conversation's task and the root of its effective mandate; null for
   * a conversation without a task (nothing to digest). */
  scopeOf(
    conversationId: string,
  ): Promise<{ taskId: string; rootTaskId: string } | null>;
  cursorOf(conversationId: string, rootTaskId: string): Promise<Date | null>;
  /** The root's whole subtree (the root included), and the store's clock at
   * the read — the next cursor. */
  subtree(rootTaskId: string): Promise<{ tasks: DigestTask[]; at: Date }>;
  /** The subtree's tasks created or changed after `since` (the task itself,
   * or an attempt / conversation of it), and the store's clock at the read. */
  changedSince(
    rootTaskId: string,
    since: Date,
  ): Promise<{ tasks: DigestTask[]; at: Date }>;
  advance(conversationId: string, rootTaskId: string, at: Date): Promise<void>;
}

export interface TreeDigest {
  text: string;
  /** True when `text` covers the whole subtree, false for a delta. */
  full: boolean;
}

/** Lines a digest shows before it points at `task_tree`. */
export const DIGEST_LINE_CAP = 40;
/** Lines the full tree (`task_tree`) shows before it stops. */
export const TREE_LINE_CAP = 500;

/** The subtree in tree order (siblings by rank), each with its depth below
 * the root. A task whose parent is outside the set sits at the top. */
function treeOrder(
  tasks: readonly DigestTask[],
  rootTaskId: string,
): { task: DigestTask; depth: number }[] {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map<string | null, DigestTask[]>();
  for (const t of tasks) {
    const parent =
      t.id === rootTaskId || t.folderId === null || !ids.has(t.folderId)
        ? null
        : t.folderId;
    const list = children.get(parent) ?? [];
    list.push(t);
    children.set(parent, list);
  }
  const byRank = (a: DigestTask, b: DigestTask) =>
    a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1;
  const out: { task: DigestTask; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const t of (children.get(parent) ?? []).sort(byRank)) {
      out.push({ task: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

async function renderLines(
  rows: { task: DigestTask; depth: number }[],
  opts: { selfTaskId: string; annotate: DigestAnnotate; cap: number },
  overflowHint: string,
): Promise<string[]> {
  const shown = rows.slice(0, opts.cap);
  const notes = await opts.annotate(shown.map((r) => r.task));
  const lines = shown.map(({ task, depth }) => {
    const words = [task.status, ...(notes.get(task.id) ?? [])];
    if (task.id === opts.selfTaskId) words.push("your task");
    return `${"  ".repeat(depth)}- ${task.id} ${JSON.stringify(task.title)} — ${words.join(", ")}`;
  });
  const more = rows.length - shown.length;
  if (more > 0) lines.push(`+${more} more${overflowHint}`);
  return lines;
}

export interface DigestArgs {
  conversationId: string;
  annotate: DigestAnnotate;
}

/**
 * What changed in the conversation's mandate subtree since it last looked —
 * the whole subtree the first time (or after its root moved) — capped at
 * {@link DIGEST_LINE_CAP} lines. Advances the cursor. `null` for a
 * conversation without a task.
 */
export async function treeDigestOn(
  store: DigestStore,
  args: DigestArgs,
): Promise<TreeDigest | null> {
  const scope = await store.scopeOf(args.conversationId);
  if (scope === null) return null;
  const since = await store.cursorOf(args.conversationId, scope.rootTaskId);
  const overflow = " — call `task_tree` for the whole tree";
  const render = {
    selfTaskId: scope.taskId,
    annotate: args.annotate,
    cap: DIGEST_LINE_CAP,
  };
  let digest: TreeDigest;
  let at: Date;
  if (since === null) {
    const read = await store.subtree(scope.rootTaskId);
    at = read.at;
    const lines = await renderLines(
      treeOrder(read.tasks, scope.rootTaskId),
      render,
      overflow,
    );
    digest = {
      text: [`Your task tree (root ${scope.rootTaskId}):`, ...lines].join("\n"),
      full: true,
    };
  } else {
    const read = await store.changedSince(scope.rootTaskId, since);
    at = read.at;
    const lines = await renderLines(
      treeOrder(read.tasks, scope.rootTaskId).map((r) => ({ ...r, depth: 0 })),
      render,
      overflow,
    );
    digest = {
      text:
        lines.length === 0
          ? "No task in your tree changed since you last saw it."
          : ["Changed in your task tree since you last saw it:", ...lines].join(
              "\n",
            ),
      full: false,
    };
  }
  await store.advance(args.conversationId, scope.rootTaskId, at);
  return digest;
}

/** The conversation's whole mandate subtree (capped at {@link TREE_LINE_CAP}
 * lines), read-only: the cursor does not move. `null` without a task. */
export async function taskTreeOn(
  store: DigestStore,
  args: DigestArgs,
): Promise<string | null> {
  const scope = await store.scopeOf(args.conversationId);
  if (scope === null) return null;
  const read = await store.subtree(scope.rootTaskId);
  const lines = await renderLines(
    treeOrder(read.tasks, scope.rootTaskId),
    { selfTaskId: scope.taskId, annotate: args.annotate, cap: TREE_LINE_CAP },
    "",
  );
  return [`Your task tree (root ${scope.rootTaskId}):`, ...lines].join("\n");
}
