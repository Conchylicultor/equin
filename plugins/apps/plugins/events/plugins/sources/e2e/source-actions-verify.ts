/**
 * End-to-end check of the three source ACTIONS, against a deployed worktree.
 *
 * Manual only. Run after `./equin build`:
 *   ./equin run plugins/apps/plugins/events/plugins/sources/e2e/source-actions-verify.ts [--headed]
 *
 * `sources-verify.ts` covers the surface (the registry-driven `+` menu, the
 * generated form, the contributed sections). This one covers what the row and
 * the toolbar DO, and each step is written against a claim about the design
 * rather than against a pixel:
 *
 *   1. the row toggle is a SWITCH, and an ACTION rather than a navigation. It
 *      is a real `role="switch"` beside the row's own primary button, inside a
 *      cluster that stops the click — so disabling a source never also opens
 *      its detail pane, and the very same switch (relabelled) puts it back.
 *      That reversibility is why the action carries no confirm. Being a switch
 *      is also what makes the state machine-readable: every step below asserts
 *      `aria-checked`, so "the row says what it is at rest" is checked, not
 *      merely looked at;
 *   2. a disabled source's events leave the events list as a query-time
 *      DEFAULT, never a delete. Three assertions, because that one word is the
 *      whole design: the unfiltered list drops by exactly the source's own
 *      count; a filter that NAMES `sourceId` still returns every one of them
 *      (naming the dimension defeats the default — the `events.list`
 *      collection's `unless: "sourceId"` default scope, the same rule
 *      `disappearedAt` gets); and
 *      re-enabling restores the original count, so nothing was stamped, moved
 *      or deleted;
 *   3. that scope is PUSHED, not polled. The toggle is flipped out-of-band
 *      (a PATCH from this script, never through the open tab's own UI), so an
 *      events list that updates can only have learned it from the server —
 *      the `source` lookup's reverse route refilling that source's events;
 *   4. "Refresh all" is a SET operation with a tally, and the tally is rendered
 *      arm by arm — a resolved promise is not "everything refreshed". Every arm
 *      `describeRefreshAll` can produce is accepted, so a deploy whose sources
 *      are all disabled passes honestly instead of demanding a success chirp.
 *
 * The fourth is checked last because it is the only one that spends anything:
 * it ENQUEUES real runs (a probe per enabled source, and an extraction — a live
 * model call for a `url` source — only where the page actually moved). The
 * script therefore asserts on the enqueue tally and never on a run's outcome;
 * the runs land long after it exits.
 *
 * Reads the app's own data through the app's own endpoints and live resources
 * (`GET /api/resources/<key>`, the HTTP read every live subscription can
 * fall back to), in the page's own session, so it keeps working on a machine
 * whose sources are not this one's.
 *
 * Idempotent: every source it switches off is switched back on in a `finally`,
 * so a killed run cannot leave a source quietly disabled.
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { eventsList } from "@plugins/apps/plugins/events/plugins/event-list/core";

const OUT = arg("out") ?? "/tmp/events-source-actions";

/** See `sources-verify.ts`: a marker the app had to render, and room for it. */
const BOOT_TIMEOUT_MS = 90_000;

/**
 * How far from a row's own label an action button may sit and still be that
 * row's. Half of a `md` list row (44px) plus slack — a neighbouring row's
 * button is a full row height away, so this cannot pick the wrong one.
 */
const ROW_HALF_HEIGHT_PX = 26;

/** One page of the per-source counts — the grouping's maximum (`LIST_MAX`). */
const MAX_SOURCE_GROUPS = 100;

interface SourceRow {
  id: string;
  name: string;
  enabled: boolean;
}
interface EventRow {
  id: string;
  title: string;
  sourceId: string;
}
/** A live resource's HTTP read: its current value. */
interface ResourceBody<T> {
  value: T;
}

const r = report("Events · source actions");

