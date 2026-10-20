/**
 * D8 measurement: a routed/notified FULL whose revalidate signature equals the
 * last sent one must send no frame.
 *
 * Subscribes over the live socket to the five transcript values of one
 * conversation, then causes unrelated `conversations`-row writes
 * (POST /api/conversations/:id/viewed on other conversations, plus a few on the
 * target) and compares, per value, the server's routed-recompute counters
 * (`/api/resources/_debug`) with the frames actually received.
 *
 * Expected: notifyStats.feed grows (routed recomputes happen) while frames
 * during the write phase are 0 for every value whose content did not change.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/e2e/no-op-frames.ts \
 *     --others conv-a,conv-b,… [--conv <id>] [--shell <id>] [--subagent-key <key>] [--own-writes 2]
 *
 * Without `--others` it asks nothing of the DB: pass ~8 non-hibernated
 * conversation ids (`select id from conversations where hibernated_at is null`).
 * This script only reads `_debug`; it writes `viewed` markers (agent-marked).
 */
import { PROTOCOL } from "@plugins/packages/plugins/resource-protocol/core";
import {
  agentFetch,
  arg,
  numArg,
  pathUrl,
  report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const CONV = arg("conv", "conv-1792063907-16fcx4");
const SHELL = arg("shell", "bzzjq3n3a");
const SUBAGENT_KEY = arg("subagent-key", "a1367a22b9d72afe7");
const OTHERS = arg("others", "").split(",").filter(Boolean);
const OWN_WRITES = numArg("own-writes", 2);
const GAP_MS = numArg("gap-ms", 1500);

const SUBS: { key: string; params: Record<string, string> }[] = [
  { key: "jsonl-viewer.outline.turns", params: { id: CONV } },
  { key: "subagent-activity", params: { id: CONV } },
  { key: "background-shell-output", params: { id: CONV, shellId: SHELL } },
  {
    key: "subagent-transcript",
    params: { id: CONV, by: "agent", key: SUBAGENT_KEY },
  },
  { key: "edited-files", params: { id: CONV } },
];
const KEYS = SUBS.map((s) => s.key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const r = report("D8: no frame for an unchanged routed FULL");
if (OTHERS.length === 0) {
  r.fail("--others", "pass comma-separated non-hibernated conversation ids");
  await r.finish();
}

interface Dbg {
  key: string;
  notifyStats: { hand: number; feed: number; producer: number };
  loaderStats?: { count: number };
  subscribers: number;
  tuples: number;
  policy: string;
}
async function debug(): Promise<Record<string, Dbg>> {
  const res = await agentFetch("/api/resources/_debug");
  if (!res.ok) throw new Error(`_debug ${res.status}`);
  const j = (await res.json()) as { resources: Dbg[] };
  const out: Record<string, Dbg> = {};
  for (const x of j.resources) if (KEYS.includes(x.key)) out[x.key] = x;
  return out;
}

interface Frame {
  phase: string;
  /** Index of the write in flight when the frame landed (-1 before the first). */
  write: number;
  kind: string;
  key?: string;
  chars: number;
  version?: number;
  etag?: string;
  hasValue: boolean;
  /** The value is byte-identical to the last one this key received (a new object, no change). */
  sameValue: boolean;
  reason?: string;
}
const frames: Frame[] = [];
const lastValue = new Map<string, string>();
let phase = "subscribe";
let writeIdx = -1;

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
  const value = "value" in m ? JSON.stringify(m.value) : undefined;
  const key = typeof m.key === "string" ? m.key : "";
  const sameValue = value !== undefined && lastValue.get(key) === value;
  if (value !== undefined) lastValue.set(key, value);
  frames.push({
    phase,
    write: writeIdx,
    kind: String(m.kind),
    key: m.key as string | undefined,
    chars: data.length,
    version: m.version as number | undefined,
    etag: m.etag as string | undefined,
    hasValue: "value" in m,
    sameValue,
    reason: m.reason as string | undefined,
  });
};

await debug(); // fail early if _debug is unreachable
const tabId = `d8-verify-${Date.now()}`;
SUBS.forEach((s, i) =>
  ws.send(
    JSON.stringify({
      op: "sub",
      id: i + 1,
      key: s.key,
      params: s.params,
      tabId,
      build: "d8-verify",
      protocol: PROTOCOL,
    }),
  ),
);
await sleep(6000);
phase = "settle";
await sleep(4000);
const d1 = await debug();
phase = "writes";

const targets = [...OTHERS, ...Array<string>(OWN_WRITES).fill(CONV)];
for (const id of targets) {
  writeIdx += 1;
  const res = await agentFetch(`/api/conversations/${id}/viewed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  r.ok(`POST viewed ${id}`, res.ok, `status ${res.status}`);
  if (!res.ok) break;
  await sleep(GAP_MS);
}
await sleep(6000);
phase = "after";
const d2 = await debug();
ws.close();

const rows = KEYS.map((k) => {
  const w = frames.filter((f) => f.phase === "writes" && f.key === k);
  const sub = frames.filter(
    (f) => f.phase !== "writes" && f.phase !== "after" && f.key === k,
  );
  return {
    key: k,
    policy: d2[k]?.policy,
    initialFrames: sub
      .map(
        (f) =>
          `${f.kind}${f.hasValue ? (f.sameValue ? "+same" : "+v") : ""}(${f.chars}c)`,
      )
      .join(" "),
    feedDelta: (d2[k]?.notifyStats.feed ?? 0) - (d1[k]?.notifyStats.feed ?? 0),
    handDelta: (d2[k]?.notifyStats.hand ?? 0) - (d1[k]?.notifyStats.hand ?? 0),
    loaderDelta:
      (d2[k]?.loaderStats?.count ?? 0) - (d1[k]?.loaderStats?.count ?? 0),
    framesDuringWrites: w.length,
    kinds: w
      .map((f) => `${f.kind}${f.sameValue ? "+same" : ""}@w${f.write}`)
      .join(","),
    chars: w.reduce((a, f) => a + f.chars, 0),
  };
});
console.table(rows);

// Only value-carrying `update` frames are the skip's business: an
// invalidate-mode value (edited-files) still sends its few-byte invalidate per
// routed change, by design — its client revalidates against the ETag.
for (const row of rows) {
  const updates = frames.filter(
    (f) => f.phase === "writes" && f.key === row.key && f.kind === "update",
  ).length;
  r.ok(
    `${row.key}: no update frames during unrelated writes`,
    updates === 0,
    `${row.framesDuringWrites} frame(s): ${row.kinds} (${row.chars} chars)`,
  );
}
r.note(
  `feed deltas show routed recomputes: ${rows.map((x) => `${x.key}=${x.feedDelta}`).join(" ")}`,
);
await r.finish();
