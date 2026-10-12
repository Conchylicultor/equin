/**
 * The `events.sources.all` live collection, end to end on a deployed build:
 *
 *   1. the source detail pane resolves a real source by id through the `:rows`
 *      point read — found, its name on screen;
 *   2. an unknown id lands on the explicit "no longer exists" state, never an
 *      endless spinner;
 *   3. the Source filter's options are every source sorted by name — the
 *      whole set `source-field` subscribes to (its one `{}` tuple, sorted by
 *      name in the browser) and, in the UI, the events list's Source filter
 *      value picker;
 *   4. a source's `enabled` flag is LIVE on both surfaces at once: with the
 *      sources list and that source's detail pane open side by side, flipping
 *      it from the detail pane's Scheduling control moves the list row's
 *      switch, and flipping it back from the row's switch moves the detail
 *      pane's control — both with no reload (a stamp on `window` survives).
 *
 * WRITES: step 4 toggles the target source's `enabled` twice through the UI,
 * and a `finally` PATCHes it back to the value it started with, so a run killed
 * mid-toggle cannot leave a source quietly switched. Everything else is a read.
 *
 * Usage:
 *   ./singularity run plugins/apps/plugins/events/plugins/sources/e2e/live-sources.ts [--headed]
 */

import {
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/claude-501/live-sources";
const r = report("Events · live sources collection");

interface SourceRow {
  id: string;
  name: string;
  enabled: boolean;
}

/** How long a pushed change may take to reach the open tab. */
const LIVE_TIMEOUT_MS = 10_000;

/** Code-point order — the cluster collates `C`, so this is what SQL returns. */
const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

await withBrowser(async (h) => {
  const { page, captured } = await h.session();

  const getJson = async <T>(path: string): Promise<T> => {
    const res = await page.request.get(pathUrl(path));
    if (!res.ok()) throw new Error(`GET ${path} — ${res.status()}`);
    return (await res.json()) as T;
  };
  /** A live resource's value over its HTTP read (`{ value, version }`). */
  const resource = async <T>(
    key: string,
    params: Record<string, string>,
  ): Promise<T> => {
    const qs = new URLSearchParams(params).toString();
    const body = await getJson<{ value: T }>(
      `/api/resources/${encodeURIComponent(key)}?${qs}`,
    );
    return body.value;
  };

  const sources = await getJson<SourceRow[]>("/api/events/sources");
  r.note(`${sources.length} source(s) in this worktree`);
  r.ok("the worktree has sources to look at", sources.length > 0);
  const target = sources[sources.length - 1]!;
  r.note(`target "${target.name}" (${target.id})`);

  // 1 — found, by id.
  const point = await resource<SourceRow[]>("events.sources.all:rows", {
    ids: target.id,
  });
  r.eq(
    "the :rows point read returns the target",
    point.map((s) => s.id),
    [target.id],
  );
  await boot(page, pathUrl(`/events/sources/source/${target.id}`), {
    marker: `[data-pane-id="event-source-detail"]`,
    settleMs: 1500,
  });
  await snap(page, OUT, "1-found");
  const detail = page.locator('[data-pane-id="event-source-detail"]');
  r.ok(
    "the detail pane shows the source's name",
    (await detail.getByText(target.name, { exact: true }).count()) > 0,
  );
  r.ok(
    "the detail pane is not the missing state",
    (await detail.getByText("This source no longer exists.").count()) === 0,
  );

  // 2 — an unknown id: determinately missing.
  const unknown = "evs-does-not-exist-e2e";
  const none = await resource<SourceRow[]>("events.sources.all:rows", {
    ids: unknown,
  });
  r.eq("the :rows point read returns nothing for an unknown id", none, []);
  await page.goto(pathUrl(`/events/sources/source/${unknown}`));
  // Either missing surface is the explicit dead end: the pane's own resolver
  // (`useResolveSource` → found: false) renders the router's not-found, and the
  // body renders its placeholder if it is ever reached with a missing id.
  const missing = page.getByText(
    /This source no longer exists\.|This resource couldn't be found\./,
  );
  await missing
    .first()
    .waitFor({ timeout: 10_000 })
    .catch((err: unknown) => {
      if (err instanceof Error && err.name === "TimeoutError") return;
      throw err;
    });
  await snap(page, OUT, "2-missing");
  r.ok(
    "an unknown id shows the explicit missing state",
    (await missing.count()) > 0,
  );

  // 3 — the Source filter's options: every source, sorted by name.
  const expected = sources.map((s) => s.name).sort(byCodePoint);
  const whole = await resource<SourceRow[]>("events.sources.all", {});
  r.eq(
    "the whole set holds every source",
    whole.map((s) => s.name).sort(byCodePoint),
    expected,
  );

  await boot(page, pathUrl("/events/list"), { settleMs: 2000 });
  const filterTrigger = page.getByRole("button", { name: /^Filter/ });
  if ((await filterTrigger.count()) > 0) {
    await filterTrigger.first().click();
    await page.waitForTimeout(700);
  }
  const addFilter = page.getByRole("button", {
    name: "Add filter",
    exact: true,
  });
  if ((await addFilter.count()) > 0) {
    await addFilter.first().click();
    await page.waitForTimeout(600);
  }
  const fieldSearch = page.getByPlaceholder("Filter by…");
  if ((await fieldSearch.count()) > 0) await fieldSearch.first().fill("Source");
  await page.waitForTimeout(400);
  await page.getByText("Source", { exact: true }).last().click();
  await page.waitForTimeout(700);
  // The new Source rule's value picker.
  await page
    .getByRole("button", { name: /^Select/ })
    .last()
    .click();
  await page.waitForTimeout(900);
  await snap(page, OUT, "3-source-filter");
  // The value picker lists the options in field order. From its last-rendered
  // option (the picker is the newest popover), climb to the smallest ancestor holding every source name, then read its
  // leaf texts in DOM order (deduped: a chip and its label can both carry one).
  const names = new Set(expected);
  const leafTexts: string[] = await page
    .getByText(expected[expected.length - 1]!, { exact: true })
    .last()
    .evaluate((input, want: string[]) => {
      let box: Element | null = input;
      while (box && !want.every((n) => (box!.textContent ?? "").includes(n))) {
        box = box.parentElement;
      }
      if (!box) return [];
      return [...box.querySelectorAll("*")]
        .filter((e) => e.children.length === 0)
        .map((e) => (e.textContent ?? "").trim());
    }, expected);
  const shown = [...new Set(leafTexts.filter((t) => names.has(t)))];
  r.note(`picker shows ${shown.length} source option(s)`);
  r.eq("the Source filter's options are sorted by name", shown, expected);

  // 4 — `enabled` is live on the list AND the detail pane, both directions.
  const original = target.enabled;
  let touched = false;
  try {
    await boot(page, pathUrl(`/events/sources/source/${target.id}`), {
      marker: `[data-pane-id="event-source-detail"]`,
      settleMs: 1500,
    });
    const list = page.locator('[data-pane-id="event-sources"]');
    const detailPane = page.locator('[data-pane-id="event-source-detail"]');
    // A stamp on this document: a re-render keeps it, a reload drops it.
    await page.evaluate(() => {
      Object.assign(window, { __e2eLiveSources: true });
    });

    /**
     * The list row's own switch. Every row's switch is in the DOM (the reveal
     * is a hover), so a page-wide lookup would find some other row's: pick the
     * one whose vertical centre sits in the target label's band. Its
     * accessible name is the action it offers, so match either.
     */
    const rowSwitch = async () => {
      const label = list.getByText(target.name, { exact: true });
      if ((await label.count()) !== 1) return null;
      await label.scrollIntoViewIfNeeded();
      await label.hover();
      const box = await label.boundingBox();
      if (box === null) return null;
      const centre = box.y + box.height / 2;
      for (const sw of await list
        .getByRole("switch", { name: /^(Disable|Enable) source$/ })
        .all()) {
        const b = await sw.boundingBox();
        if (b !== null && Math.abs(b.y + b.height / 2 - centre) <= 26) {
          return sw;
        }
      }
      return null;
    };
    /** The row switch's `aria-checked`, read fresh each time. */
    const rowState = async (): Promise<string | null> => {
      const sw = await rowSwitch();
      return sw === null ? null : await sw.getAttribute("aria-checked");
    };
    /** The detail pane's Scheduling radio for one position. */
    const detailRadio = (on: boolean) =>
      detailPane.getByRole("radio", {
        name: on ? "Enabled" : "Disabled",
        exact: true,
      });
    const detailState = async (on: boolean): Promise<string | null> =>
      await detailRadio(on).getAttribute("aria-checked");
    /** Poll a read to a deadline — the push lands asynchronously. */
    const settle = async (
      read: () => Promise<string | null>,
      want: string,
    ): Promise<string | null> => {
      const deadline = Date.now() + LIVE_TIMEOUT_MS;
      let got = await read();
      while (got !== want && Date.now() < deadline) {
        await page.waitForTimeout(250);
        got = await read();
      }
      return got;
    };

    const on = String(original);
    const flipped = String(!original);
    r.eq("the list row's switch reads the stored value", await rowState(), on);
    r.eq(
      "the detail pane's Scheduling control reads the stored value",
      await detailState(original),
      "true",
    );

    // Detail → list.
    touched = true;
    await detailRadio(!original).click();
    await snap(page, OUT, "4-toggled-from-detail");
    r.eq(
      "toggling from the detail pane moves the list row's switch",
      await settle(rowState, flipped),
      flipped,
    );
    r.eq(
      "…and the detail pane's own control",
      await settle(() => detailState(!original), "true"),
      "true",
    );

    // List → detail.
    const sw = await rowSwitch();
    r.ok("the target row's switch is found", sw !== null);
    if (sw !== null) {
      await page.waitForTimeout(600); // the hover reveal is a CSS transition
      await sw.click();
      await snap(page, OUT, "5-toggled-from-list");
      r.eq(
        "toggling from the list row moves the detail pane's control",
        await settle(() => detailState(original), "true"),
        "true",
      );
      r.eq("…and the row's own switch", await settle(rowState, on), on);
    }
    r.ok(
      "both surfaces updated without reloading the page",
      await page.evaluate(
        () => Reflect.get(window, "__e2eLiveSources") === true,
      ),
    );
  } finally {
    // Whatever the UI did (or failed to do), the source ends where it started.
    if (touched) {
      const res = await page.request.patch(
        pathUrl(`/api/events/sources/${target.id}`),
        { data: { enabled: original } },
      );
      r.ok(
        `cleanup restored enabled=${original} on ${target.id}`,
        res.ok(),
        `HTTP ${res.status()}`,
      );
    }
  }

  r.ok(
    "no uncaught page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
});

await r.finish();
