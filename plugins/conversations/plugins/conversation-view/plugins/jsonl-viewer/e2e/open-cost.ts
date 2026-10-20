/**
 * What opening a conversation costs the page: time to its first transcript row,
 * the live-state bytes the transcript's reads received while it opens (the
 * socket lives in a SharedWorker, so frames are counted where they reach the
 * page — the worker's port — and attributed by the resource key they name),
 * and how many rows it drew. Run it against this build and against main
 * (`--url http://singularity.localhost:9000`) for a before/after on the same
 * conversation.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/e2e/open-cost.ts --conv <id> [--settle-ms 4000] [--runs 3]
 */
import {
  arg,
  numArg,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const convId = arg("conv", "");
const settleMs = numArg("settle-ms", 4000);
const runs = numArg("runs", 3);

const kb = (n: number) => `${(n / 1e3).toFixed(0)} KB`;

// The transcript's own reads: the events (paged now, whole before), their
// meta, and every value served from the whole transcript.
const TRANSCRIPT_KEY =
  "^(jsonl-events|jsonl-viewer\\.|transcript-stats\\.|background-shells\\.facts|subagents\\.parent-facts|conversations\\.conversation-view\\.artifacts)";

interface Counts {
  total: number;
  transcript: number;
}

await withBrowser(async (h) => {
  const r = report("conversation open cost");
  if (convId === "") r.fail("--conv", "pass a conversation id");
  for (let run = 1; run <= runs && convId !== ""; run++) {
    // A fresh session per run: nothing cached from the run before.
    const { page } = await h.session();
    await page.addInitScript(() => {
      // Each socket frame reaches the tab as `{ data: <frame text> }` on the
      // worker's port; its resource key is the first `"key"` it names.
      const w = window as unknown as { __live: Record<string, number> };
      w.__live = {};
      const Native = window.SharedWorker;
      class Counted extends Native {
        constructor(url: string | URL, options?: string | WorkerOptions) {
          super(url, options);
          this.port.addEventListener("message", (e: MessageEvent) => {
            const text = (e.data as { data?: unknown } | null)?.data;
            if (typeof text !== "string") return;
            const key = /"key":"([^"]+)"/.exec(text)?.[1] ?? "(no key)";
            w.__live[key] = (w.__live[key] ?? 0) + text.length;
          });
        }
      }
      window.SharedWorker = Counted;
    });
    const counted = (): Promise<Counts> =>
      page.evaluate((pattern) => {
        const w = window as unknown as { __live: Record<string, number> };
        const re = new RegExp(pattern);
        let total = 0;
        let transcript = 0;
        for (const [key, n] of Object.entries(w.__live)) {
          total += n;
          if (re.test(key)) transcript += n;
        }
        return { total, transcript };
      }, TRANSCRIPT_KEY);

    const t0 = Date.now();
    await page.goto(pathUrl(`/agents/c/${convId}`), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("[data-event-key]", { timeout: 90_000 });
    const firstRowMs = Date.now() - t0;
    await page.waitForTimeout(settleMs);
    const { total, transcript } = await counted();
    const rows = await page.$$eval("[data-event-key]", (n) => n.length);
    r.note(
      `run ${run}: first row ${firstRowMs} ms; transcript reads ${kb(transcript)} ` +
        `of ${kb(total)} received after ${settleMs} ms; ${rows} rows drawn`,
    );
    r.ok(
      `run ${run} drew the transcript`,
      rows > 0,
      "no transcript row rendered",
    );
    await page.context().close();
  }
  await r.finish();
});
