/**
 * Verifies the v2 mailbox model end-to-end against the deployed app:
 *
 *  1. bare `/mail` lands on the ONE threads surface (`/mail/threads`) — no
 *     `/mail/v/*` route survives;
 *  2. the eight mailboxes render as a TAB STRIP, and switching tab re-scopes the
 *     list (each tab's own `filter` is its live window's `where`);
 *  3. each tab renders a genuinely DIFFERENT ROW SET (read off the rows'
 *     `data-thread-id`). This is the assertion that catches the dangling-rule
 *     failure mode: a typo'd fieldId/operatorId lowers to nothing on the
 *     client, and the only visible symptom is every tab showing the same rows;
 *  4. the mailbox scope is an ORDINARY, EDITABLE filter rule — not the locked
 *     chip v1 shipped — and removing it PERSISTS across a reload, landing in the
 *     USER-LAYER config file. That round trip is the whole point of making
 *     mailboxes view instances instead of route params, so it is the assertion
 *     that catches a regression back to v1.
 *
 * Step 3 is destructive by nature (it edits the Inbox tab), so the script
 * finishes by deleting the user-layer override it just created and asserting the
 * authored scope comes back — which doubles as proof that the edit really was a
 * config write, not device-local state.
 *
 * A worktree carries no mail corpus (`mail_threads` is left out of the fork),
 * so against a worktree whose account holds no thread the script seeds its own
 * (`fixture.ts`: 25 Inbox, 2 Sent, 1 Draft) and deletes them at the end; on
 * main it reads the real mailbox and seeds nothing.
 *
 * Manual only — nothing runs this automatically.
 *   ./singularity run plugins/apps/plugins/mail/plugins/threads/e2e/mailbox-tabs-verify.ts [--headed]
 */
import { existsSync, rmSync } from "node:fs";
import type { Page } from "playwright";
import { configDir } from "@plugins/config_v2/data-dirs";
import {
  arg,
  boot,
  pathUrl,
  report,
  onBeforeFinish,
  snap,
  targetNamespace,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openThreadFixture } from "./fixture";

const MAILBOXES = [
  "Inbox",
  "Starred",
  "Important",
  "Sent",
  "Drafts",
  "All Mail",
  "Spam",
  "Trash",
];

const OUT = arg("out") ?? "/tmp/mailbox-tabs";

/** The tab strip is the surface's proof-of-render — never settle on a timer. */
const TABS_READY = 'button[data-tooltip="Trash"]';

/**
 * Generous boot budget: this drives a real deploy on a shared dev box where
 * several worktrees may be building at once (measured load average >30), and the
 * SPA's first paint is the first casualty. Playwright's 30s default turns host
 * contention into a spurious failure of whatever the script was actually testing.
 */
const BOOT_TIMEOUT_MS = 120_000;

/**
 * The user-layer override the UI writes when a view's filter is edited.
 *
 * The namespace comes from `targetNamespace()` — the same resolution that
 * produced the URL this script drives — so the file the two `rmSync` calls below
 * delete belongs to the deploy under test, by construction.
 *
 * It used to read `process.env.SINGULARITY_WORKTREE ?? basename(REPO_ROOT)`,
 * with the correct rule stated in the prose immediately above the code that
 * broke it. An agent pane inherited `SINGULARITY_WORKTREE` from the backend that
 * spawned it, so from inside any worktree it answers `singularity`: this script
 * deleted the user's live Mail config on MAIN, every run, while asserting
 * against a worktree deploy. Nothing about the file made that visible, which is
 * why the harness now owns the answer and `e2e-harness:target-not-env-derived`
 * refuses the env read outright.
 */
const STORE_PATH = "apps/mail/threads/mail-threads.jsonc";

const USER_OVERRIDE = configDir.file(targetNamespace(), STORE_PATH);

