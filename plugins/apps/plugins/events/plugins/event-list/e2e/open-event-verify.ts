/**
 * End-to-end check that activating an event row opens its page.
 *
 * Manual only. Run after `./equin build`:
 *   ./equin run plugins/apps/plugins/events/plugins/event-list/e2e/open-event-verify.ts [--headed]
 *
 * The interesting arm is the FALLBACK: an extraction commonly yields no
 * per-event link, so the row must open the page the event was extracted from —
 * resolved generically through `events-core`'s `useEventSourceOrigin()` from the
 * source ref the server joins onto each event row, whose answer the source type
 * supplies via `originUrl`.
 *
 * The expected destination is read from the app's own state (the `events.list`
 * live collection's HTTP read + the sources endpoint), never hard-coded here: the script picks a REAL row,
 * asks the API whether that event carries a link of its own, and asserts the
 * opened tab against whichever answer applies. So it verifies the join, and it
 * keeps working on a machine whose events came from a different page.
 *
 * Read-only: it opens no dialog and creates nothing.
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { eventsList } from "../core";

const OUT = arg("out") ?? "/tmp/events-open";
const BOOT_TIMEOUT_MS = 90_000;

interface EventRow {
  id: string;
  title: string;
  url: string | null;
  sourceId: string;
}
interface SourceRow {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

const r = report("Events · open an event");

await withBrowser(async (h) => {
  const { page, captured } = await h.session();

  await boot(page, pathUrl("/events/list"), {
    marker: 'button:has-text("Upcoming")',
    timeoutMs: BOOT_TIMEOUT_MS,
    settleMs: 1200,
  });
  await snap(page, OUT, "1-events-list");

  // The app's own data, through the app's own read — the collection's HTTP
  // read, in the same session, so no auth plumbing. The landing view's own
  // question (Upcoming: from the start of today, soonest first), so the event
  // picked is one the list renders; disappeared rows and a disabled source's
  // events are excluded by the collection's default scopes.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const qs = new URLSearchParams(
    eventsList.window.window.encode({
      where: { startsAt: { gte: today.toISOString() } },
      orderBy: [["startsAt", "asc"]],
      limit: 20,
    }),
  ).toString();
  const eventsRes = await page.request.get(
    pathUrl(
      `/api/resources/${encodeURIComponent(eventsList.window.key)}?${qs}`,
    ),
  );
  r.ok("events read answered", eventsRes.ok(), `HTTP ${eventsRes.status()}`);
  const events = ((await eventsRes.json()) as { value: EventRow[] }).value;

  const sourcesRes = await page.request.get(pathUrl("/api/events/sources"));
  r.ok(
    "sources endpoint answered",
    sourcesRes.ok(),
    `HTTP ${sourcesRes.status()}`,
  );
  const sources = (await sourcesRes.json()) as SourceRow[];
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  // The row to click: prefer one with NO link of its own — that is the arm this
  // change exists for. Fall back to any event, and assert the matching arm.
  const target = events.find((e) => e.url === null) ?? events[0];
  if (target === undefined) {
    r.note("no events in this worktree — nothing to verify");
    await r.finish();
  }

  const source = sourceById.get(target!.sourceId);
  const originUrl =
    source !== undefined && typeof source.config.url === "string"
      ? source.config.url
      : null;
  const expected = target!.url ?? originUrl;
  r.note(
    `target "${target!.title}" — own link ${target!.url ?? "none"}, source page ${originUrl ?? "none"}`,
  );
  r.ok("a destination is resolvable for the target event", expected !== null);

  // Scope to a row by the event's own title: toolbar chips are buttons too. By
  // ROLE, not tag: a list row is a <button>, a gallery card a role="button" box.
  const row = page
    .getByRole("button")
    .filter({ hasText: target!.title })
    .first();
  const haveRow = (await row.count()) > 0;
  r.ok(`the target event's row is rendered ("${target!.title}")`, haveRow);

  if (haveRow && expected !== null) {
    const [popup] = await Promise.all([
      page.context().waitForEvent("page", { timeout: 15_000 }),
      row.click(),
    ]);
    const opened = popup.url();
    await snap(page, OUT, "2-after-click");
    r.ok(
      target!.url === null
        ? "a link-less event opens the page it was extracted from"
        : "an event with its own link opens that link",
      opened.startsWith(expected),
      `opened=${opened} expected=${expected}`,
    );
    await popup.close();
  }

  r.ok(
    "no uncaught page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  r.ok(
    "no console errors",
    captured.consoleErrors.length === 0,
    captured.consoleErrors.join(" | "),
  );
});

await r.finish();
