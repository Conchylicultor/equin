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
 *
 * `--suite composite` (session 3, research/2026-11-02-global-live-composite-key-collections.md)
 * measures the five values over composite-key tables instead: each held on
 * one scope X — row order and custom values on fixture data views
 * (`narrowing-fixture:…`), bindings on fixture conversation F, track views
 * on `--song`, agent-notes authors on a content block of `--page` — plus F's
 * transcript values (recording a session: the adoption transaction). Phases:
 * ten writes on another scope of each (pass = 0 loads, 0 frames), the same
 * writes on X (one load, a keyed delta of about one row, each), then one
 * record-session on F. `--composite-keys old|v2` picks the keys (the old
 * whole-table values, or their `.v2` scoped collections).
 *
 *   ./equin run plugins/network/plugins/live/e2e/narrowing.ts --suite composite \
 *     --attempt <A> --page <page id> --other-page <page id> \
 *     --song <song id> --other-song <song id> [--composite-keys old|v2] [--runs 3]
 *
 * Its writes: rows under the two fixture data views (deleted after), bindings
 * on F and G (cascaded with them), track-view overrides on the two songs
 * (refused unless both start with none; reset after), author stamps under
 * fixture-minted conversation ids (deleted after).
 *
 * `--suite byid` (research/2026-11-02-global-live-follow-by-id-and-owner.md)
 * measures seven values that `follow` rows by id or owner, each held on a
 * subject X: `deploy.server-ssh-key`, `history.version`, `attachments.file`,
 * `attachments.by-owner` (a fixture task's attachments),
 * `claude-cli.calls-for`, `task-subject.by-subject` and
 * `task-source-url.by-attempt`. Everything is created by the run (fixture
 * deploy servers, versions, attachments, tasks and attempts, and correlation
 * ids — all `narrowing-fixture`-marked) and deleted after, so no argument is
 * needed. Phases per value: ten writes about another subject Y (pass = 0
 * loads, 0 frames), then the same writes about X (one load each). Not
 * measured here: `mail.message-body` and `events.run-events` (their rows hang
 * off FK chains no fixture creates yet).
 *
 *   ./equin run plugins/network/plugins/live/e2e/narrowing.ts --suite byid [--runs 3]
 */
import { PROTOCOL } from "@plugins/network/plugins/live/plugins/resource-protocol/core";
import { canonicalJson } from "@plugins/network/plugins/live/plugins/canonical-params/core";
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
const SUITE = arg("suite", "transcripts");
const COMPOSITE_KEYS = arg("composite-keys", "old");
const SONG = arg("song", "");
const OTHER_SONG = arg("other-song", "");

// Not importable (a `shared/` declaration): the literal keys.
const COMMITS_GRAPH_KEY = "commits-graph.graph";
const PLUGIN_CHANGES_KEY = "review.plugin-changes";

const r = report("[12] cost of a write per live tuple");
if (SUITE !== "transcripts" && SUITE !== "composite" && SUITE !== "byid") {
  r.fail("--suite", "transcripts | composite | byid");
}
if (COMPOSITE_KEYS !== "old" && COMPOSITE_KEYS !== "v2") {
  r.fail("--composite-keys", "old | v2");
}
const required: (readonly [string, string])[] =
  SUITE === "byid"
    ? []
    : SUITE === "composite"
      ? [
          ["--attempt", ATTEMPT],
          ["--page", PAGE],
          ["--other-page", OTHER_PAGE],
          ["--song", SONG],
          ["--other-song", OTHER_SONG],
        ]
      : [
          ["--page", PAGE],
          ["--other-page", OTHER_PAGE],
          ["--attempt", ATTEMPT],
          ["--attempt-b", ATTEMPT_B],
          ["--conv", CONV],
          ["--other-task", OTHER_TASK],
        ];
for (const [name, v] of required) {
  if (v === "") r.fail(name, "required");
}
if (SUITE === "transcripts") {
  if (OTHERS.length === 0) r.fail("--others", "pass other conversation ids");
  if (SUB_BY !== "call" && SUB_BY !== "agent") {
    r.fail("--subagent", "<call|agent>:<key>");
  }
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
async function fixture(body: NarrowingFixtureBody): Promise<string | null> {
  const { conversationId } = await json<{ conversationId: string | null }>(
    narrowingFixture.path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (body.action === "create-conversation") alive.add(conversationId!);
  if (body.action === "delete-conversation") alive.delete(conversationId!);
  return conversationId;
}
const createConv = async (attemptId: string): Promise<string> =>
  (await fixture({ action: "create-conversation", attemptId }))!;
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

/** What a sub-ack answered, by tuple id — a suite's precondition checks read it. */
type Acked = Map<string, unknown>;

/**
 * Hold `initial` over one socket, then run `phases` in order, reporting each
 * key of `keys` per phase: Δloads by parent, Δfeed, Δack overflows, drift and
 * the frames received per tuple label.
 */
async function measure(opts: {
  initial: Sub[];
  keys: readonly string[];
  /**
   * Runs once `initial` settled; throw to refuse the run (a precondition).
   * `unsubscribe` drops a tuple held only for the check.
   */
  check?: (acked: Acked, unsubscribe: (subs: Sub[]) => void) => void;
  phases: (subscribe: (subs: Sub[]) => void) => Phase[];
}): Promise<Row[]> {
  const served = await debug();
  for (const k of opts.keys) {
    if (!served.has(k))
      r.fail(
        k,
        "not served by this deploy (pass --page-key / --composite-keys?)",
      );
  }
  if (r.failures.length > 0) await r.finish();

  const labelOf = new Map<string, string>();
  const acked: Acked = new Map();
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
    if (m.kind === "sub-ack") acked.set(tupleId(m.key, m.params), m.value);
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

  const unsubscribe = (subs: Sub[]) => {
    for (const s of subs) {
      ws.send(
        JSON.stringify({ op: "unsub", key: s.key, params: s.params, tabId }),
      );
    }
  };

  subscribe(opts.initial);
  await sleep(SETTLE_MS * 2);
  if (r.failures.length > 0) await r.finish();
  if (opts.check) {
    try {
      opts.check(acked, unsubscribe);
    } catch (err) {
      ws.close();
      throw err;
    }
    await sleep(SETTLE_MS);
  }

  const rows: Row[] = [];
  for (const p of opts.phases(subscribe)) {
    if (p.setup) await p.setup();
    const [dBefore, lBefore] = [await debug(), await loads()];
    phase = p.name;
    for (let i = 0; i < p.writes; i++) {
      await p.write(i);
      await sleep(GAP_MS);
    }
    await sleep(SETTLE_MS);
    phase = `${p.name} (settled)`;
    const [dAfter, lAfter] = [await debug(), await loads()];
    for (const k of opts.keys) {
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
  return rows;
}

// ─── Suite: transcripts (session 2) ──────────────────────────────────────────

async function runTranscripts(n: number): Promise<Row[]> {
  const pluginChanges = (await debug()).has(PLUGIN_CHANGES_KEY);
  if (n === 0 && !pluginChanges) {
    r.note(`${PLUGIN_CHANGES_KEY} not served by this deploy: not measured`);
  }
  // F: the fixture whose transcript / worktree values are held beside C's.
  // G: a fixture in B nobody holds (record-session there reaches no tuple).
  const F = await createConv(ATTEMPT);
  const G = await createConv(ATTEMPT_B);

  const initial = [
    ...pageSubs,
    ...attemptSubs("A", ATTEMPT),
    ...convSubs("C", CONV, pluginChanges),
    ...convSubs("F", F, pluginChanges),
  ];
  const bSubs = attemptSubs("B", ATTEMPT_B);
  const created: string[] = [];
  let H = "";
  return measure({
    initial,
    keys: [...new Set([...initial, ...bSubs].map((s) => s.key))],
    phases: (subscribe) => [
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
    ],
  });
}

// ─── Suite: composite (session 3) ────────────────────────────────────────────

// Not importable (`shared/` declarations, or renamed by the migration): the
// literal keys, old (whole-table values) or `.v2` (scoped collections).
const v = (key: string) => (COMPOSITE_KEYS === "v2" ? `${key}.v2` : key);
const ROW_ORDER_KEY = v("data-view-row-order");
const CUSTOM_VALUES_KEY = v("data-view-custom-values");
const BINDINGS_KEY = v("active-data.bindings");
const TRACK_VIEW_KEY = v("sonata-track-view");
const AUTHORS_KEY = v("agent-notes-authors");

// A write whose answer the run never reads (some answer no body at all).
async function send(path: string, init: RequestInit): Promise<void> {
  const res = await agentFetch(path, init);
  if (!res.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`,
    );
  }
}
const post = (path: string, body: unknown, method = "POST") =>
  send(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
// Each write a real change: a rank / value / payload / volume flips with `i`.
const setOrder = (dataViewId: string, viewId: string, i: number) =>
  post("/api/data-view/row-order", {
    dataViewId,
    viewId,
    writes: [{ rowKey: "narrowing-row", rank: i % 2 === 0 ? "a0" : "a1" }],
  });
const setCell = (dataViewId: string, i: number) =>
  post("/api/data-view/custom-values", {
    dataViewId,
    rowKey: "narrowing-row",
    columnId: "narrowing-col",
    value: `v${i}`,
  });
const putBinding = (conversationId: string, i: number) =>
  post(
    `/api/active-data/bindings/${conversationId}/narrowing-msg/narrowing/0`,
    { payload: { i } },
    "PUT",
  );
const setTrack = (songId: string, i: number) =>
  post(`/api/sonata/songs/${songId}/track-view`, {
    trackIds: ["narrowing-track"],
    volume: i % 2 === 0 ? 0.5 : 1,
  });
const resetTracks = (songId: string) =>
  send(`/api/sonata/songs/${songId}/track-view`, { method: "DELETE" });
const stampAuthor = (blockId: string) =>
  fixture({ action: "stamp-agent-author", blockId });

const DV = { a: "narrowing-fixture:dvA", b: "narrowing-fixture:dvB" };

async function runComposite(n: number): Promise<Row[]> {
  // F: the fixture whose bindings and transcript values are held; G: another
  // conversation's bindings, nobody's.
  const F = await createConv(ATTEMPT);
  const G = await createConv(ATTEMPT);
  const block = (await contentBlockOf(PAGE)).id;
  const otherBlock = (await contentBlockOf(OTHER_PAGE)).id;
  if (n === 0) {
    r.note(`keys: ${COMPOSITE_KEYS}; held block ${block}, other ${otherBlock}`);
  }
  const held: Sub[] = [
    {
      label: "X",
      key: ROW_ORDER_KEY,
      params: { dataViewId: DV.a, viewId: "viewA" },
    },
    { label: "X", key: CUSTOM_VALUES_KEY, params: { dataViewId: DV.a } },
    { label: "X", key: BINDINGS_KEY, params: { conversationId: F } },
    { label: "X", key: TRACK_VIEW_KEY, params: { songId: SONG } },
    { label: "X", key: AUTHORS_KEY, params: { blockId: block } },
  ];
  // Held only to check the other song starts with no overrides (a reset
  // after the run would otherwise delete the user's).
  const probe: Sub = {
    label: "probe",
    key: TRACK_VIEW_KEY,
    params: { songId: OTHER_SONG },
  };
  const initial = [...held, probe, ...convSubs("F", F, false)];
  const cleanup = async () => {
    for (const dv of [DV.a, DV.b]) {
      await fixture({ action: "clear-row-order", dataViewId: dv });
      await post("/api/data-view/custom-values/delete-column", {
        dataViewId: dv,
        columnId: "narrowing-col",
      });
    }
    for (const b of [block, otherBlock]) {
      await fixture({ action: "clear-agent-authors", blockId: b });
    }
  };
  let songsChecked = false;
  try {
    return await measure({
      initial,
      keys: [...new Set(initial.map((s) => s.key))],
      check: (acked, unsubscribe) => {
        for (const songId of [SONG, OTHER_SONG]) {
          const value = acked.get(tupleId(TRACK_VIEW_KEY, { songId }));
          if (!Array.isArray(value) || value.length > 0) {
            throw new Error(
              `song ${songId} has track-view overrides (${JSON.stringify(value)}) — pass songs with none: the run resets both`,
            );
          }
        }
        songsChecked = true;
        unsubscribe([probe]);
      },
      phases: () => [
        {
          name: "row order: other view",
          related: false,
          writes: WRITES,
          write: (i) => setOrder(DV.a, "viewB", i),
        },
        {
          name: "custom value: other data view",
          related: false,
          writes: WRITES,
          write: (i) => setCell(DV.b, i),
        },
        {
          name: "binding: other conversation",
          related: false,
          writes: WRITES,
          write: (i) => putBinding(G, i),
        },
        {
          name: "track view: other song",
          related: false,
          writes: WRITES,
          write: (i) => setTrack(OTHER_SONG, i),
        },
        {
          name: "author stamp: other block",
          related: false,
          writes: WRITES,
          write: async () => {
            await stampAuthor(otherBlock);
          },
        },
        {
          name: "row order: held view",
          related: true,
          writes: WRITES,
          write: (i) => setOrder(DV.a, "viewA", i),
        },
        {
          name: "custom value: held data view",
          related: true,
          writes: WRITES,
          write: (i) => setCell(DV.a, i),
        },
        {
          name: "binding: F",
          related: true,
          writes: WRITES,
          write: (i) => putBinding(F, i),
        },
        {
          name: "track view: held song",
          related: true,
          writes: WRITES,
          write: (i) => setTrack(SONG, i),
        },
        {
          name: "author stamp: held block",
          related: true,
          writes: WRITES,
          write: async () => {
            await stampAuthor(block);
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
      ],
    });
  } finally {
    await cleanup();
    if (songsChecked) {
      for (const songId of [SONG, OTHER_SONG]) await resetTracks(songId);
    }
  }
}

// ─── Suite: byid ─────────────────────────────────────────────────────────────

// Not importable (`shared/` or non-barrel declarations): the literal keys.
const SERVER_KEY = "deploy.server-ssh-key";
const VERSION_KEY = "history.version";
const ATTACHMENT_KEY = "attachments.file";
const CALLS_KEY = "claude-cli.calls-for";
const SUBJECT_KEY = "task-subject.by-subject";
const SOURCE_URL_KEY = "task-source-url.by-attempt";
const BY_OWNER_KEY = "attachments.by-owner";
const FIXTURE_SOURCE = "narrowing-fixture";

type FixtureRowKind = Extract<
  NarrowingFixtureBody,
  { action: "create-fixture-row" }
>["row"];
type WriteTarget = Extract<
  NarrowingFixtureBody,
  { action: "write-fixture-row" }
>["target"];
type DeleteKind = Extract<
  NarrowingFixtureBody,
  { action: "delete-fixture-rows" }
>["kind"];

const createRow = async (row: FixtureRowKind): Promise<string> => {
  const body: NarrowingFixtureBody = { action: "create-fixture-row", row };
  const { rowId } = await json<{ rowId: string | null }>(
    narrowingFixture.path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return rowId!;
};
const writeRow = async (target: WriteTarget, id: string, value: string) => {
  await fixture({ action: "write-fixture-row", target, id, value });
};

async function runByid(): Promise<Row[]> {
  // Created rows, deleted in reverse order when the run ends (failed or not).
  const created: { kind: DeleteKind; id: string }[] = [];
  const make = async (kind: DeleteKind, row: FixtureRowKind) => {
    const id = await createRow(row);
    created.push({ kind, id });
    return id;
  };
  try {
    // X is held; Y is the other subject its writes must not reach.
    const [serverX, serverY] = [
      await make("deploy-server", { kind: "deploy-server" }),
      await make("deploy-server", { kind: "deploy-server" }),
    ];
    const entityX = `${FIXTURE_SOURCE}-${crypto.randomUUID()}`;
    const entityY = `${FIXTURE_SOURCE}-${crypto.randomUUID()}`;
    const [versionX, versionY] = [
      await make("version", { kind: "version", entityId: entityX }),
      await make("version", { kind: "version", entityId: entityY }),
    ];
    const [fileX, fileY] = [
      await make("attachment", { kind: "attachment" }),
      await make("attachment", { kind: "attachment" }),
    ];
    const [corrX, corrY] = [1, 2].map(
      () => `${FIXTURE_SOURCE}-${crypto.randomUUID()}`,
    ) as [string, string];
    created.push(
      { kind: "claude-cli-calls", id: corrX },
      { kind: "claude-cli-calls", id: corrY },
    );
    const [taskX, taskY] = [
      await make("task", { kind: "task" }),
      await make("task", { kind: "task" }),
    ];
    // The attempts hang off the tasks: the task delete removes them.
    const [attemptX] = [
      await createRow({ kind: "attempt", taskId: taskX }),
      await createRow({ kind: "attempt", taskId: taskY }),
    ];
    const [subjX, subjY] = [1, 2].map(
      () => `${FIXTURE_SOURCE}-${crypto.randomUUID()}`,
    ) as [string, string];
    await writeRow("task-subject", taskX, subjX);
    await writeRow("task-subject", taskY, subjY);
    await writeRow("task-source-url", taskX, "http://narrowing.invalid/x");
    await writeRow("task-source-url", taskY, "http://narrowing.invalid/y");
    // Each task links its own attachment (the by-owner tuples hold a row);
    // the link phases toggle a third attachment on and off.
    const linked = await make("attachment", { kind: "attachment" });
    await writeRow("task-attachment-link", taskX, fileX);
    await writeRow("task-attachment-link", taskY, fileY);
    // Seed one call each, so the held tuples hold a row.
    await writeRow("claude-cli-call", corrX, "");
    await writeRow("claude-cli-call", corrY, "");

    const initial: Sub[] = [
      { label: "X", key: SERVER_KEY, params: { serverId: serverX } },
      {
        label: "X",
        key: VERSION_KEY,
        params: {
          sourceId: FIXTURE_SOURCE,
          entityId: entityX,
          versionId: versionX,
        },
      },
      { label: "X", key: ATTACHMENT_KEY, params: { id: fileX } },
      { label: "X", key: CALLS_KEY, params: { correlationId: corrX } },
      {
        label: "X",
        key: SUBJECT_KEY,
        params: { kind: FIXTURE_SOURCE, id: subjX },
      },
      { label: "X", key: SOURCE_URL_KEY, params: { attemptId: attemptX } },
      {
        label: "X",
        key: BY_OWNER_KEY,
        params: { ownerType: "tasks", id: taskX },
      },
    ];
    // Each write a real change: the value flips with `i` (a re-point of a
    // subject link moves it between the subject and an alternate id).
    const value = (i: number) => `v${i}`;
    const alt = (id: string, i: number) => (i % 2 === 0 ? `${id}-alt` : id);
    const pair = (
      name: string,
      target: WriteTarget,
      x: string,
      y: string,
      valueOf: (id: string, i: number) => string = (_id, i) => value(i),
    ): Phase[] => [
      {
        name: `${name}: other`,
        related: false,
        writes: WRITES,
        write: (i) => writeRow(target, y, valueOf(y, i)),
      },
      {
        name: `${name}: held`,
        related: true,
        writes: WRITES,
        write: (i) => writeRow(target, x, valueOf(x, i)),
      },
    ];
    return await measure({
      initial,
      keys: initial.map((s) => s.key),
      phases: () => [
        ...pair("server ssh key", "server-ssh-key", serverX, serverY),
        ...pair("version snapshot", "version-snapshot", versionX, versionY),
        ...pair("attachment filename", "attachment-filename", fileX, fileY),
        ...pair("claude call", "claude-cli-call", corrX, corrY),
        // The subject id written is the link's target; the row written is the task's.
        {
          name: "task subject: other",
          related: false,
          writes: WRITES,
          write: (i) => writeRow("task-subject", taskY, alt(subjY, i)),
        },
        {
          name: "task subject: held",
          related: true,
          writes: WRITES,
          write: (i) => writeRow("task-subject", taskX, alt(subjX, i)),
        },
        ...pair(
          "source url",
          "task-source-url",
          taskX,
          taskY,
          (_id, i) => `http://narrowing.invalid/${i}`,
        ),
        // Toggles `linked` on the task's links (by-owner); `attachment
        // filename` above renames the held task's own attachment (X) or the
        // other task's (Y).
        ...pair(
          "attachment link",
          "task-attachment-link",
          taskX,
          taskY,
          () => linked,
        ),
      ],
    });
  } finally {
    for (const { kind, id } of created.reverse()) {
      await fixture({ action: "delete-fixture-rows", kind, id });
    }
  }
}

const run = (n: number) =>
  SUITE === "byid"
    ? runByid()
    : SUITE === "composite"
      ? runComposite(n)
      : runTranscripts(n);

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
