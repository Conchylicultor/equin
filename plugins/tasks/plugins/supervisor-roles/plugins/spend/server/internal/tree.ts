import {
  SPEND_CATEGORIES,
  SPEND_ROOT_ID,
  SPEND_TOP_PARTS,
  type SpendCategoryId,
  type SpendNode,
  type SpendNodeKind,
} from "../../core";

// The drill tree, built from the ledger's spend per source joined to what
// spent it (`SpendSourceRow`, read by `spend-query.ts`). Pure: every rule of
// which category and level a cost lands in is here, tested without a database.

/** A task, as a level of the tree names it. */
export interface SpendTaskRef {
  id: string;
  /** Its short title when it has one, else its title. */
  title: string;
}

/**
 * One source's spend in the windows, with what spent it. A `cli:` source
 * names its caller and no conversation; a `conv:` source whose conversation
 * is gone names neither.
 */
export interface SpendSourceRow {
  source: string;
  costUsd: number;
  /** The part spent on API-key accounts. */
  billedUsd: number;
  /** The caller of a `cli:` source (`task-title`), else `null`. */
  caller: string | null;
  conversation: { id: string; title: string | null; live: boolean } | null;
  /** The conversation's attempt and its number on its task (1, 2, …). */
  attempt: { id: string; number: number } | null;
  /** The attempt's task. */
  task: SpendTaskRef | null;
  /** The task's effective mandate, and the root stating it. */
  mandateId: string | null;
  root: SpendTaskRef | null;
  /** The root's owning role (a role session's), its name and session number. */
  role: { id: string; name: string; session: number } | null;
  /** The automation that filed or launched the root. */
  automationId: string | null;
}

/** The mandate ids that decide a category. */
export interface SpendMandates {
  /** A supervisor role's session (`supervisor-role`). */
  roleSession: string;
  /** An ad-hoc supervisor (`supervisor`). */
  adhoc: string;
}

/** A node while costs are added into it. */
interface Draft {
  id: string;
  kind: SpendNodeKind;
  name: string;
  short: string | null;
  sub: string | null;
  costUsd: number;
  billedUsd: number;
  live: boolean;
  conversationId: string | null;
  /** Every conversation whose cost is in it — for a level of mixed parts. */
  conversations: Set<string>;
  children: Map<string, Draft>;
}

function draft(
  id: string,
  kind: SpendNodeKind,
  name: string,
  extra: Partial<Pick<Draft, "short" | "sub" | "conversationId">> = {},
): Draft {
  return {
    id,
    kind,
    name,
    short: extra.short ?? null,
    sub: extra.sub ?? null,
    costUsd: 0,
    billedUsd: 0,
    live: false,
    conversationId: extra.conversationId ?? null,
    conversations: new Set(),
    children: new Map(),
  };
}

/** The child `id` of `parent`, made by `make` the first time. */
function child(parent: Draft, id: string, make: () => Draft): Draft {
  const found = parent.children.get(id);
  if (found) return found;
  const made = make();
  parent.children.set(id, made);
  return made;
}

