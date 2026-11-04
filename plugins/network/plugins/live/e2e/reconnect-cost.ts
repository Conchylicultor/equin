/**
 * What a live-socket reconnect costs: how many of the tab's subscriptions the
 * server answers from memory (`up-to-date` / `up-to-date-batch`) and how many
 * it reloads (`sub-ack`, a loader run through the read gate), plus the
 * runtime's version-map size against its tracked tuples.
 *
 * The page boots on each `--paths` route in turn (default `/`), settles, and
 * then, `--runs` times: drops the worktree socket (`tapSharedSocket`'s `drop`
 * — the server sees a real close, as on a network blip or a wake from sleep),
 * holds the reconnect for `--gap` ms (default 0: reconnect at once), releases
 * it, and waits until every entry of the tab's replay batch on the new
 * connection is answered. Per run it reports the replayed entries and how
 * they were answered, and `/api/resources/_debug`'s summed `subShortCircuits`
 * delta. Read-only: it writes nothing.
 *
 * research/2026-11-04-global-live-reconnect-linger-and-version-clock.md
 *
 *   ./equin run plugins/network/plugins/live/e2e/reconnect-cost.ts \
 *     [--paths /,/agents] [--runs 3] [--gap 0] [--headed]
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
const PATHS = arg("paths", "/").split(",");
const RUNS = numArg("runs", 3);
const GAP_MS = numArg("gap", 0);
const SETTLE_MS = 4000;
const REPLAY_TIMEOUT_MS = 30_000;

const r = report("network/live · what a live-socket reconnect costs");

interface Dbg {
  key: string;
  subShortCircuits: number;
  versions: Record<string, number>;
  subCounts: Record<string, number>;
}

async function debugTotals(): Promise<{
  shortCircuits: number;
  versions: number;
  tracked: number;
}> {
  const res = await agentFetch("/api/resources/_debug");
  if (!res.ok) throw new Error(`GET /api/resources/_debug → ${res.status}`);
  const j = (await res.json()) as { resources: Dbg[] };
  let shortCircuits = 0;
  let versions = 0;
  let tracked = 0;
  for (const e of j.resources) {
    shortCircuits += e.subShortCircuits;
    versions += Object.keys(e.versions).length;
    tracked += Object.keys(e.subCounts).length;
  }
  return { shortCircuits, versions, tracked };
}

/** How the replay's entries were answered, by frame kind. */
interface Answers {
  subAck: number;
  upToDate: number;
  error: number;
}

await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  const tap = await tapSharedSocket(page);

  // Every answer frame on each connection, by the sub id it answers.
  const answered = new Map<string, Map<number, keyof Answers>>();
  tap.onFrame((f) => {
    if (f.url !== WS || f.conn === null) return;
    const msg = JSON.parse(f.data) as {
      kind?: string;
      id?: number;
      entries?: Array<{ id?: number }>;
    };
    let byId = answered.get(f.conn);
    if (!byId) answered.set(f.conn, (byId = new Map()));
    const mark = (id: number | undefined, kind: keyof Answers) => {
      if (typeof id === "number" && !byId.has(id)) byId.set(id, kind);
    };
    if (msg.kind === "sub-ack") mark(msg.id, "subAck");
    else if (msg.kind === "up-to-date") mark(msg.id, "upToDate");
    else if (msg.kind === "sub-error") mark(msg.id, "error");
    else if (msg.kind === "up-to-date-batch") {
      for (const e of msg.entries ?? []) mark(e.id, "upToDate");
    }
  });

  for (const path of PATHS) {
    await boot(page, pathUrl(path), { settleMs: SETTLE_MS });
  }
  const opened = await waitFor(
    () => Promise.resolve(tap.connections(WS)),
    (c) => c.length > 0,
    { timeoutMs: 10_000, intervalMs: 100 },
  );
  r.ok("the page opened its live socket", opened.ok);
  await page.waitForTimeout(SETTLE_MS);

  const start = await debugTotals();
  r.note(
    `before: versions map ${start.versions} entries, tracked tuples ${start.tracked}`,
  );

  for (let run = 1; run <= RUNS; run++) {
    const before = tap.connections(WS).at(-1);
    const sentBefore = tap.sent(WS).length;
    const dbgBefore = await debugTotals();
    if (GAP_MS > 0) await tap.hold(WS);
    await tap.drop(WS);
    if (GAP_MS > 0) {
      await page.waitForTimeout(GAP_MS);
      await tap.release(WS);
    }
    const reopened = await waitFor(
      () => Promise.resolve(tap.connections(WS).at(-1)),
      (c) => c !== undefined && c !== before,
      { timeoutMs: 10_000, intervalMs: 50 },
    );
    const conn = reopened.value!;
    // The replay batch(es) sent after the drop: every entry's id.
    const ids = (): number[] =>
      tap
        .sent(WS)
        .slice(sentBefore)
        .filter((m) => m.op === "sub-batch")
        .flatMap((m) =>
          ((m.entries as Array<{ id?: number }>) ?? []).map((e) => e.id!),
        );
    const settled = await waitFor(
      () => Promise.resolve(ids()),
      (xs) =>
        xs.length > 0 && xs.every((id) => answered.get(conn)?.has(id) === true),
      { timeoutMs: REPLAY_TIMEOUT_MS, intervalMs: 100 },
    );
    const counts: Answers = { subAck: 0, upToDate: 0, error: 0 };
    for (const id of settled.value) {
      const kind = answered.get(conn)?.get(id);
      if (kind) counts[kind]++;
    }
    const dbgAfter = await debugTotals();
    r.ok(
      `run ${run}: replayed ${settled.value.length} subs in ${settled.waitedMs}ms — ` +
        `${counts.subAck} reloaded (sub-ack), ${counts.upToDate} up-to-date, ` +
        `${counts.error} errors; server short-circuits +${dbgAfter.shortCircuits - dbgBefore.shortCircuits}`,
      settled.ok,
    );
    await page.waitForTimeout(SETTLE_MS);
  }

  const end = await debugTotals();
  r.note(
    `after: versions map ${end.versions} entries, tracked tuples ${end.tracked}`,
  );
  r.ok(
    "no uncaught page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
});

await r.finish();
