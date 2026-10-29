/**
 * Resources [12] measurement: what one write costs every live tuple it does
 * NOT concern, and what it costs the ones it does.
 *
 * Subscribes over the live socket to page-blocks (the related page and two
 * others), attempt-work and commits-graph (attempts A and B), and the worktree
 * and transcript values of a real conversation C in A and of a FIXTURE
 * conversation F the run creates in A (debug read-set's narrowing fixture —
 * never a real conversation's attempt or session chain). Then runs write
 * phases — unrelated writes first, then related ones — and reports, per key
 * and phase, the server's loader count and its parents (`push` vs `cascade`,
 * from the runtime profile), the change-feed notifies, `routeDrifted` and
 * `ackOverflows` (`/api/resources/_debug`), each diffed around the phase, and
 * every frame received (kind, chars) per tuple label (C / F / A / B / page).
 * Loads are per KEY (the runtime counts no tuple), frames per tuple.
 *
 * The plan (research/2026-10-24-global-live-narrowed-reads.md, Measurement):
 *   unrelated — a block on another page, `viewed` on other conversations,
 *     `viewed` on C, another task's title, create-conversation into B (B's
 *     values not held yet), record-session on a fixture nobody holds:
 *     pass = 0 loads / feed / update frames on every migrated key;
 *   related — a block on the held page, create-conversation into A,
 *     record-session on F, move F A→B, delete F (one write each but the
 *     block toggles).
 * `review.plugin-changes` is subscribed only when the deploy serves it (it is
 * excluded from the default composition). `--runs N` repeats the whole run
 * (fresh fixtures and socket each time) and reports each number's median.
 *
 *   ./equin run plugins/network/plugins/live/e2e/narrowing.ts \
 *     --page <held page id> --pages <2 more held page ids> --other-page <page id> \
 *     --attempt <A> --attempt-b <B> --conv <C in A> --others <conv ids> \
 *     --other-task <task id> [--shell <C's shell id>] [--subagent <by>:<key>] [--runs 3]
 *
 * Writes it makes: a block's fold (`expanded`) toggled and restored (net
 * zero), `viewed` markers, a task title toggled and restored, and fixture
 * conversations — every one deleted before the run ends (their synthetic
 * session-chain rows stay: the chain is append-only).
 */
