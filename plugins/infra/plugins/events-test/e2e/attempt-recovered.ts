// A job attempt that fails and whose retry recovers: enqueues the events-test
// log job with a `fail-once` label (it throws on attempt 1, logs on attempt 2)
// and waits for its retry to log. The run's `job-attempt-failed` report then
// reads "Recovered on attempt 2 · …" (jobs/plugins/attempt-audit) — inspect it
// in Debug → Reports, or `reports` with query_db.
//
// Usage:
//   ./equin run plugins/infra/plugins/events-test/e2e/attempt-recovered.ts

import {
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

interface LogResponse {
  entries: { label: string }[];
}

const label = `fail-once-${Date.now()}`;

await withBrowser(async (h) => {
  const { page } = await h.session();
  const res = await page.request.post(
    pathUrl("/api/events-test/direct-enqueue"),
    { data: { label } },
  );
  if (!res.ok()) throw new Error(`enqueue failed: ${res.status()}`);
  const { jobId } = (await res.json()) as { jobId: string };
  console.log(`enqueued ${label} as job ${jobId}`);

  // The retry backs off ~3 s after the first attempt's failure.
  for (let i = 0; i < 30; i++) {
    const log = (await page.request
      .get(pathUrl("/api/events-test/log"))
      .then((r) => r.json())) as LogResponse;
    if (log.entries.some((e) => e.label === label)) {
      console.log(`job ${jobId} recovered: its retry logged ${label}`);
      return;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`job ${jobId}: no retry logged ${label} within 30 s`);
});