await withBrowser(async (h) => {
  const { page, captured } = await h.session();

  // ---------------------------------------------------------------------------
  // The app's own endpoints, through the page's own session — no auth plumbing.
  // ---------------------------------------------------------------------------

  const listSources = async (): Promise<SourceRow[]> => {
    const res = await page.request.get(pathUrl("/api/events/sources"));
    if (!res.ok()) throw new Error(`GET /api/events/sources — ${res.status()}`);
    return (await res.json()) as SourceRow[];
  };

  /** The out-of-band write. Also the cleanup path, hence a named helper. */
  const setEnabled = async (id: string, enabled: boolean): Promise<boolean> => {
    const res = await page.request.patch(pathUrl(`/api/events/sources/${id}`), {
      data: { enabled },
    });
    return res.ok();
  };

  /** A live resource's current value, read over HTTP. */
  const readResource = async <T>(
    key: string,
    params: Record<string, string>,
  ): Promise<T> => {
    const qs = new URLSearchParams(params).toString();
    const res = await page.request.get(
      pathUrl(`/api/resources/${encodeURIComponent(key)}${qs ? `?${qs}` : ""}`),
    );
    if (!res.ok())
      throw new Error(`GET /api/resources/${key} — ${res.status()}`);
    return ((await res.json()) as ResourceBody<T>).value;
  };

  /**
   * How many events the list would show — the TOTAL, from the collection's
   * `:groups` read (a count per source), never a capped page of rows: every
   * assertion below is an exact-count comparison, and a clamped number would
   * make two genuinely different sets look identical. Without a source the
   * list's default scopes apply (a disabled source's events hidden); naming the
   * source drops that default, exactly as a filter on `sourceId` does.
   */
  const countEvents = async (sourceId: string | null): Promise<number> => {
    const groups = await readResource<{ value: unknown; count: number }[]>(
      eventsList.groups.key,
      eventsList.groups.groups.encode({
        groupBy: "sourceId",
        limit: MAX_SOURCE_GROUPS,
        ...(sourceId === null ? {} : { where: { sourceId } }),
      }),
    );
    if (groups.length === MAX_SOURCE_GROUPS) {
      throw new Error(
        `${MAX_SOURCE_GROUPS}+ sources — a count over one page of groups would be a lower bound`,
      );
    }
    return groups.reduce((sum, g) => sum + g.count, 0);
  };

  /** Events of one source, for picking a title that is on screen. */
  const eventsOf = async (id: string): Promise<EventRow[]> =>
    readResource<EventRow[]>(
      eventsList.window.key,
      eventsList.window.window.encode({ where: { sourceId: id }, limit: 50 }),
    );

  // ---------------------------------------------------------------------------
  // Finding a row's OWN action button.
  // ---------------------------------------------------------------------------

  /**
   * The action control belonging to the row whose label reads {@link name}.
   *
   * Every row's actions are in the DOM at all times — the reveal is a per-row
   * hover that couples opacity with pointer-events — so a page-wide
   * `getByRole("switch", { name: "Disable source" }).first()` resolves to some
   * OTHER row's invisible, `pointer-events: none` switch. Playwright then
   * clicks the point it occupies, the click lands on the row underneath, and
   * the "toggle" merely opens that row's detail pane. Green script, nothing
   * toggled.
   *
   * So: hover the row's label first (the label sits inside the row's primary
   * button, which is a sibling of the actions cluster under the row container —
   * hovering it hovers the container that owns the reveal), then pick the
   * action whose vertical centre is inside that row's band.
   *
   * `switch`, not `button`: the toggle is now a `role="switch"`, which does
   * NOT match `getByRole("button")` — a switch is its own role, not a button
   * with an extra attribute. Its accessible name is the `aria-label` the
   * control carries, and `exact: true` is kept for the reason
   * `sources-verify.ts` documents.
   */
  const rowAction = async (
    name: string,
    action: "Disable source" | "Enable source",
  ) => {
    const label = page.getByText(name, { exact: true }).first();
    await label.scrollIntoViewIfNeeded();
    const labelBox = await label.boundingBox();
    if (labelBox === null) return null;
    await label.hover();
    // The reveal is a CSS transition; a click landing mid-fade is still a click
    // on a `pointer-events: none` element.
    await page.waitForTimeout(600);
    const centre = labelBox.y + labelBox.height / 2;
    for (const candidate of await page
      .getByRole("switch", { name: action, exact: true })
      .all()) {
      const box = await candidate.boundingBox();
      if (box === null) continue;
      if (Math.abs(box.y + box.height / 2 - centre) <= ROW_HALF_HEIGHT_PX) {
        return candidate;
      }
    }
    return null;
  };

  /**
   * Every source this script has switched off at any point. Entries are never
   * removed once the script re-enables one through the UI: a re-enable that
   * silently did not land would otherwise take the source out of the cleanup
   * set — exactly the case the cleanup exists for. A redundant `enabled: true`
   * PATCH costs one request and cannot be wrong.
   */
  const switchedOff = new Set<string>();

  try {
    // Setup — the Sources surface, and a target chosen from real data.
    await boot(page, pathUrl("/events/sources"), {
      marker: 'button[aria-label="Create"]',
      timeoutMs: BOOT_TIMEOUT_MS,
      settleMs: 1200,
    });
    await snap(page, OUT, "1-sources");

    // The target is chosen from real data, never named here. Preference order:
    // an enabled source that HAS events (only that one can prove step 2), then
    // any enabled source (step 1 still stands on its own).
    //
    // Its name must be unique on the page, since the row is located by that
    // label — an ambiguous name would silently act on the wrong row.
    const sources = await listSources();
    const enabled = sources.filter((s) => s.enabled);
    r.note(`${sources.length} source(s), ${enabled.length} enabled`);

    const named = async (s: SourceRow): Promise<boolean> =>
      (await page.getByText(s.name, { exact: true }).count()) === 1;

    let target: SourceRow | undefined;
    let ownEvents = 0;
    for (const source of enabled) {
      if (!(await named(source))) continue;
      const count = await countEvents(source.id);
      if (target === undefined) target = source;
      if (count > 0) {
        target = source;
        ownEvents = count;
        break;
      }
    }

    if (target === undefined) {
      r.note(
        "no uniquely-named enabled source in this worktree — nothing to toggle",
      );
    } else {
      r.note(`target "${target.name}" (${target.id}) — ${ownEvents} event(s)`);

      // The whole-list count BEFORE anything is touched. Every later comparison
      // is against this number, so it is read once and never re-derived.
      const baseline = await countEvents(null);
      r.note(`events list holds ${baseline} event(s) with the source enabled`);

      // CLAIM 1 — disable it FROM THE ROW, and prove the click did not navigate.
      const urlBefore = page.url();
      const disable = await rowAction(target.name, "Disable source");
      r.ok(`the row offers "Disable source"`, disable !== null);
      if (disable !== null) {
        // The control now states its own position. This is the assertion the
        // old icon button could not carry: a glyph has no `aria-checked`, so
        // whether the source was on could only be inferred from the name of the
        // action being offered — a label, read backwards.
        r.eq(
          "the enabled row's switch reads on",
          await disable.getAttribute("aria-checked"),
          "true",
        );
        await disable.click();
        switchedOff.add(target.id);
        await page.waitForTimeout(1500);
        await snap(page, OUT, "2-disabled");

        // The action button is a SIBLING of the row's own button and stops the
        // click; if it did not, this toggle would also have opened the pane.
        r.ok(
          "the toggle acts on the row without navigating to it",
          !/\/sources\/source\//.test(page.url()),
          `was ${urlBefore}, now ${page.url()}`,
        );
      }

      // CLAIM 2 — what "disabled" MEANS for the events list: a default, not a delete.
      if (disable !== null && ownEvents > 0) {
        // The list is refetched off a server tick, so poll to a deadline rather
        // than settling for a fixed sleep and reporting a stale number.
        const deadline = Date.now() + 10_000;
        let scoped = await countEvents(null);
        while (Date.now() < deadline && scoped === baseline) {
          await page.waitForTimeout(500);
          scoped = await countEvents(null);
        }
        r.eq(
          "the events list drops exactly the disabled source's events",
          scoped,
          baseline - ownEvents,
        );
        // The load-bearing half. `sourceId` is a real filterable dimension, so
        // a view that names it is explicitly asking about sources and must get
        // what it asked for — a disabled source's history included. A fixed
        // predicate instead of a default would make this number 0.
        r.eq(
          "a filter that names `sourceId` still returns every one of them",
          await countEvents(target.id),
          ownEvents,
        );
      } else if (disable !== null) {
        r.note(
          "target source has no events — the scope arms cannot be proven here",
        );
      }

      // CLAIM 2 (the reversible half) — re-enable from the row, and prove
      //           nothing was destroyed.
      //
      //    Re-located rather than remembered: the row is found again by the
      //    same label, and the button it now carries is the assertion. The undo
      //    is the very same affordance, relabelled — which is why this action
      //    carries no confirmation dialog in the first place.
      if (disable !== null) {
        const enable = await rowAction(target.name, "Enable source");
        r.ok(
          'the disabled row offers "Enable source" — the same switch, relabelled',
          enable !== null,
        );
        if (enable !== null) {
          r.eq(
            "the disabled row's switch reads off",
            await enable.getAttribute("aria-checked"),
            "false",
          );
          await enable.click();
          await page.waitForTimeout(2000);
          await snap(page, OUT, "3-re-enabled");
          // …and all the way back: the switch is re-located by the name it now
          // carries, so this reads the element the row is actually rendering
          // rather than a stale handle to the one that was there before.
          const backOn = await rowAction(target.name, "Disable source");
          r.eq(
            "and re-enabling puts the switch back on",
            backOn === null ? null : await backOn.getAttribute("aria-checked"),
            "true",
          );
          const deadline = Date.now() + 10_000;
          let restored = await countEvents(null);
          while (Date.now() < deadline && restored !== baseline) {
            await page.waitForTimeout(500);
            restored = await countEvents(null);
          }
          r.eq(
            "re-enabling brings every event straight back — nothing was deleted",
            restored,
            baseline,
          );
        }
      }

      // CLAIM 3 — the open events list learns about the toggle from the SERVER.
      if (ownEvents > 0) {
        await boot(page, pathUrl("/events/list"), {
          // The landing view's own switcher chip — it exists only once the
          // authored view instances have resolved.
          marker: 'button:has-text("Upcoming")',
          timeoutMs: BOOT_TIMEOUT_MS,
          settleMs: 1200,
        });

        // A title of the target source that is ACTUALLY on screen. The landing
        // view is `Upcoming` (an authored `startsAt` rule), so most of a
        // source's events are not rendered — asking the API for one and
        // assuming it is visible would fail on data, not on behaviour.
        const candidates = await eventsOf(target.id);
        let probe: string | undefined;
        for (const event of candidates) {
          if (
            (await page.getByText(event.title, { exact: true }).count()) > 0
          ) {
            probe = event.title;
            break;
          }
        }

        if (probe === undefined) {
          r.note(
            "none of the target source's events is on the Upcoming view — live arm skipped",
          );
        } else {
          r.note(`probe event "${probe}"`);
          // A stamp on this document. If the list re-renders, it survives; if
          // the tab navigated or reloaded, it is gone — which is the difference
          // between "the server pushed" and "the page started over".
          await page.evaluate(() => {
            Object.assign(window, { __e2eSourceActions: true });
          });
          await snap(page, OUT, "4-list-before");

          // Deliberately NOT through this tab's UI. The tab has no idea the
          // toggle moved, so anything that happens on screen came off the
          // server's routed change feed (the lookup's reverse route).
          r.ok(
            "out-of-band disable accepted",
            await setEnabled(target.id, false),
          );
          switchedOff.add(target.id);

          const goneBy = Date.now() + 15_000;
          while (
            Date.now() < goneBy &&
            (await page.getByText(probe, { exact: true }).count()) > 0
          ) {
            await page.waitForTimeout(500);
          }
          await snap(page, OUT, "5-list-after-disable");
          r.ok(
            "the open list drops the event with no interaction of its own",
            (await page.getByText(probe, { exact: true }).count()) === 0,
          );
          r.ok(
            "…and it did so without reloading the page",
            await page.evaluate(
              () => Reflect.get(window, "__e2eSourceActions") === true,
            ),
          );

          r.ok(
            "out-of-band enable accepted",
            await setEnabled(target.id, true),
          );
          const backBy = Date.now() + 15_000;
          while (
            Date.now() < backBy &&
            (await page.getByText(probe, { exact: true }).count()) === 0
          ) {
            await page.waitForTimeout(500);
          }
          await snap(page, OUT, "6-list-after-enable");
          r.ok(
            "re-enabling brings the event back into the open list",
            (await page.getByText(probe, { exact: true }).count()) > 0,
          );
        }
      }
    }

    // CLAIM 4 — Refresh all. Last, because it is the only step that spends
    //           anything: it enqueues one probe per enabled source, and an
    //           extraction (a live model call for a `url` source) wherever the
    //           page moved. So the assertion is on the TALLY the enqueue
    //           returns, never on a run outcome — the runs land long after
    //           this script exits.
    await boot(page, pathUrl("/events/sources"), {
      marker: 'button[aria-label="Create"]',
      timeoutMs: BOOT_TIMEOUT_MS,
      settleMs: 1200,
    });
    const refreshAll = page.getByRole("button", {
      name: "Refresh all sources",
      exact: true,
    });
    const haveRefreshAll = (await refreshAll.count()) > 0;
    r.ok("the pane's toolbar carries `Refresh all sources`", haveRefreshAll);

    if (haveRefreshAll) {
      await refreshAll.first().click();
      await page.waitForTimeout(3000);
      await snap(page, OUT, "7-refresh-all");
      // EVERY arm `describeRefreshAll` can produce, deliberately: "Nothing to
      // refresh" (all sources disabled) and "Nothing started" (every candidate
      // disabled between the listing and its enqueue) are honest answers, not
      // failures, and a deploy in either state must still pass. What would be a
      // failure is no toast at all — a resolved promise reported as silence.
      const toast =
        /Refreshing \d+ sources?|Nothing to refresh|Already refreshing|Nothing started/;
      r.ok(
        "the enqueue tally is reported as a toast, arm by arm",
        (await page.getByText(toast).count()) > 0,
        (await page.locator("body").innerText()).slice(0, 300),
      );
    }
  } finally {
    // Whatever we switched off goes back on, even if an assertion above threw —
    // a killed run must not leave a source quietly disabled and its events
    // missing from the list.
    for (const id of switchedOff) {
      r.ok(`cleanup left source ${id} enabled`, await setEnabled(id, true));
    }
  }

  // A clean run means no crashes either. `requestfailed` is NOT folded in: a
  // navigation that aborts an in-flight fetch is normal, not a defect.
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