import { PROTOCOL } from "@plugins/packages/plugins/resource-protocol/core";
import { canonicalJson } from "@plugins/packages/plugins/canonical-params/core";
import { pageBlocks } from "@plugins/page/plugins/editor/core";
import { attemptWork } from "@plugins/tasks/plugins/attempt-work/core";
import { editedFiles } from "@plugins/conversations/plugins/conversation-view/plugins/code/core";
import { allowFiles } from "@plugins/conversations/plugins/conversation-view/plugins/allow-monitor/core";
import {
  jsonlEvents,
  transcriptPrompts,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import { conversationTurns } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/outline/core";
import { usageFold } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/plugins/usage/core";
import {
  subagentActivity,
  subagentTranscript,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/core";
import { shellOutput } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/core";
import {
  narrowingFixture,
  type NarrowingFixtureBody,
} from "@plugins/debug/plugins/read-set/core";
import { getRuntimeProfile } from "@plugins/debug/plugins/profiling/plugins/runtime/core";
import {
  agentFetch,
  arg,
  numArg,
  pathUrl,
  report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const PAGE_KEY = arg("page-key", pageBlocks.key);
const PAGE = arg("page", "");
const PAGES = arg("pages", "").split(",").filter(Boolean);
const OTHER_PAGE = arg("other-page", "");
const ATTEMPT = arg("attempt", "");
const ATTEMPT_B = arg("attempt-b", "");
const CONV = arg("conv", "");
const OTHERS = arg("others", "").split(",").filter(Boolean);
const OTHER_TASK = arg("other-task", "");
// A shell / sub-agent C's transcript records, when it has one; else a name no
// transcript holds (the value answers `unknown-shell` / an empty transcript —
// still a loaded, routed tuple).
const SHELL = arg("shell", "narrowing-none");
const [SUB_BY = "", SUB_KEY = ""] = arg(
  "subagent",
  "agent:narrowing-none",
).split(":");
const WRITES = numArg("writes", 10);
const GAP_MS = numArg("gap-ms", 300);
// 4 s lost the move / delete phases' loads to a later phase on a loaded host
// (2026-10-28 baseline trial): the drain had not run when the counters were read.
const SETTLE_MS = numArg("settle-ms", 6000);
const RUNS = numArg("runs", 1);

// Not importable (a `shared/` declaration): the literal keys.
const COMMITS_GRAPH_KEY = "commits-graph.graph";
const PLUGIN_CHANGES_KEY = "review.plugin-changes";

const r = report("[12] cost of a write per live tuple");
for (const [name, v] of [
  ["--page", PAGE],
  ["--other-page", OTHER_PAGE],
  ["--attempt", ATTEMPT],
  ["--attempt-b", ATTEMPT_B],
  ["--conv", CONV],
  ["--other-task", OTHER_TASK],
] as const) {
  if (v === "") r.fail(name, "required");
}
if (OTHERS.length === 0) r.fail("--others", "pass other conversation ids");
if (SUB_BY !== "call" && SUB_BY !== "agent") {
  r.fail("--subagent", "<call|agent>:<key>");
}
if (r.failures.length > 0) await r.finish();

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await agentFetch(path, init);
  if (!res.ok)
    throw new Error(
      `${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`,
    );
  return (await res.json()) as T;
}

// ─── Server counters ─────────────────────────────────────────────────────────

interface Dbg {
  key: string;
  notifyStats: { hand: number; feed: number; producer: number };
  routeDrifted: string[];
  ackOverflows: number;
}
async function debug(): Promise<Map<string, Dbg>> {
  const j = await json<{ resources: Dbg[] }>("/api/resources/_debug");
  return new Map(j.resources.map((x) => [x.key, x]));
}

interface Loads {
  count: number;
  /** `<parent kind>` → count. */
  byParent: Map<string, number>;
}
async function loads(): Promise<Map<string, Loads>> {
  const p = await json<{
    aggregates: {
      loader: {
        label: string;
        count: number;
        byParent: { parent: { kind: string }; count: number }[];
      }[];
    };
  }>(getRuntimeProfile.path);
  const out = new Map<string, Loads>();
  for (const a of p.aggregates.loader) {
    const byParent = new Map<string, number>();
    for (const b of a.byParent) {
      byParent.set(b.parent.kind, (byParent.get(b.parent.kind) ?? 0) + b.count);
    }
    out.set(a.label, { count: a.count, byParent });
  }
  return out;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

// The block write is a fold toggle (`expanded`): a real `page_blocks` UPDATE
// that leaves the block's text alone (text is owned by its content doc, so a
// row write must not say it). An even number of toggles is net zero.
interface Block {
  id: string;
  type: string;
  expanded: boolean;
}
async function contentBlockOf(pageId: string): Promise<Block> {
  const body = await json<Block[] | { blocks: Block[] }>(
    `/api/pages/${pageId}/blocks`,
  );
  const list = Array.isArray(body) ? body : body.blocks;
  const b = list.find((x) => x.type !== "page");
  if (!b) throw new Error(`page ${pageId} has no content block`);
  return b;
}
async function toggleBlock(pageId: string): Promise<void> {
  const b = await contentBlockOf(pageId);
  await json(`/api/blocks/${b.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expanded: !b.expanded }),
  });
}
async function viewed(id: string): Promise<void> {
  await json(`/api/conversations/${id}/viewed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}
async function toggleTitle(id: string): Promise<void> {
  const t = await json<{ title: string } | { task: { title: string } }>(
    `/api/tasks/${id}`,
  );
  const title = "title" in t ? t.title : t.task.title;
  const next = title.endsWith(" ·") ? title.slice(0, -2) : `${title} ·`;
  await json(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: next }),
  });
}

/** The fixture conversations alive now — deleted at the end of a run, failed or not. */
const alive = new Set<string>();
async function fixture(body: NarrowingFixtureBody): Promise<string> {
  const { conversationId } = await json<{ conversationId: string }>(
    narrowingFixture.path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (body.action === "create-conversation") alive.add(conversationId);
  if (body.action === "delete-conversation") alive.delete(conversationId);
  return conversationId;
}
const createConv = (attemptId: string) =>
  fixture({ action: "create-conversation", attemptId });
const deleteConv = (conversationId: string) =>
  fixture({ action: "delete-conversation", conversationId });

// ─── Subscriptions ───────────────────────────────────────────────────────────

interface Sub {
  label: string;
  key: string;
  params: Record<string, string>;
}
const page0 = { after: null, until: null } as const;
function attemptSubs(label: string, attemptId: string): Sub[] {
  return [
    { label, key: attemptWork.key, params: { attemptId } },
    { label, key: COMMITS_GRAPH_KEY, params: { attemptId } },
  ];
}
function convSubs(label: string, id: string, pluginChanges: boolean): Sub[] {
  return [
    {
      label,
      key: editedFiles.key,
      params: editedFiles.query.encode(
        { id },
        { ...page0, limit: editedFiles.paged.limit },
      ),
    },
    { label, key: allowFiles.key, params: { id } },
    ...(pluginChanges
      ? [{ label, key: PLUGIN_CHANGES_KEY, params: { conversationId: id } }]
      : []),
    {
      label,
      key: jsonlEvents.key,
      params: jsonlEvents.query.encode(
        { id },
        { ...page0, limit: jsonlEvents.paged.limit },
      ),
    },
    { label, key: transcriptPrompts.key, params: { id } },
    { label, key: conversationTurns.key, params: { id } },
    // Folds the whole transcript: a `before` past any seq.
    { label, key: usageFold.before.key, params: { id, before: "999999999" } },
    { label, key: subagentActivity.key, params: { id } },
    { label, key: shellOutput.key, params: { id, shellId: SHELL } },
    {
      label,
      key: subagentTranscript.key,
      params: subagentTranscript.query.encode(
        { id, by: SUB_BY as "call" | "agent", key: SUB_KEY },
        { ...page0, limit: subagentTranscript.paged.limit },
      ),
    },
  ];
}
const pageSubs: Sub[] = [
  { label: "page", key: PAGE_KEY, params: { pageId: PAGE } },
  ...PAGES.map((p) => ({
    label: "pages",
    key: PAGE_KEY,
    params: { pageId: p },
  })),
];

const tupleId = (key: string, params: unknown) =>
  `${key} ${canonicalJson(params ?? {})}`;

// ─── One run ─────────────────────────────────────────────────────────────────

interface Phase {
  name: string;
  related: boolean;
  /** Before the `before` snapshot (subscribing B, creating a fixture). */
  setup?: () => Promise<void>;
  writes: number;
  write: (i: number) => Promise<void>;
  /** After the `after` snapshot, then settled before the next phase. */
  cleanup?: () => Promise<void>;
}
interface Row {
  phase: string;
  key: string;
  loads: number;
  parents: string;
  feed: number;
  ackOverflows: number;
  drifted: string;
  frames: string;
  chars: number;
}

// An even number of toggles leaves every row as it was.
const evenWrites = WRITES % 2 === 0 ? WRITES : WRITES + 1;

async function run(n: number): Promise<Row[]> {
  const served = await debug();
  const pluginChanges = served.has(PLUGIN_CHANGES_KEY);
  if (n === 0 && !pluginChanges) {
    r.note(`${PLUGIN_CHANGES_KEY} not served by this deploy: not measured`);
  }
  // F: the fixture whose transcript / worktree values are held beside C's.
  // G: a fixture in B nobody holds (record-session there reaches no tuple).
  const F = await createConv(ATTEMPT);
  const G = await createConv(ATTEMPT_B);

  const labelOf = new Map<string, string>();
  const frames: {
    phase: string;
    kind: string;
    key: string;
    label: string;
    chars: number;
  }[] = [];
  let phase = "subscribe";

  const ws = new WebSocket(pathUrl("/ws/notifications").replace(/^http/, "ws"));
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () =>
      rej(new Error("websocket error opening /ws/notifications"));
  });
  ws.onmessage = (ev) => {
    const data = String(ev.data);
    const m = JSON.parse(data) as Record<string, unknown>;
    if (m.kind === "ping" || typeof m.key !== "string") return;
    // A refused sub would read as "costs nothing" in every row below. After
    // the subscribe phase an error is a measured frame (F's values once F
    // is deleted).
    if (m.kind === "sub-error" && phase === "subscribe") {
      r.fail(`sub ${m.key}`, `${String(m.reason)} ${String(m.message ?? "")}`);
    }
    frames.push({
      phase,
      kind: String(m.kind),
      key: m.key,
      label: labelOf.get(tupleId(m.key, m.params)) ?? "?",
      chars: data.length,
    });
  };
  let nextId = 1;
  const tabId = `narrowing-${Date.now()}`;
  const subscribe = (subs: Sub[]) => {
    for (const s of subs) {
      labelOf.set(tupleId(s.key, s.params), s.label);
      ws.send(
        JSON.stringify({
          op: "sub",
          id: nextId++,
          key: s.key,
          params: s.params,
          tabId,
          build: "narrowing",
          protocol: PROTOCOL,
        }),
      );
    }
  };

  const initial = [
    ...pageSubs,
    ...attemptSubs("A", ATTEMPT),
    ...convSubs("C", CONV, pluginChanges),
    ...convSubs("F", F, pluginChanges),
  ];
  const bSubs = attemptSubs("B", ATTEMPT_B);
  const KEYS = [...new Set([...initial, ...bSubs].map((s) => s.key))];
  for (const k of KEYS) {
    if (!served.has(k))
      r.fail(k, "not served by this deploy (pass --page-key?)");
  }
  if (r.failures.length > 0) await r.finish();
  subscribe(initial);
  await sleep(SETTLE_MS * 2);
  if (r.failures.length > 0) await r.finish();

  const created: string[] = [];
  let H = "";
  const PHASES: Phase[] = [
    {
      name: "block on another page",
      related: false,
      writes: evenWrites,
      write: () => toggleBlock(OTHER_PAGE),
    },
    {
      name: "viewed: other conversations",
      related: false,
      writes: WRITES,
      write: (i) => viewed(OTHERS[i % OTHERS.length]!),
    },
    {
      name: "viewed: C",
      related: false,
      writes: WRITES,
      write: () => viewed(CONV),
    },
    {
      name: "another task's title",
      related: false,
      writes: evenWrites,
      write: () => toggleTitle(OTHER_TASK),
    },
    {
      name: "create-conversation into B (B not held)",
      related: false,
      writes: WRITES,
      write: async () => {
        created.push(await createConv(ATTEMPT_B));
      },
      cleanup: async () => {
        for (const id of created) await deleteConv(id);
      },
    },
    {
      name: "record-session: unheld fixture",
      related: false,
      writes: WRITES,
      write: async () => {
        await fixture({ action: "record-session", conversationId: G });
      },
      // B's values are held from here on (the related phases move F into B).
      cleanup: async () => subscribe(bSubs),
    },
    {
      name: "block on the held page",
      related: true,
      writes: evenWrites,
      write: () => toggleBlock(PAGE),
    },
    {
      name: "create-conversation into A",
      related: true,
      writes: 1,
      write: async () => {
        H = await createConv(ATTEMPT);
      },
      cleanup: async () => {
        await deleteConv(H);
      },
    },
    {
      name: "record-session: F",
      related: true,
      writes: 1,
      write: async () => {
        await fixture({ action: "record-session", conversationId: F });
      },
    },
    {
      name: "move-conversation F A→B",
      related: true,
      writes: 1,
      write: async () => {
        await fixture({
          action: "move-conversation",
          conversationId: F,
          attemptId: ATTEMPT_B,
        });
      },
    },
    {
      name: "delete-conversation F",
      related: true,
      writes: 1,
      write: async () => {
        await deleteConv(F);
      },
    },
  ];

  const rows: Row[] = [];
  for (const p of PHASES) {
    const [dBefore, lBefore] = [await debug(), await loads()];
    phase = p.name;
    for (let i = 0; i < p.writes; i++) {
      await p.write(i);
      await sleep(GAP_MS);
    }
    await sleep(SETTLE_MS);
    phase = `${p.name} (settled)`;
    const [dAfter, lAfter] = [await debug(), await loads()];
    for (const k of KEYS) {
      const lb = lBefore.get(k);
      const la = lAfter.get(k);
      const parents = [...(la?.byParent ?? new Map<string, number>())]
        .map(([kind, c]) => [kind, c - (lb?.byParent.get(kind) ?? 0)] as const)
        .filter(([, c]) => c > 0)
        .map(([kind, c]) => `${kind}:${c}`)
        .join(" ");
      const fs = frames.filter((f) => f.phase === p.name && f.key === k);
      const kinds = new Map<string, number>();
      for (const f of fs) {
        const id = `${f.label}:${f.kind}`;
        kinds.set(id, (kinds.get(id) ?? 0) + 1);
      }
      const b = dBefore.get(k);
      const a = dAfter.get(k);
      rows.push({
        phase: p.name,
        key: k,
        loads: (la?.count ?? 0) - (lb?.count ?? 0),
        parents,
        feed: (a?.notifyStats.feed ?? 0) - (b?.notifyStats.feed ?? 0),
        ackOverflows: (a?.ackOverflows ?? 0) - (b?.ackOverflows ?? 0),
        drifted: (a?.routeDrifted ?? []).join(","),
        frames: [...kinds].map(([kind, c]) => `${kind}×${c}`).join(" "),
        chars: fs.reduce((s, f) => s + f.chars, 0),
      });
    }
    if (p.cleanup) {
      phase = `${p.name} (cleanup)`;
      await p.cleanup();
      await sleep(SETTLE_MS);
    }
  }
  ws.close();
  for (const id of [...alive]) await deleteConv(id);
  return rows;
}