/**
 * Wait until the SERVER resolves the edit, not merely until the file exists.
 *
 * Two async hops sit between a filter edit and a reload showing it: the client's
 * debounced config write, then the server's config file-watcher noticing the new
 * file and re-reading it. Asserting on a fixed timer — or even on the override
 * file appearing, which only proves hop one — races the second and reports a
 * false "did not persist". The config document's own HTTP read is the real
 * barrier, so poll THAT.
 *
 * The budget is generous on purpose: the second hop is a `@parcel/watcher`
 * event, and on a loaded host it is not prompt. Measured at **103s** on this
 * machine at load average ~35 (several worktrees building at once); it is
 * near-instant on an idle one, and noticing a file APPEAR is consistently slower
 * than noticing one change or vanish. A tight timeout here would make the script
 * flaky for a reason that has nothing to do with what it is testing.
 */
async function awaitServerResolves(
  page: Page,
  predicate: (inboxView: Record<string, unknown>) => boolean,
  timeoutMs = 300_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The live value's HTTP read of the base document — what a tab's
    // `useConfig` resolves to (`config-v2.values`, `{ path }`).
    const res = await page.request.get(
      pathUrl(
        `/api/resources/config-v2.values?path=${encodeURIComponent(STORE_PATH)}`,
      ),
    );
    if (res.ok()) {
      const body = (await res.json()) as {
        value: { views?: { id: string; view: Record<string, unknown> }[] };
      };
      const views = body.value.views ?? [];
      const inbox = views.find((v) => v.id === "inbox");
      if (inbox && predicate(inbox.view)) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

// The Filter pill's accessible name IS its summary: "Filter" with no active
// rule, "Filter: <first rule in words>" (+ ", +N more") otherwise — the control
// trigger's naming (data-view `control-trigger.tsx`). One attribute read
// answers "which scope is applied?" without reaching into the popover.
const PILL = 'button[aria-label^="Filter"]';

/**
 * The pill's name while exactly one `labels contains <label>` rule is active.
 * The summary names the operand by its stored Gmail label id (`INBOX`); the
 * friendly name is asserted inside the open popover below.
 */
const scopeLabel = (labelId: string): string =>
  `Filter: Labels contains ${labelId}`;

/**
 * One mailbox tab. `button[data-tooltip=…]` rather than `getByRole` because the
 * switcher's chips are drag-reorderable: dnd-kit wraps each in its own
 * `role="button"` sortable shell, so a role query resolves two elements per tab.
 */
function tab(page: Page, name: string) {
  return page.locator(`button[data-tooltip="${name}"]`);
}

async function pillLabel(page: Page): Promise<string> {
  return (await page.locator(PILL).first().getAttribute("aria-label")) ?? "";
}

async function openFilter(page: Page): Promise<void> {
  await page.locator(PILL).first().click();
  await page.waitForTimeout(400);
}

/** The thread ids the list renders right now, top to bottom. */
async function renderedIds(page: Page): Promise<string[]> {
  const rows = await page.locator("[data-thread-id]").evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-thread-id") ?? "",
      top: el.getBoundingClientRect().top,
    })),
  );
  return rows.sort((x, y) => x.top - y.top).map((row) => row.id);
}

/** The threads list's empty state (`mailThreadsPane`'s DataView `emptyState`). */
const EMPTY_STATE = "No conversations";

/**
 * What the list shows right now. Zero rendered rows alone is NOT "empty": a
 * list still loading, or one whose read failed, renders none either — so empty
 * is the settled empty state's text, and a failed read is its own arm.
 */
type ListState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "rows"; ids: string[] }
  | { kind: "error"; text: string };

