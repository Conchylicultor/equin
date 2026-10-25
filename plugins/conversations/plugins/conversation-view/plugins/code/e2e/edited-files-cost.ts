/**
 * What the paged, pushed `edited-files` value costs, end to end
 * (research/2026-10-25-global-edited-files-paged-cost.md, Verification):
 *
 * 1. Subscribe over the live socket to one conversation's pages (one page,
 *    limit 2000) and its meta, and time sub → first frame — cold (the first
 *    socket opens the watch), then warm (a second socket while it is held).
 * 2. Write `viewed` markers on OTHER conversations (a conversations-row
 *    UPDATE, every agent turn's shape): no edited-files loader runs, no frame,
 *    and no routed recompute (`_debug` notifyStats.feed flat) — the lookup's
 *    gate skips a column it does not read.
 * 3. Create, then remove, one file in the conversation's worktree: one
 *    `watch-edited-files:pass` and a frame per tuple for each.
 * 4. Read the page tuple over HTTP: no D5 drift (`routeDrifted` empty).
 * 5. With `--race`: subscribe to a conversation id whose row does not exist
 *    yet, then insert it (a clone of `--conv`'s row): the value resolves and
 *    the watch opens after the insert — a file change then reaches it.
 *
 *   ./equin run plugins/conversations/plugins/conversation-view/plugins/code/e2e/edited-files-cost.ts \
 *     --conv <id> --others conv-a,conv-b,… [--writes-gap-ms 1500] [--race]
 *
 * `--conv` must be a git-workspace conversation of the deploy under test;
 * `--others` ~8 other conversation ids (`select id from conversations`). It
 * reads the worktree path from the deploy's DB (so it refuses main), writes
 * `viewed` markers, and creates + removes one scratch file in the worktree
 * (`.edited-files-cost-<ts>`); `--race` also inserts and then deletes one
 * cloned conversation row.
 */
import { join } from "node:path";
import { unlink, writeFile } from "node:fs/promises";
import { PROTOCOL } from "@plugins/packages/plugins/resource-protocol/core";
import { canonicalJson } from "@plugins/packages/plugins/canonical-params/core";
import {
  agentFetch,
  arg,
  flag,
  numArg,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  requireArg,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const USAGE =
  "edited-files-cost.ts --conv <id> --others <id,id,…> [--writes-gap-ms 1500] [--settle-ms 4000] [--race]";
const CONV = requireArg("conv", USAGE);
const OTHERS = arg("others", "").split(",").filter(Boolean);
const GAP_MS = numArg("writes-gap-ms", 1500);
const SETTLE_MS = numArg("settle-ms", 4000);
const RACE = flag("race");

const PAGES = "edited-files";
const META = "edited-files:meta";
const KEYS = [PAGES, META];
const PASS_LABEL = "watch-edited-files:pass";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const r = report("edited-files: one git pass per change, no fan-out per turn");
if (OTHERS.length === 0) {
  r.fail("--others", "pass comma-separated conversation ids other than --conv");
  await r.finish();
}

// ── the deploy's own state ─────────────────────────────────────────────────

interface Dbg {
  key: string;
  notifyStats: { hand: number; feed: number; producer: number };
  loaderStats?: { count: number };
  routeDrifted: string[];
  tuples: number;
  routes: Array<{ id: string; table: string }> | null;
}
async function debug(): Promise<Record<string, Dbg>> {
  const res = await agentFetch("/api/resources/_debug");
  if (!res.ok) throw new Error(`_debug ${res.status}`);
  const j = (await res.json()) as { resources: Dbg[] };
  const out: Record<string, Dbg> = {};
  for (const x of j.resources) if (KEYS.includes(x.key)) out[x.key] = x;
  for (const key of KEYS) {
    if (!out[key]) throw new Error(`_debug lists no "${key}"`);
  }
  return out;
}
const loads = (d: Dbg) => d.loaderStats?.count ?? 0;

/** How many watched passes the backend ran so far (every span kind's aggregate). */
async function passCount(): Promise<number> {
  const res = await agentFetch("/api/debug/profiling/runtime");
  if (!res.ok) throw new Error(`runtime profile ${res.status}`);
  const j = (await res.json()) as {
    aggregates: Record<string, Array<{ label: string; count: number }>>;
  };
  let n = 0;
  for (const list of Object.values(j.aggregates)) {
    for (const a of list) if (a.label === PASS_LABEL) n += a.count;
  }
  return n;
}

const db = openDeployDb();
const [row] = await db.query<{ path: string }>(
  `SELECT a.worktree_path AS path
     FROM conversations c JOIN attempts a ON a.id = c.attempt_id
    WHERE c.id = $1`,
  [CONV],
);
if (!row) {
  r.fail("--conv", `no conversation ${CONV} in ${db.namespace}`);
  await r.finish();
}
const worktree = row!.path;

// ── the live socket ────────────────────────────────────────────────────────

interface Frame {
  socket: string;
  phase: string;
  kind: string;
  key: string;
  id?: number;
  at: number;
  chars: number;
}
const frames: Frame[] = [];
let phase = "subscribe";
// Run on every frame received (a `subscribe` waiting for its first ones).
const onFrame = new Set<() => void>();

async function openSocket(name: string): Promise<WebSocket> {
  const wsUrl = pathUrl("/ws/notifications").replace(/^http/, "ws");
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error(`websocket error opening ${wsUrl}`));
  });
  ws.onmessage = (ev) => {
    const data = String(ev.data);
    const m = JSON.parse(data) as Record<string, unknown>;
    if (m.kind === "ping") return;
    frames.push({
      socket: name,
      phase,
      kind: String(m.kind),
      key: typeof m.key === "string" ? m.key : "",
      id: typeof m.id === "number" ? m.id : undefined,
      at: performance.now(),
      chars: data.length,
    });
    for (const listener of onFrame) listener();
  };
  onBeforeFinish(async () => ws.close());
  return ws;
}

