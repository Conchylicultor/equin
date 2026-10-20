/**
 * Resources [12] measurement: what one write costs every live tuple it does
 * NOT concern, and what it ships to the ones it does.
 *
 * Subscribes over the live socket to page-blocks (the related page and two
 * others), attempt-work and commits-graph (one attempt), and the worktree /
 * transcript values of one conversation. Then runs write phases — unrelated
 * writes first (a block on a page nobody here holds, `viewed` on other
 * conversations, another task's title), related ones after (a block on the held
 * page, the conversation's own `viewed`). Per key and phase it reports the
 * server's loader and feed counters (`/api/resources/_debug`, diffed around the
 * phase) and every frame received (kind, chars).
 *
 * Run on a build of the merge-base (before) and of the branch (after). The
 * page key is the checkout's own `pageBlocks.key`; a run against a deploy of
 * another checkout passes `--page-key` (`page-blocks` before [12],
 * `page-blocks.v2` after). A key the deploy does not serve fails the run:
 *
 *   ./singularity run plugins/network/plugins/live/e2e/narrowing.ts \
 *     --page <held page id> --pages <2 more held page ids> --other-page <page id> \
 *     --attempt <att id> --conv <conv id> --others <conv ids> --other-task <task id>
 *
 * Writes it makes: a block's fold (`expanded`) toggled and restored (net
 * zero), `viewed` markers, a task title toggled and restored.
 */
import { PROTOCOL } from "@plugins/packages/plugins/resource-protocol/core";
import { pageBlocks } from "@plugins/page/plugins/editor/core";
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
const CONV = arg("conv", "");
const OTHERS = arg("others", "").split(",").filter(Boolean);
const OTHER_TASK = arg("other-task", "");
const WRITES = numArg("writes", 10);
const GAP_MS = numArg("gap-ms", 300);
const SETTLE_MS = numArg("settle-ms", 4000);

const r = report("[12] cost of a write per live tuple");
for (const [name, v] of [
  ["--page", PAGE],
  ["--other-page", OTHER_PAGE],
  ["--attempt", ATTEMPT],
  ["--conv", CONV],
  ["--other-task", OTHER_TASK],
] as const) {
  if (v === "") r.fail(name, "required");
}
if (OTHERS.length === 0) r.fail("--others", "pass other conversation ids");
if (r.failures.length > 0) await r.finish();

const SUBS: { key: string; params: Record<string, string> }[] = [
  { key: PAGE_KEY, params: { pageId: PAGE } },
  ...PAGES.map((p) => ({ key: PAGE_KEY, params: { pageId: p } })),
  { key: "attempt-work", params: { attemptId: ATTEMPT } },
  { key: "commits-graph.graph", params: { attemptId: ATTEMPT } },
  { key: "edited-files", params: { id: CONV } },
  { key: "allow-files", params: { id: CONV } },
  { key: "jsonl-viewer.outline.turns", params: { id: CONV } },
  { key: "subagent-activity", params: { id: CONV } },
];
const KEYS = [...new Set(SUBS.map((s) => s.key))];
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

interface Dbg {
  key: string;
  notifyStats: { hand: number; feed: number; producer: number };
  loaderStats?: { count: number };
}
async function debug(): Promise<Map<string, Dbg>> {
  const res = await agentFetch("/api/resources/_debug");
  if (!res.ok) throw new Error(`_debug ${res.status}`);
  const j = (await res.json()) as { resources: Dbg[] };
  return new Map(
    j.resources.filter((x) => KEYS.includes(x.key)).map((x) => [x.key, x]),
  );
}

interface Frame {
  phase: string;
  kind: string;
  key: string;
  params: string;
  chars: number;
}
const frames: Frame[] = [];
let phase = "subscribe";