// ─── Runs, medians, report ───────────────────────────────────────────────────

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

const runs: Row[][] = [];
try {
  for (let n = 0; n < RUNS; n++) runs.push(await run(n));
} finally {
  // A run that failed midway still removes the fixtures it created.
  for (const id of [...alive]) await deleteConv(id);
}

const rows = runs[0]!.map((row, i) => {
  const all = runs.map((rs) => rs[i]!);
  const pick = (f: (x: Row) => number) => median(all.map(f));
  const text = (f: (x: Row) => string) => [...new Set(all.map(f))].join(" / ");
  return {
    phase: row.phase,
    key: row.key,
    loads: pick((x) => x.loads),
    parents: text((x) => x.parents),
    feed: pick((x) => x.feed),
    frames: text((x) => x.frames),
    chars: pick((x) => x.chars),
    ackOverflows: pick((x) => x.ackOverflows),
    drifted: text((x) => x.drifted),
  };
});
console.table(rows);
r.note(
  `${RUNS} run(s); numbers are medians, text columns the distinct values across runs`,
);
// Markdown, for the plan's tables.
console.log(
  [
    "| phase | key | Δloads | parents | Δfeed | frames | chars | ackOverflows | routeDrifted |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (x) =>
        `| ${x.phase} | ${x.key} | ${x.loads} | ${x.parents} | ${x.feed} | ${x.frames} | ${x.chars} | ${x.ackOverflows} | ${x.drifted} |`,
    ),
  ].join("\n"),
);
r.ok(
  "every run ran every phase",
  runs.every((rs) => rs.length === runs[0]!.length),
);
await r.finish();
