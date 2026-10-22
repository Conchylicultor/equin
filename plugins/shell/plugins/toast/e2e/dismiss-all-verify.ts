// Verifies the toast stack's "Dismiss all" affordance end-to-end: seeds a
// pile-up of real toasts, asserts the button appears (and only once the stack
// is plural), asserts the number it prints IS the stack, asserts it never
// overlaps the front toast, and asserts one click clears the whole stack.
//
// It also asserts the property underneath all of that: that every toast the app
// fires actually reaches the DOM. A burst is watched by a MutationObserver and
// posted-vs-inserted is compared, because a toast lost on the way to the screen
// is invisible to every other check here — the count and the stack agree, both
// short.
//
// The toasts are real ones: the script POSTs notifications through the app's own
// `POST /api/notifications` endpoint from the page context, and the bell plugin
// turns each arrival into a toast. Nothing is stubbed. Each seeded notification
// is dismissed by id at the end, so the run leaves the worktree as it found it.
//
// Usage:
//   ./singularity run plugins/shell/plugins/toast/e2e/dismiss-all-verify.ts [--headed] [--url http://<worktree>.localhost:9000]

import {
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

// A cast where the probe is read and written, not a `Window` augmentation — a
// global declaration would make every edit to this script re-check the whole
// repo.
type ToastProbeWindow = Window & {
  /**
   * Titles of every distinct toast this run has watched enter the DOM.
   * Installed by `startToastProbe()` for the burst check, absent otherwise.
   */
  __toastProbe?: { seen: Set<string>; stop: () => void };
};

const OUT = "/tmp/toast-dismiss-all";
const SEEDED = 3;
/**
 * Big enough that the arrivals land in one live-state push and one `useEffect`
 * pass (the window the drop lives in — see the burst section), and big enough
 * that a single miscount reads as an off-by-one rather than as noise.
 */
const BURST = 20;

const r = report("toast — dismiss all");

await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  await boot(page, pathUrl("/agents"), { marker: "[data-app-tab]" });

  // Two readings of "the stack", and which one each assertion takes is
  // load-bearing.
  //
  // ALL is the mount set. Sonner keeps a dismissed toast in the DOM for its
  // ~200ms exit animation and the affordance counts those, deliberately: the
  // count is "toasts currently painted", so the button fades out with the
  // stack rather than ahead of it (see the plugin's `internal/live-toasts`).
  // Every count and visibility invariant below therefore reads ALL — reading
  // LIVE instead would disagree with the button for exactly the length of that
  // animation, which is a 200ms flake window, not a finding.
  //
  // LIVE drops the exiting ones and is used for the geometry assertion only: a
  // toast mid-exit is mid-translate and mid-fade, so its bounding box measures
  // an animation frame instead of the layout being asserted.
  const ALL = "[data-sonner-toast]";
  const LIVE = '[data-sonner-toast]:not([data-removed="true"])';
  const toasts = page.locator(ALL);
  const settledToasts = page.locator(LIVE);
  const dismissAll = page.getByRole("button", { name: /Dismiss all/ });
  const seededIds: string[] = [];

  // Best effort: start from an empty stack. A live worktree files notifications
  // of its own (monitor reports, build completions) and each one toasts on
  // arrival, so a quiet screen is a preference here, not a precondition — the
  // assertions below are written to hold either way. Waiting them out rather
  // than bulk-dismissing is deliberate: `dismiss-all` empties the notification
  // list, which surfaces older stored rows the bell then toasts as fresh
  // arrivals — the cure would be worse than the disease.
  await emptyStack(15_000);

  // A single toast is already one click away from gone, so the affordance stays
  // out of the way until a *stack* forms. Asserted as the invariant it really is
  // — visible ⟺ plural — which holds whatever ambient traffic is on screen.
  await seed(1);
  await toasts.first().waitFor({ state: "visible", timeout: 10_000 });
  await assertCountIsTheStack("with one seeded toast");

  await seed(SEEDED);
  await page.waitForFunction(
    ({ sel, n }) => document.querySelectorAll(sel).length >= n,
    { sel: ALL, n: SEEDED },
    { timeout: 10_000 },
  );
  await dismissAll.waitFor({ state: "visible", timeout: 10_000 });
  await assertCountIsTheStack("with a seeded stack");
  r.note(`label: ${await dismissAll.innerText()}`);
  await snap(page, OUT, "before");

  // The strip is a reserved band, not an overlay: the toast stack's own bottom
  // offset grows by the strip's height, so the button can never paint over the
  // front toast. Assert the geometry rather than trusting the CSS.
  const buttonTop = (await dismissAll.boundingBox())?.y ?? -1;
  const bottoms = await settledToasts.evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().bottom),
  );
  // The emptiness guard is not paranoia: `Math.max()` of nothing is -Infinity,
  // which every button position clears — the assertion would pass by measuring
  // nothing at all.
  r.ok(
    "button clears the front toast",
    bottoms.length > 0 && buttonTop >= Math.max(...bottoms),
    bottoms.length === 0
      ? "nothing settled to measure against — every toast was mid-exit"
      : `button top ${buttonTop} < lowest toast bottom ${Math.max(...bottoms)}`,
  );

  // The click sweeps the stack, but the toasts leave through their exit
  // animation and the button leaves with them — so both waits below are for a
  // state ~220ms out, not for an instant one.
  await dismissAll.click();
  await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length === 0,
    ALL,
    { timeout: 5_000 },
  );
  r.eq("one click clears the whole stack", await toasts.count(), 0);
  await dismissAll.waitFor({ state: "hidden", timeout: 5_000 });
  r.ok("button retires with the stack", true);
  await snap(page, OUT, "after");

  // Park the pointer away from the corner. Clicking left it hovering where the
  // stack is about to reappear, and sonner pauses every toast's timer while its
  // list is hovered — which would stall the drain the last case depends on.
  await page.mouse.move(10, 10);

  // Sonner's `Observer.publish` is a plain synchronous fan-out — no buffer, no
  // replay — and the `<Toaster>`'s subscription is a `useEffect` keyed on its
  // own toast list, so it tears down and re-registers on every add. React runs
  // every passive destroy for a commit before any passive create, which leaves
  // a synchronous stretch with no subscriber at all; a `showToast` fired from
  // another component's effect in that same commit is simply discarded. The
  // bell is exactly such a producer, so a tight burst is the shape that hits
  // it.
  //
  // Nothing already asserted here can see that loss — the button's count and
  // the stack agree, both short. Only posted-versus-ever-inserted sees it, and
  // only from outside React: the original repro lost 3 toasts out of 465.
  await startToastProbe();
  const burst = await seed(BURST, { tight: true });
  await page
    .waitForFunction(
      (want) =>
        want.every((title) =>
          (window as ToastProbeWindow).__toastProbe?.seen.has(title),
        ),
      burst,
      { timeout: 20_000 },
    )
    .catch((err: unknown) => {
      // The timeout is not the verdict — the check below is, and it can name
      // which toasts went missing rather than just that the wait ran out.
      if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
    });
  const missing = await page.evaluate((want) => {
    const probe = (window as ToastProbeWindow).__toastProbe;
    if (probe === undefined) {
      throw new Error("toast probe is gone — did the page reload mid-burst?");
    }
    return want.filter((title) => !probe.seen.has(title));
  }, burst);
  await page.evaluate(() => (window as ToastProbeWindow).__toastProbe?.stop());
  r.ok(
    `every toast in a ${BURST}-toast burst reaches the DOM`,
    missing.length === 0,
    `${missing.length}/${BURST} never rendered: ${missing.join(", ")}`,
  );

  // The same invariant as before, now against a stack deep enough that one
  // dropped or one double-counted toast shows as an off-by-one.
  await assertCountIsTheStack(`with a ${BURST}-toast burst up`);

  // The count must not survive the toasts it counts. A burst that expires on
  // its own, followed by a single fresh toast, is the shape that exposes a
  // stale count: one toast on screen must never raise a "Dismiss all (n)".
  await emptyStack(45_000);
  await seed(1);
  await toasts.first().waitFor({ state: "visible", timeout: 10_000 });
  await assertCountIsTheStack("after a drained burst, with one toast up");

  // Clean up exactly what we created — by id, never the bulk endpoint.
  await page.evaluate(async (ids) => {
    for (const id of ids) {
      const res = await fetch(`/api/notifications/${id}/dismiss`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`dismiss ${id} failed: ${res.status}`);
    }
  }, seededIds);

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join("; "),
  );

  /**
   * The contract, as one instantaneous check: the affordance is on screen
   * exactly when the stack is plural, and the number it prints is that stack.
   *
   * The number is the assertion worth making. Both previous versions of this
   * affordance kept a parallel copy of "what is on screen" and printed a count
   * that had drifted from it — an empty corner under a `Dismiss all (3)`. That
   * the button merely showed up was never the bug.
   *
   * Count and label come out of a single `evaluate` deliberately: a toast
   * expires every four seconds on its own, so two round-trips can straddle one
   * and manufacture a mismatch the app never had. Within one synchronous
   * callback the DOM cannot move between the two reads. Reading the stack
   * alongside the label — rather than expecting a number — is also what makes
   * this immune to whatever the worktree toasts on its own.
   *
   * The control is rendered or it is `null`; there is no hidden state, so
   * presence in the DOM is its visibility.
   */
  async function assertCountIsTheStack(when: string): Promise<void> {
    const { mounted, label } = await page.evaluate((sel) => {
      const button = Array.from(document.querySelectorAll("button")).find((b) =>
        /Dismiss all/.test(b.textContent ?? ""),
      );
      return {
        mounted: document.querySelectorAll(sel).length,
        label: button?.textContent ?? null,
      };
    }, ALL);

    r.eq(
      `${when}: visible ⟺ plural (${mounted} up)`,
      label !== null,
      mounted >= 2,
    );
    if (label === null) return;

    const printed = /Dismiss all \((\d+)\)/.exec(label)?.[1];
    if (printed === undefined) {
      r.fail(
        `${when}: label carries a count`,
        `unreadable: ${JSON.stringify(label)}`,
      );
      return;
    }
    r.eq(`${when}: the printed count is the stack`, Number(printed), mounted);
  }

  /** Wait until nothing is on screen — in-flight toasts expire on their own. */
  async function emptyStack(timeout: number): Promise<void> {
    await page
      .waitForFunction(
        (sel) => document.querySelectorAll(sel).length === 0,
        ALL,
        { timeout },
      )
      .catch((err: unknown) => {
        // A worktree that keeps filing notifications may never go quiet. That
        // is not a failure here — every assertion below reads the live count.
        if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
        r.note("stack never went quiet — proceeding against ambient toasts");
      });
  }

  /**
   * Watch toasts *enter* the DOM, keyed by their seeded title.
   *
   * Insertions rather than samples: a toast that renders and expires between
   * two polls is indistinguishable from one that never rendered, and "never
   * rendered" is the entire finding. Keying by title rather than counting
   * elements is what keeps the worktree's own notifications out of the tally.
   */
  async function startToastProbe(): Promise<void> {
    await page.evaluate(() => {
      const seen = new Set<string>();
      const observer = new MutationObserver((records) => {
        // Safe to read the text here: the callback runs at the microtask
        // checkpoint after the batch, by which point React has finished
        // building the subtree it inserted.
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (!(node instanceof Element)) continue;
            const inserted = node.matches("[data-sonner-toast]")
              ? [node]
              : Array.from(node.querySelectorAll("[data-sonner-toast]"));
            for (const el of inserted) {
              const title = /Seeded toast \d+/.exec(el.textContent ?? "")?.[0];
              if (title !== undefined) seen.add(title);
            }
          }
        }
      });
      observer.observe(document, { childList: true, subtree: true });
      (window as ToastProbeWindow).__toastProbe = {
        seen,
        stop: () => observer.disconnect(),
      };
    });
  }

  /**
   * Fire `n` notifications; the bell plugin toasts one per arrival. Ids AND
   * titles carry a run-wide index — a repeated title across batches is exactly
   * what the notification store would fold into one row, and it is also what
   * lets the probe above tell our toasts from the worktree's. Returns the
   * titles it seeded.
   *
   * `tight` posts the batch concurrently instead of one at a time. The dropped
   * enqueue this script hunts only exists inside a single React commit, so the
   * arrivals have to be close enough together to share one live-state push and
   * one `useEffect` pass; a sequential drip lets the Toaster re-settle between
   * them and can never reproduce it.
   */
  async function seed(
    n: number,
    opts: { tight?: boolean } = {},
  ): Promise<string[]> {
    const offset = seededIds.length;
    const batch = Array.from({ length: n }, (_, i) => ({
      id: `e2e-toast-${Date.now()}-${offset + i}`,
      title: `Seeded toast ${offset + i + 1}`,
    }));
    seededIds.push(...batch.map((entry) => entry.id));
    await page.evaluate(
      async ({ batch: entries, tight }) => {
        const post = async (entry: {
          id: string;
          title: string;
        }): Promise<void> => {
          const res = await fetch("/api/notifications", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: entry.id,
              type: "e2e",
              title: entry.title,
              description: "Fired by the dismiss-all e2e script.",
              variant: "info",
            }),
          });
          if (!res.ok) throw new Error(`seed failed: ${res.status}`);
        };
        if (tight) await Promise.all(entries.map(post));
        else for (const entry of entries) await post(entry);
      },
      { batch, tight: opts.tight === true },
    );
    return batch.map((entry) => entry.title);
  }
});

await r.finish();