async function listState(page: Page): Promise<ListState> {
  const error = page.getByText(/^Couldn't load:/);
  if ((await error.count()) > 0) {
    return { kind: "error", text: (await error.first().textContent()) ?? "" };
  }
  if ((await page.getByText(EMPTY_STATE, { exact: true }).count()) > 0) {
    return { kind: "empty" };
  }
  const ids = await renderedIds(page);
  return ids.length > 0 ? { kind: "rows", ids } : { kind: "loading" };
}

// Seed a mailbox when the target has none (a worktree): main's is real.
const fixture =
  String(targetNamespace()) === "singularity"
    ? null
    : await openThreadFixture();
if (fixture !== null) onBeforeFinish(() => fixture.cleanup());

// `finish()` exits through the teardown hook; a throw exits through `finally`.
try {
  await withBrowser(async (h) => {
    const r = report("mail — mailboxes as DataView tabs");

    // The seeded corpus, when this run seeded one: then every tab's EXACT row
    // set is known, and the viewport is tall enough to render all of it (no
    // row windowed out), so the tab checks compare sets, not rendered counts.
    let seeded: { inbox: string[]; sent: string[]; drafts: string[] } | null =
      null;
    if (fixture !== null && fixture.existing === 0) {
      const inbox: string[] = [];
      for (let i = 0; i < 25; i++) {
        const t = await fixture.seed({
          name: `inbox-${i}`,
          labels: ["INBOX"],
          minutesAgo: i,
        });
        inbox.push(t.id);
      }
      const sent = [
        (
          await fixture.seed({
            name: "sent-0",
            labels: ["SENT"],
            minutesAgo: 1,
          })
        ).id,
        (
          await fixture.seed({
            name: "sent-1",
            labels: ["SENT"],
            minutesAgo: 2,
          })
        ).id,
      ];
      const drafts = [
        (
          await fixture.seed({
            name: "draft-0",
            labels: ["DRAFT"],
            minutesAgo: 3,
          })
        ).id,
      ];
      seeded = { inbox, sent, drafts };
      r.note("seeded a synthetic mailbox: 25 Inbox, 2 Sent, 1 Draft");
    }
    const { page } = await h.session(
      seeded !== null ? { viewport: { width: 1400, height: 2600 } } : {},
    );

    /**
     * The rows a tab renders once its list has SETTLED — rows or the empty
     * state, the same on two reads in a row. A list that never settles, or
     * whose read failed, throws: zero rows from a list that did not load must
     * never pass for an empty mailbox.
     */
    const rowsOfTab = async (name: string): Promise<string[]> => {
      await tab(page, name).click();
      let previous = "";
      const settled = await waitFor(
        async () => {
          const state = await listState(page);
          const key = JSON.stringify(state);
          const stable = key === previous;
          previous = key;
          return { state, stable };
        },
        ({ state, stable }) =>
          stable && (state.kind === "rows" || state.kind === "empty"),
        { timeoutMs: 60_000, intervalMs: 400 },
      );
      const { state } = settled.value;
      if (state.kind === "rows") return state.ids;
      if (state.kind === "empty") return [];
      throw new Error(
        `the "${name}" tab never settled: ${JSON.stringify(state)} after ${settled.waitedMs} ms`,
      );
    };

    // ---- 0. precondition: start from the AUTHORED state --------------------
    // This script edits config, and the server's config watcher is slow to notice
    // (~100s on a loaded host). Back-to-back runs would otherwise start mid-catch-up
    // from the previous run's cleanup and fail for that reason alone. So clear any
    // leftover override and wait for the server to be serving the authored origin
    // BEFORE asserting anything.
    if (existsSync(USER_OVERRIDE)) rmSync(USER_OVERRIDE);
    r.ok(
      "precondition: the server is serving the authored config",
      await awaitServerResolves(page, (view) => "filter" in view),
      "a previous run's override may still be resolving",
    );

    // ---- 1. one URL -------------------------------------------------------
    // The landing redirects only once the Gmail integration reports access ready
    // (`MailRoot`); where it does not (a deploy whose Gmail token is unavailable)
    // that is recorded, and the rest runs against `/mail/threads` directly.
    await page.goto(pathUrl("/mail"), {
      waitUntil: "domcontentloaded",
      timeout: BOOT_TIMEOUT_MS,
    });
    const landed = await waitFor(
      async () => new URL(page.url()).pathname,
      (path) => path === "/mail/threads",
      { timeoutMs: 60_000 },
    );
    r.eq("bare /mail lands on /mail/threads", landed.value, "/mail/threads");
    await boot(page, pathUrl("/mail/threads"), {
      marker: TABS_READY,
      timeoutMs: BOOT_TIMEOUT_MS,
      settleMs: 1500,
    });

    // ---- 2. eight mailbox tabs -------------------------------------------
    for (const name of MAILBOXES) {
      r.ok(`tab "${name}" is present`, (await tab(page, name).count()) > 0);
    }
    await snap(page, OUT, "tabs");

    // ---- 3. switching tab re-scopes ---------------------------------------
    for (const [name, labelId] of [
      ["Sent", "SENT"],
      ["Spam", "SPAM"],
    ] as const) {
      await tab(page, name).click();
      await page.waitForTimeout(1500);
      r.eq(
        `"${name}" carries exactly its one scope rule`,
        await pillLabel(page),
        scopeLabel(labelId),
      );
    }

    // ---- 3b. the tabs render DIFFERENT ROWS --------------------------------
    // The fail-soft trap: a dropped rule yields the unscoped account-wide set, so
    // every tab would show the SAME rows. Only real rows can rule that out.
    const rowsByTab: Record<string, string[]> = {};
    for (const name of ["Inbox", "Sent", "Drafts", "All Mail", "Spam"]) {
      rowsByTab[name] = await rowsOfTab(name);
      r.note(`${name}: ${rowsByTab[name].length} rows rendered`);
    }
    const inboxRows = rowsByTab["Inbox"] ?? [];
    const sentRows = rowsByTab["Sent"] ?? [];
    const draftRows = rowsByTab["Drafts"] ?? [];
    const spamRows = rowsByTab["Spam"] ?? [];
    const allRows = rowsByTab["All Mail"] ?? [];

    const sorted = (ids: readonly string[]) => [...ids].sort();
    if (seeded !== null) {
      // The corpus is known and fully rendered: every tab's exact set.
      r.eq(
        "Inbox renders exactly the seeded Inbox threads",
        sorted(inboxRows),
        sorted(seeded.inbox),
      );
      r.eq(
        "Sent renders exactly the seeded Sent threads",
        sorted(sentRows),
        sorted(seeded.sent),
      );
      r.eq(
        "Drafts renders exactly the seeded draft",
        sorted(draftRows),
        sorted(seeded.drafts),
      );
      r.eq(
        "All Mail renders every seeded thread (a superset of Inbox)",
        sorted(allRows),
        sorted([...seeded.inbox, ...seeded.sent, ...seeded.drafts]),
      );
    } else {
      // A real mailbox: its size is unknown and rows past the viewport are
      // windowed out (VirtualRows), so only what renders can be compared.
      r.ok(
        "Inbox renders rows",
        inboxRows.length > 0,
        `${inboxRows.length} rows`,
      );
      r.ok(
        "Sent renders its own set, not the inbox rows",
        sentRows.length > 0 &&
          JSON.stringify(sentRows) !== JSON.stringify(inboxRows),
        `sent=${sentRows.length} inbox=${inboxRows.length}`,
      );
      r.ok(
        "Drafts returns its own set, distinct from Sent",
        JSON.stringify(draftRows) !== JSON.stringify(sentRows),
        `drafts=${JSON.stringify(draftRows)} sent=${JSON.stringify(sentRows)}`,
      );
      r.ok(
        "All Mail differs from Sent",
        JSON.stringify(allRows) !== JSON.stringify(sentRows),
      );
    }
    // `rowsOfTab` returns [] only for the settled empty state — never for a
    // list that did not load — so this is the rule applying, not a blank list.
    r.eq(
      "Spam shows its empty state — proof the rule applied, since a dropped " +
        "rule would return the whole account",
      spamRows,
      [],
    );
    r.ok(
      "no two of Inbox / Sent / Drafts returned an identical page",
      new Set([inboxRows, sentRows, draftRows].map((x) => JSON.stringify(x)))
        .size === 3,
    );

    // ---- 4. the scope is an ordinary, EDITABLE rule ------------------------
    await tab(page, "Inbox").click();
    await page.waitForTimeout(1200);
    r.eq(
      "Inbox's Filter pill names its scope rule",
      await pillLabel(page),
      scopeLabel("INBOX"),
    );

    await openFilter(page);
    r.ok(
      "the scope renders as an editable rule row",
      (await page.getByText("Where", { exact: true }).count()) > 0,
    );
    // v1 rendered the scope as a LOCKED chip with no affordances at all. The
    // presence of the rule row's own field/operator pickers and its Remove button
    // is exactly the difference v2 is about.
    const where = page.getByText("Where", { exact: true });
    const remove = page.locator('button[aria-label="Remove filter"]').first();
    const popover = where.locator("xpath=ancestor::*[self::div][3]");
    r.ok(
      "the rule reads as `Labels contains Inbox` in friendly names, not raw ids",
      (await popover.getByText("Labels", { exact: true }).count()) > 0 &&
        (await popover.getByText("Contains", { exact: true }).count()) > 0 &&
        (await popover.getByText("Inbox", { exact: true }).count()) > 0,
    );
    r.ok(
      "the rule has a Remove control (it is NOT locked)",
      (await remove.count()) > 0,
    );
    await snap(page, OUT, "filter-open");

    // ---- 5. an edit persists across reload, into the user config -----------
    // The trailing actions are hover-revealed (opacity + pointer-events coupled),
    // so hover the row before reaching for Remove.
    await where.hover();
    await page.waitForTimeout(300);
    await remove.click();
    await page.waitForTimeout(1000);
    r.eq(
      "removing the scope empties the pill",
      await pillLabel(page),
      "Filter",
    );

    // The write-back is debounced AND the server re-reads on a file-watcher event,
    // so reload only once the SERVER resolves the edit — otherwise this races two
    // async hops and reports a false negative.
    r.ok(
      "the server resolves the edit (config write-back reached the backend)",
      await awaitServerResolves(page, (view) => !("filter" in view)),
    );
    r.ok(
      "the edit landed in the user-layer config file, not device-local state",
      existsSync(USER_OVERRIDE),
      USER_OVERRIDE,
    );

    await boot(page, pathUrl("/mail/threads"), {
      marker: TABS_READY,
      timeoutMs: BOOT_TIMEOUT_MS,
      settleMs: 2500,
    });
    r.eq(
      "…and the removal SURVIVES a reload (config write-back)",
      await pillLabel(page),
      "Filter",
    );
    await snap(page, OUT, "after-reload");

    // ---- 6. restore ------------------------------------------------------
    // Dropping the override falls the surface back to the authored origin — which
    // is both the cleanup AND the proof that the authored scope is what the file
    // was overriding. A DELETE needs the same server barrier as the write did;
    // the watcher is no faster at noticing a file vanish than at noticing it
    // appear (measured ~95s vs ~103s on a loaded host).
    if (existsSync(USER_OVERRIDE)) rmSync(USER_OVERRIDE);
    r.ok(
      "the server falls back to the authored origin",
      await awaitServerResolves(page, (view) => "filter" in view),
    );
    await boot(page, pathUrl("/mail/threads"), {
      marker: TABS_READY,
      timeoutMs: BOOT_TIMEOUT_MS,
      settleMs: 1500,
    });
    r.eq(
      "dropping the override restores the authored scope",
      await pillLabel(page),
      scopeLabel("INBOX"),
    );

    await r.finish();
  });
} finally {
  await fixture?.cleanup();
}
