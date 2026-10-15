/**
 * Client latency samples feed slow-ops, end to end on a deployed build
 * (research/2026-10-13-global-live-latency-in-slow-ops.md, Part 2).
 *
 * With `updateMs` / `confirmMs` set to 0 every sample is "slow", so typing into
 * a throwaway page (optimistic write -> confirm; server pushes -> update) must
 * land `update` and `confirm` rows in the deploy's `slow_ops` table through the
 * slow-op beacon, carrying the documented wait phases:
 *   update  : server-notice / server-deliver / transport / client-apply
 *   confirm : send-lane / retry / server-ack / confirm-frame (variant mode/edge)
 *
 * WRITES: the two thresholds (agent-marked; withBrowser reverts them) and one
 * throwaway blank page left in the worktree fork DB.
 *
 * Usage: ./singularity run plugins/debug/plugins/slow-ops/e2e/client-latency.ts [--headed] [--out /tmp/client-latency]
 */
import {
  agentFetch,
  arg,
  openDeployDb,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  blockText,
  editableBlocks,
  openBlankPage,
} from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/client-latency");
const r = report("slow-ops · client latency (update / confirm)");
const STORE = "debug/slow-ops/slow-op.jsonc";

async function setField(key: string, value: number): Promise<void> {
  const res = await agentFetch("/api/config-v2/set-field", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storePath: STORE, key, value }),
  });
  if (!res.ok)
    throw new Error(`set-field ${key} -> ${res.status}: ${await res.text()}`);
}

type Row = {
  operation_kind: string;
  operation: string;
  count: number;
  waits: Record<string, unknown>;
  variants: unknown;
  measures: unknown;
  last_ms: number;
};

const db = openDeployDb();
try {
  await withBrowser(async (h) => {
    const startedAt = new Date();
    await setField("updateMs", 0);
    await setField("confirmMs", 0);

    const { page } = await h.session({ label: "A" });
    // Let the tab's useConfig see the 0 thresholds before the first sample.
    await openBlankPage(page, { settleMs: 2500 });
    for (let i = 0; i < 3; i++) {
      await editableBlocks(page).first().click();
      await page.keyboard.type(`latency probe ${i} `, { delay: 60 });
      await page.waitForTimeout(600);
    }
    await page.keyboard.press("Enter");
    await page.keyboard.type("second block", { delay: 60 });
    // beacon debounce is 250ms; leave generous room.
    await page.waitForTimeout(3000);

    // The confirm rows below only mean something if the writes really happened:
    // a keystroke lost before the editor focused would read as "no confirm".
    const texts = await Promise.all(
      (await editableBlocks(page).all()).map(blockText),
    );
    r.ok(
      "typed text landed in the document",
      texts.some((t) => t.includes("latency probe 2")) &&
        texts.some((t) => t.includes("second block")),
      JSON.stringify(texts),
    );

    const rows = await db.query<Row>(
      `select operation_kind, operation, count, waits, variants, measures, last_ms
         from slow_ops
        where operation_kind in ('update','confirm') and last_seen_at >= $1
        order by last_seen_at desc`,
      [startedAt],
    );
    for (const row of rows) {
      r.note(
        `${row.operation_kind} ${row.operation} n=${row.count} last=${row.last_ms} waits=${JSON.stringify(row.waits)} variants=${JSON.stringify(row.variants)}`,
      );
    }
    const of = (k: string) => rows.filter((x) => x.operation_kind === k);
    const waitNames = (k: string) =>
      new Set(of(k).flatMap((x) => Object.keys(x.waits ?? {})));

    r.ok("update rows recorded", of("update").length > 0);
    r.ok("confirm rows recorded", of("confirm").length > 0);
    const uw = waitNames("update");
    const cw = waitNames("confirm");
    r.note(`update wait phases: ${[...uw].join(", ")}`);
    r.note(`confirm wait phases: ${[...cw].join(", ")}`);
    r.ok(
      "update waits name a documented phase",
      ["server-notice", "server-deliver", "transport", "client-apply"].some(
        (p) => uw.has(p),
      ),
    );
    r.ok(
      "confirm waits name a documented phase",
      ["send-lane", "retry", "server-ack", "confirm-frame"].some((p) =>
        cw.has(p),
      ),
    );
    r.ok(
      "confirm variants look like <mode>/<edge>",
      of("confirm").some((x) => JSON.stringify(x.variants).includes("/")),
      JSON.stringify(of("confirm").map((x) => x.variants)),
    );

    // Optional visual: Debug -> Slow Events.
    await page.goto(pathUrl("/debug"), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await snap(page, out, "debug");
  });
} finally {
  await db.close();
}
await r.finish();