// The pages' one tuple (page 0 at limit 2000 — the no-viewport read) and the
// meta's, for the question `{ id }`.
const tuplesOf = (
  id: string,
): { key: string; params: Record<string, string> }[] => {
  const q = canonicalJson({ id });
  return [
    { key: PAGES, params: { q, limit: "2000" } },
    { key: META, params: { q } },
  ];
};

let nextSubId = 1;
/** Subscribe `id`'s tuples on `ws`; resolves with sub → first frame per key (ms). */
async function subscribe(
  ws: WebSocket,
  socket: string,
  id: string,
  timeoutMs = 30_000,
): Promise<Record<string, number | null>> {
  const started = performance.now();
  const tabId = `edited-files-cost-${socket}-${Date.now()}`;
  const ids = new Map<number, string>();
  for (const t of tuplesOf(id)) {
    const subId = nextSubId++;
    ids.set(subId, t.key);
    ws.send(
      JSON.stringify({
        op: "sub",
        id: subId,
        key: t.key,
        params: t.params,
        tabId,
        build: "edited-files-cost",
        protocol: PROTOCOL,
      }),
    );
  }
  const firstOf = (key: string) =>
    frames.find(
      (f) =>
        f.socket === socket &&
        f.at >= started &&
        (f.key === key || (f.id !== undefined && ids.get(f.id) === key)) &&
        f.kind !== "ack",
    );
  // Settles on the frame that completes the set (pushed), or at the timeout.
  await new Promise<void>((done) => {
    const check = () => {
      if (KEYS.some((k) => !firstOf(k))) return;
      finish();
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      onFrame.delete(check);
      done();
    };
    onFrame.add(check);
    check();
  });
  return Object.fromEntries(
    KEYS.map((k) => {
      const f = firstOf(k);
      return [k, f ? Math.round(f.at - started) : null];
    }),
  );
}

// ── 1. sub → first frame, cold then warm ───────────────────────────────────

const passes0 = await passCount();
const ws1 = await openSocket("cold");
const cold = await subscribe(ws1, "cold", CONV);
for (const key of KEYS) {
  r.ok(`${key}: cold first frame`, cold[key] !== null, `${cold[key]} ms`);
}
const ws2 = await openSocket("warm");
const warm = await subscribe(ws2, "warm", CONV);
for (const key of KEYS) {
  r.ok(`${key}: warm first frame`, warm[key] !== null, `${warm[key]} ms`);
}
phase = "settle";
await sleep(SETTLE_MS);
const passesOpen = (await passCount()) - passes0;
r.note(`passes while opening (cold + warm): ${passesOpen}`);
r.ok("one pass opens the watch", passesOpen <= 1, `${passesOpen} pass(es)`);

// ── 2. conversations UPDATEs on other rows: gated out ──────────────────────