/** "Task title" from `task-title`: a background caller's name, in words. */
export function callerName(caller: string): string {
  const words = caller.replace(/[-_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The conversation leaf of a `conv:` row, under `parent`. */
function conversationOf(parent: Draft, row: SpendSourceRow): Draft {
  const conv = row.conversation;
  return child(parent, conv?.id ?? row.source, () =>
    conv
      ? draft(conv.id, "conversation", conv.title ?? "Conversation", {
          conversationId: conv.id,
        })
      : draft(row.source, "conversation", "Removed conversation"),
  );
}

/** Under a task: its attempt, then the conversation — the chain below `task`. */
function underTask(task: Draft, row: SpendSourceRow): Draft[] {
  const attempt = row.attempt;
  if (!attempt) return [conversationOf(task, row)];
  const level = child(task, attempt.id, () =>
    draft(attempt.id, "attempt", `Attempt ${attempt.number}`),
  );
  return [level, conversationOf(level, row)];
}

/**
 * Under a supervisor root's node: the root's own conversations are its
 * session (the supervisor itself), every other task under it a worker.
 */
function underSupervisor(
  parent: Draft,
  row: SpendSourceRow,
  root: SpendTaskRef,
  task: SpendTaskRef,
  sessionName: string,
): Draft[] {
  if (task.id === root.id) {
    const session = child(parent, `session:${root.id}`, () =>
      draft(`session:${root.id}`, "session", sessionName, {
        sub: "The supervisor itself",
      }),
    );
    return [session, ...underTask(session, row)];
  }
  const worker = child(parent, task.id, () =>
    draft(task.id, "task", task.title),
  );
  return [worker, ...underTask(worker, row)];
}

/**
 * Where one source's cost lands: the chain of nodes from its category down to
 * its leaf, made as needed. First match wins: a background caller; a role
 * session's tree; an ad-hoc supervisor's tree; an automation's task; else the
 * person's own (a conversation without a task included).
 */
function chainOf(
  categories: ReadonlyMap<SpendCategoryId, Draft>,
  row: SpendSourceRow,
  mandates: SpendMandates,
): Draft[] {
  const category = (id: SpendCategoryId): Draft => {
    const found = categories.get(id);
    if (!found) throw new Error(`spend: no category ${id}`);
    return found;
  };
  if (row.caller !== null) {
    const caller = row.caller;
    const bg = category("background");
    return [
      bg,
      child(bg, row.source, () =>
        draft(row.source, "caller", callerName(caller), {
          sub: "Background calls",
        }),
      ),
    ];
  }
  const { task, root } = row;
  if (!task || !root) {
    const you = category("you");
    return [you, conversationOf(you, row)];
  }
  if (row.mandateId === mandates.roleSession && row.role) {
    const role = row.role;
    const sup = category("supervisors");
    const roleNode = child(sup, role.id, () =>
      draft(role.id, "role", role.name),
    );
    return [
      sup,
      roleNode,
      ...underSupervisor(roleNode, row, root, task, `Session ${role.session}`),
    ];
  }
  if (
    row.mandateId === mandates.adhoc ||
    row.mandateId === mandates.roleSession
  ) {
    const adhoc = category("adhoc");
    const rootNode = child(adhoc, root.id, () =>
      draft(root.id, "task", root.title),
    );
    return [
      adhoc,
      rootNode,
      ...underSupervisor(rootNode, row, root, task, "Session"),
    ];
  }
  if (row.automationId !== null) {
    const automationId = row.automationId;
    const bg = category("background");
    const automation = child(bg, automationId, () =>
      draft(automationId, "automation", automationId),
    );
    const taskNode = child(automation, task.id, () =>
      draft(task.id, "task", task.title),
    );
    return [bg, automation, taskNode, ...underTask(taskNode, row)];
  }
  const you = category("you");
  const taskNode = child(you, task.id, () =>
    draft(task.id, "task", task.title),
  );
  return [you, taskNode, ...underTask(taskNode, row)];
}

const NOUNS: Partial<Record<SpendNodeKind, readonly [string, string]>> = {
  role: ["supervisor", "supervisors"],
  session: ["session", "sessions"],
  task: ["task", "tasks"],
  attempt: ["attempt", "attempts"],
  conversation: ["conversation", "conversations"],
  automation: ["automation", "automations"],
  caller: ["source", "sources"],
};

/** "3 tasks", "1 conversation" — `count` parts of `kinds`; `more` adds "more". */
function countOf(
  count: number,
  kinds: ReadonlySet<SpendNodeKind>,
  more = false,
): string {
  const [kind] = kinds;
  const noun = kinds.size === 1 && kind !== undefined ? NOUNS[kind] : undefined;
  const [one, many] = noun ?? ["part", "parts"];
  const n = count.toLocaleString("en-US");
  return `${n}${more ? " more" : ""} ${count === 1 ? one : many}`;
}

/** A node's sub-line, from all of its parts (before the top five). */
function subOf(d: Draft, parts: readonly SpendNode[]): string | null {
  if (d.sub !== null) return d.sub;
  const counted = parts.filter((p) => p.kind !== "session");
  if (d.kind === "role") {
    const session = parts.find((p) => p.kind === "session");
    const workers =
      counted.length === 0
        ? null
        : `${counted.length} worker${counted.length === 1 ? "" : "s"}`;
    const line = [session?.name, workers].filter(
      (s): s is string => s !== undefined && s !== null,
    );
    return line.length === 0 ? null : line.join(" · ");
  }
  if (counted.length === 0) return null;
  const kinds = new Set(counted.map((p) => p.kind));
  // Parts of mixed kinds (tasks beside loose conversations) are counted by
  // the conversations they hold.
  const words =
    kinds.size === 1
      ? countOf(counted.length, kinds)
      : countOf(d.conversations.size, new Set<SpendNodeKind>(["conversation"]));
  const live = counted.filter((p) => p.live).length;
  return d.kind === "category" && live > 0 ? `${words} · ${live} live` : words;
}

const byCost = (a: SpendNode, b: SpendNode): number =>
  b.costUsd - a.costUsd || a.name.localeCompare(b.name);

/** A level's five biggest parts, and one rest folding the others. */
function topParts(parts: readonly SpendNode[]): SpendNode[] {
  if (parts.length <= SPEND_TOP_PARTS + 1) return [...parts];
  const folded = parts.slice(SPEND_TOP_PARTS);
  return [
    ...parts.slice(0, SPEND_TOP_PARTS),
    {
      id: "rest",
      kind: "rest",
      name: countOf(folded.length, new Set(folded.map((p) => p.kind)), true),
      short: null,
      sub: null,
      costUsd: folded.reduce((s, p) => s + p.costUsd, 0),
      billedUsd: folded.reduce((s, p) => s + p.billedUsd, 0),
      live: folded.some((p) => p.live),
      conversationId: null,
      count: folded.length,
      children: [],
    },
  ];
}

/** Kinds of node that, holding one conversation alone, become its leaf. */
const FOLDS_INTO_CONVERSATION: ReadonlySet<SpendNodeKind> = new Set([
  "task",
  "attempt",
  "session",
]);

/**
 * A finished node. A level of one part says nothing a click would not, so it
 * is skipped: a task with one attempt lists that attempt's parts, and a task,
 * attempt or session that is one conversation becomes a leaf opening that
 * conversation (keeping its own name).
 */
function finish(d: Draft, keepOrder: boolean): SpendNode {
  let parts = [...d.children.values()].map((c) => finish(c, false));
  const lone = parts.length === 1 ? parts[0] : undefined;
  if (
    (d.kind === "task" || d.kind === "session") &&
    lone?.kind === "attempt" &&
    lone.children.length > 0
  )
    parts = lone.children;
  const only = parts.length === 1 ? parts[0] : undefined;
  if (
    FOLDS_INTO_CONVERSATION.has(d.kind) &&
    only !== undefined &&
    only.conversationId !== null &&
    only.children.length === 0
  ) {
    return {
      id: d.id,
      kind: d.kind,
      name: d.name,
      short: d.short,
      sub: d.sub,
      costUsd: d.costUsd,
      billedUsd: d.billedUsd,
      live: d.live,
      conversationId: only.conversationId,
      count: null,
      children: [],
    };
  }
  if (!keepOrder) parts.sort(byCost);
  return {
    id: d.id,
    kind: d.kind,
    name: d.name,
    short: d.short,
    sub: subOf(d, parts),
    costUsd: d.costUsd,
    billedUsd: d.billedUsd,
    live: d.live,
    conversationId: d.conversationId,
    count: null,
    children: topParts(parts),
  };
}

/**
 * The drill tree of `rows`: the root, then the categories in their fixed
 * order (one with no spend left out), each level below its five biggest
 * parts by cost plus a rest.
 */
export function buildSpendTree(
  rows: readonly SpendSourceRow[],
  mandates: SpendMandates,
): SpendNode {
  const root = draft(SPEND_ROOT_ID, "root", "Spent this week");
  const categories = new Map<SpendCategoryId, Draft>(
    SPEND_CATEGORIES.map((c) => [
      c.id,
      draft(c.id, "category", c.name, { short: c.short }),
    ]),
  );
  for (const c of categories.values()) root.children.set(c.id, c);
  for (const row of rows) {
    if (row.costUsd === 0) continue;
    for (const node of [root, ...chainOf(categories, row, mandates)]) {
      node.costUsd += row.costUsd;
      node.billedUsd += row.billedUsd;
      if (row.conversation?.live) node.live = true;
      if (row.conversation) node.conversations.add(row.conversation.id);
    }
  }
  for (const [id, c] of categories) {
    if (c.costUsd === 0) root.children.delete(id);
  }
  return finish(root, true);
}
