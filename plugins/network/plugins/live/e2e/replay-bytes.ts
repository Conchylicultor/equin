/**
 * What a full replay costs on ONE shared live socket, by number of tabs: the
 * bytes the socket carries while every tab on it restates its whole sub set
 * and every tuple reloads — what a server restart does.
 *
 * `--tabs` pages of one browser context (so one SharedWorker, one socket) boot
 * on `--path` (default `/`) and settle. Then the socket is dropped with its
 * reconnect held past the server's reconnect linger (`--gap`, default 35 s >
 * SOCKET_LINGER_MS): every tuple's tracking span closes, so each tab's replay
 * on the new connection takes the full path, as after a restart (no handoff,
 * no version short-circuit). The run waits until the socket has been quiet for
 * 5 s and reports the chars it carried since the release — by frame kind, and
 * the heaviest value sub-ack keys — plus `/api/resources/_debug`'s per-key
 * deltas: `subAckChars` (value sub-acks sent), `subAcksShared` and
 * `subAckCharsSaved` (subs answered by another tab's frame on the same socket,
 * and what each would have cost). Before `alreadyShipped` (resource-runtime),
 * the socket's chars grew with the number of tabs; after, they should not.
 *
 * Read-only: it writes nothing.
 *
 *   ./equin run plugins/network/plugins/live/e2e/replay-bytes.ts \
 *     [--tabs 3] [--path /] [--gap 35000] [--headed]
 */

import {
  agentFetch,
  arg,
  boot,
  numArg,
  pathUrl,
  report,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";

const WS = "/ws/notifications";
const TABS = numArg("tabs", 3);
const PATH = arg("path", "/");
const GAP_MS = numArg("gap", 35_000);
const SETTLE_MS = 5000;
const QUIET_MS = 5000;
const REPLAY_TIMEOUT_MS = 120_000;

const r = report("network/live · what a full replay costs on one socket");

interface Dbg {
  key: string;
  subAckChars?: number;
  subAcksShared?: number;
  subAckCharsSaved?: number;
}

async function debugByKey(): Promise<Map<string, Dbg>> {
  const res = await agentFetch("/api/resources/_debug");
  if (!res.ok) throw new Error(`GET /api/resources/_debug → ${res.status}`);
  const j = (await res.json()) as { resources: Dbg[] };
  return new Map(j.resources.map((e) => [e.key, e]));
}

interface KeyDelta {
  key: string;
  chars: number;
  shared: number;
  saved: number;
}

/** Per key, what the server sent between two `_debug` reads. */
function debugDelta(
  before: Map<string, Dbg>,
  after: Map<string, Dbg>,
): KeyDelta[] {
  const out: KeyDelta[] = [];
  for (const [key, a] of after) {
    const b = before.get(key);
    const chars = (a.subAckChars ?? 0) - (b?.subAckChars ?? 0);
    const shared = (a.subAcksShared ?? 0) - (b?.subAcksShared ?? 0);
    const saved = (a.subAckCharsSaved ?? 0) - (b?.subAckCharsSaved ?? 0);
    if (chars > 0 || shared > 0) out.push({ key, chars, shared, saved });
  }
  return out.sort((x, y) => y.chars + y.saved - (x.chars + x.saved));
}

const mb = (chars: number) => `${(chars / 1e6).toFixed(2)} M chars`;

await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  const tap = await tapSharedSocket(page);

  // Every frame the socket carried: when, its size, kind and key.
  const rx: Array<{
    at: number;
    chars: number;
    kind: string;
    key: string | null;
    value: boolean;
  }> = [];
  tap.onFrame((f) => {
    if (f.url !== WS) return;
    const msg = JSON.parse(f.data) as { kind?: string; key?: string };
    rx.push({
      at: Date.now(),
      chars: f.data.length,
      kind: msg.kind ?? "?",
      key: msg.key ?? null,
      value: "value" in msg,
    });
  });

  await boot(page, pathUrl(PATH), { settleMs: SETTLE_MS });
  const others = [];
  for (let i = 1; i < TABS; i++) {
    const p = await page.context().newPage();
    await boot(p, pathUrl(PATH), { settleMs: SETTLE_MS });
    others.push(p);
  }
  const opened = await waitFor(
    () => Promise.resolve(tap.connections(WS)),
    (c) => c.length > 0,
    { timeoutMs: 10_000, intervalMs: 100 },
  );
  r.ok(`${TABS} tab(s) share the live socket`, opened.ok);
  await page.waitForTimeout(SETTLE_MS);

  const before = tap.connections(WS).at(-1);
  const dbgBefore = await debugByKey();
  await tap.hold(WS);
  await tap.drop(WS);
  await page.waitForTimeout(GAP_MS);
  // Every frame from here on is the new connection's (the old one is gone),
  // whichever connection id the tap had stamped on it yet.
  const releasedAt = Date.now();
  await tap.release(WS);
  const reopened = await waitFor(
    () => Promise.resolve(tap.connections(WS).at(-1)),
    (c) => c !== undefined && c !== before,
    { timeoutMs: 10_000, intervalMs: 50 },
  );
  r.ok("the socket reconnected", reopened.ok);
  const quiet = await waitFor(
    () => Promise.resolve(rx.filter((f) => f.at >= releasedAt)),
    (fs) => fs.length > 0 && Date.now() - fs.at(-1)!.at > QUIET_MS,
    { timeoutMs: REPLAY_TIMEOUT_MS, intervalMs: 250 },
  );
  const frames = quiet.value;
  const delta = debugDelta(dbgBefore, await debugByKey());

  const total = frames.reduce((n, f) => n + f.chars, 0);
  const byKind = new Map<string, { n: number; chars: number }>();
  const ackByKey = new Map<string, { n: number; chars: number }>();
  for (const f of frames) {
    const k = f.kind === "sub-ack" && !f.value ? "sub-ack (no value)" : f.kind;
    const e = byKind.get(k) ?? { n: 0, chars: 0 };
    e.n++;
    e.chars += f.chars;
    byKind.set(k, e);
    if (f.kind === "sub-ack" && f.value && f.key !== null) {
      const a = ackByKey.get(f.key) ?? { n: 0, chars: 0 };
      a.n++;
      a.chars += f.chars;
      ackByKey.set(f.key, a);
    }
  }
  r.ok(
    `replay on one socket, ${TABS} tab(s): ${frames.length} frames, ${mb(total)}`,
    quiet.ok,
  );
  for (const [kind, e] of [...byKind].sort((a, b) => b[1].chars - a[1].chars))
    r.note(`  ${kind}: ${e.n} frames, ${mb(e.chars)}`);
  for (const [key, a] of [...ackByKey]
    .sort((x, y) => y[1].chars - x[1].chars)
    .slice(0, 8))
    r.note(`  sub-ack ${key}: ×${a.n}, ${mb(a.chars)}`);
  const sum = (f: (d: KeyDelta) => number) =>
    delta.reduce((n, d) => n + f(d), 0);
  r.note(
    `server: value sub-acks ${mb(sum((d) => d.chars))}, ` +
      `${sum((d) => d.shared)} shared answers (saved ~${mb(sum((d) => d.saved))})`,
  );
  for (const d of delta.slice(0, 8))
    r.note(
      `  ${d.key}: sent ${mb(d.chars)}, ${d.shared} shared (saved ~${mb(d.saved)})`,
    );
  for (const p of others) await p.close();
  r.ok(
    "no uncaught page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
});

await r.finish();