const d1 = await debug();
phase = "writes";
for (const id of OTHERS) {
  const res = await agentFetch(`/api/conversations/${id}/viewed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  r.ok(`POST viewed ${id}`, res.ok, `status ${res.status}`);
  if (!res.ok) break;
  await sleep(GAP_MS);
}
await sleep(SETTLE_MS);
const d2 = await debug();
for (const key of KEYS) {
  const during = frames.filter((f) => f.phase === "writes" && f.key === key);
  r.eq(
    `${key}: no loader run during unrelated writes`,
    loads(d2[key]!) - loads(d1[key]!),
    0,
  );
  r.eq(
    `${key}: no routed recompute (feed flat)`,
    d2[key]!.notifyStats.feed - d1[key]!.notifyStats.feed,
    0,
  );
  r.eq(`${key}: no frame during unrelated writes`, during.length, 0);
}

// ── 3. a worktree change: one pass, a frame per tuple ──────────────────────

const scratch = join(worktree, `.edited-files-cost-${Date.now()}`);
let scratchWritten = false;
onBeforeFinish(async () => {
  if (scratchWritten) await unlink(scratch);
});
for (const step of ["create", "remove"] as const) {
  const before = await passCount();
  const at = frames.length;
  phase = `file-${step}`;
  if (step === "create") {
    await writeFile(scratch, "edited-files-cost\n");
    scratchWritten = true;
  } else {
    await unlink(scratch);
    scratchWritten = false;
  }
  await sleep(SETTLE_MS);
  const ran = (await passCount()) - before;
  r.eq(`file ${step}: one watched pass`, ran, 1);
  for (const key of KEYS) {
    const got = frames
      .slice(at)
      .filter((f) => f.key === key && f.phase === phase);
    // Two sockets hold the tuple: one frame each.
    r.ok(
      `file ${step}: ${key} framed on each socket`,
      new Set(got.map((f) => f.socket)).size === 2,
      `${got.length} frame(s): ${got.map((f) => `${f.socket}:${f.kind}`).join(",")}`,
    );
  }
}

// ── 4. the HTTP read path: no drift ────────────────────────────────────────

phase = "http";
const [pageTuple] = tuplesOf(CONV);
const qs = new URLSearchParams(pageTuple!.params).toString();
const http = await agentFetch(
  `/api/resources/${encodeURIComponent(PAGES)}?${qs}`,
);
r.ok("HTTP read of the page tuple", http.ok, `status ${http.status}`);
const d3 = await debug();
for (const key of KEYS) {
  r.eq(`${key}: no route drift (D5)`, d3[key]!.routeDrifted, []);
  r.note(
    `${key} routes: ${(d3[key]!.routes ?? []).map((x) => x.id).join(", ")}`,
  );
}

// ── 5. subscribe before the row exists ─────────────────────────────────────

if (RACE) {
  phase = "race";
  const fresh = `conv-e2e${Date.now().toString(36)}`;
  const ws3 = await openSocket("race");
  const early = await subscribe(ws3, "race", fresh, 10_000);
  r.ok(
    "an unknown conversation answers (unresolved) before its row exists",
    KEYS.every((k) => early[k] !== null),
    JSON.stringify(early),
  );
  const at = frames.length;
  // A clone of `--conv`'s row under the new id: the same attempt, so the same
  // worktree.
  await db.query(
    `INSERT INTO conversations
       SELECT (jsonb_populate_record(c, jsonb_build_object('id', $1::text))).*
         FROM conversations c WHERE c.id = $2`,
    [fresh, CONV],
  );
  onBeforeFinish(async () => {
    await db.query(`DELETE FROM conversations WHERE id = $1`, [fresh]);
  });
  await sleep(SETTLE_MS);
  const afterInsert = frames.slice(at).filter((f) => f.socket === "race");
  r.ok(
    "the insert re-reads the parked tuples",
    KEYS.every((k) => afterInsert.some((f) => f.key === k)),
    afterInsert.map((f) => `${f.key}:${f.kind}`).join(","),
  );
  // The watch opened on that load: a file change now reaches the new tuples.
  const mark = frames.length;
  await writeFile(scratch, "edited-files-cost race\n");
  scratchWritten = true;
  await sleep(SETTLE_MS);
  const heard = frames.slice(mark).filter((f) => f.socket === "race");
  r.ok(
    "the parked watch opened: a file change reaches the new tuples",
    KEYS.every((k) => heard.some((f) => f.key === k)),
    heard.map((f) => `${f.key}:${f.kind}`).join(","),
  );
}

const final = await debug();
console.table(
  KEYS.map((key) => ({
    key,
    coldMs: cold[key],
    warmMs: warm[key],
    loads: loads(final[key]!),
    feed: final[key]!.notifyStats.feed,
    hand: final[key]!.notifyStats.hand,
    tuples: final[key]!.tuples,
  })),
);
// Last: teardowns run in registration order, and the --race one above still
// deletes its cloned row through the pool.
onBeforeFinish(() => db.close());
await r.finish();