const wsUrl = pathUrl("/ws/notifications").replace(/^http/, "ws");
const ws = new WebSocket(wsUrl);
await new Promise<void>((res, rej) => {
  ws.onopen = () => res();
  ws.onerror = () => rej(new Error(`websocket error opening ${wsUrl}`));
});
ws.onmessage = (ev) => {
  const data = String(ev.data);
  const m = JSON.parse(data) as Record<string, unknown>;
  if (m.kind === "ping" || typeof m.key !== "string") return;
  if (m.kind === "sub-error") {
    r.fail(`sub ${m.key}`, `${String(m.reason)} ${String(m.verdict ?? "")}`);
  }
  frames.push({
    phase,
    kind: String(m.kind),
    key: m.key,
    params: JSON.stringify(m.params ?? {}),
    chars: data.length,
  });
};

const tabId = `narrowing-${Date.now()}`;
SUBS.forEach((s, i) =>
  ws.send(
    JSON.stringify({
      op: "sub",
      id: i + 1,
      key: s.key,
      params: s.params,
      tabId,
      build: "narrowing",
      protocol: PROTOCOL,
    }),
  ),
);
await sleep(SETTLE_MS * 2);
// A refused sub, or a key the deploy does not serve, would read as "costs
// nothing" in every row below.
const served = await debug();
for (const k of KEYS) {
  if (!served.has(k)) r.fail(k, "not served by this deploy (pass --page-key?)");
}
if (r.failures.length > 0) await r.finish();

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await agentFetch(path, init);
  if (!res.ok)
    throw new Error(
      `${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`,
    );
  return (await res.json()) as T;
}
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

// An even number of toggles leaves every row as it was.
const evenWrites = WRITES % 2 === 0 ? WRITES : WRITES + 1;
const PHASES: {
  name: string;
  related: boolean;
  write: (i: number) => Promise<void>;
}[] = [
  {
    name: "block on another page",
    related: false,
    write: () => toggleBlock(OTHER_PAGE),
  },
  {
    name: "viewed: other conversations",
    related: false,
    write: (i) => viewed(OTHERS[i % OTHERS.length]!),
  },
  {
    name: "another task's title",
    related: false,
    write: () => toggleTitle(OTHER_TASK),
  },
  {
    name: "block on the held page",
    related: true,
    write: () => toggleBlock(PAGE),
  },
  {
    name: "viewed: own conversation",
    related: true,
    write: () => viewed(CONV),
  },
];

interface Row {
  phase: string;
  key: string;
  loads: number;
  feed: number;
  frames: string;
  chars: number;
}
const rows: Row[] = [];
for (const p of PHASES) {
  const before = await debug();
  phase = p.name;
  for (let i = 0; i < evenWrites; i++) {
    await p.write(i);
    await sleep(GAP_MS);
  }
  await sleep(SETTLE_MS);
  phase = `${p.name} (settled)`;
  const after = await debug();
  for (const k of KEYS) {
    const b = before.get(k);
    const a = after.get(k);
    const fs = frames.filter((f) => f.phase === p.name && f.key === k);
    const kinds = new Map<string, number>();
    for (const f of fs) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
    rows.push({
      phase: p.name,
      key: k,
      loads: (a?.loaderStats?.count ?? 0) - (b?.loaderStats?.count ?? 0),
      feed: (a?.notifyStats.feed ?? 0) - (b?.notifyStats.feed ?? 0),
      frames: [...kinds].map(([kind, n]) => `${kind}×${n}`).join(" "),
      chars: fs.reduce((s, f) => s + f.chars, 0),
    });
  }
}
ws.close();
console.table(rows);

// The page-blocks frames of the held page during its own edits: the cost the
// related write ships.
const own = frames.filter(
  (f) =>
    f.phase === "block on the held page" &&
    f.key === PAGE_KEY &&
    f.params.includes(PAGE),
);
r.note(
  `held page: ${own.length} frame(s), max ${Math.max(0, ...own.map((f) => f.chars))} chars, total ${own.reduce((s, f) => s + f.chars, 0)} over ${evenWrites} writes`,
);
for (const row of rows) {
  if (PHASES.find((p) => p.name === row.phase)?.related) continue;
  r.note(
    `${row.phase} → ${row.key}: loads ${row.loads}, feed ${row.feed}, frames ${row.frames || "0"} (${row.chars} chars)`,
  );
}
r.ok(
  "every phase ran",
  rows.length === PHASES.length * KEYS.length,
  `${rows.length} rows`,
);
await r.finish();
