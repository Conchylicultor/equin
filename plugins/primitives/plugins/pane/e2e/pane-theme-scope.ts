/**
 * Pins the capability `PaneBox` exists for: **a pane wears its home app's theme,
 * not its host's.**
 *
 * `Pane.define({ app })` names the app a pane belongs to, and panes are reusable
 * chrome — the agent manager hosts the page detail beside a conversation. Before
 * `PaneBox`, the only `data-theme-scope` on screen was the TAB's, so a page pane
 * opened at `/agents/page/<id>` was painted with the agent manager's palette. The
 * box now stamps the pane's own scope, nested inside the tab's.
 *
 * What is asserted, on `/agents/page/<id>` (a Pages pane hosted by the agent
 * manager) with `/pages/page/<id>` (the same pane at home) as the control:
 *
 *  0. Non-vacuity: the page pane really rendered — the probe is looking at a
 *     pane, not at an empty route or a redirect back to Pages.
 *  1. The pane's box carries `data-theme-scope="app:pages"`.
 *  2. That box is a DESCENDANT of the tab's `app:agents` scope — i.e. the page
 *     is genuinely hosted by the agent manager, not navigated away to Pages.
 *     Without this, assertion 1 would also pass on a redirect.
 *  3. The scope has a visible CONSEQUENCE, which is the half a DOM attribute
 *     cannot show. The script injects the exact block a forked Pages theme emits
 *     (`[data-theme-scope="app:pages"] { --background: … }`) and reads back the
 *     pane's PAINTED background — its computed `background-color`, not the
 *     custom property. That distinction is the whole assertion: the token alone
 *     changes nothing, because the element filling the surface is the tab
 *     container above the pane, which resolves `--background` in the HOST's
 *     scope. A pane that resolves the right value and paints none of it looks
 *     exactly like a pane with no theme at all. The host's own canvas must NOT
 *     move. Injecting rather than forking the real config keeps the run
 *     read-only — the probe exercises theme-engine's mechanism without writing a
 *     user's theme.
 *  4. Control: at `/pages/page/<id>` the same pane still reports `app:pages`,
 *     so assertion 1 is about the pane's home and not about being a guest.
 *  5. The same thing asserted for the whole CLASS rather than for this one pane:
 *     NO theme boundary anywhere on screen is half-themed — re-theming a subtree
 *     while painting none of it, so the fill the user sees belongs to an
 *     ancestor in the ancestor's palette. `PaneBox` is the site that bug was
 *     found at, not the only site that could have it, and every instance of it
 *     is invisible until someone looks at a screenshot. See
 *     {@link sweepBoundaryPaint} for why the assertion is phrased that way and
 *     not as the blunter "every boundary paints".
 *
 * Manual only — nothing runs this automatically.
 *
 *   ./equin run plugins/primitives/plugins/pane/e2e/pane-theme-scope.ts \
 *     [--base http://<worktree>.localhost:9000] [--page <blockId>] [--headed]
 */
import {
  boot,
  pathUrl,
  report,
  requireArg,
  withBrowser,
  type Session,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

type Page = Session["page"];

/** The scope tokens under test — `appThemeScope(id)` spelled for the browser. */
const HOST_SCOPE = "app:agent-manager";
const GUEST_SCOPE = "app:pages";
/** The pane under test, by its `Pane.define({ id })`. */
const PAGE_PANE = "page-detail";
/** The pane-tier header band: proof a pane actually painted. */
const PANE_HEADER = ".h-chrome-pane";

/**
 * A colour no theme would pick, so reading it back can only mean the injected
 * block won. Written as `rgb(…)` because that is what `getComputedStyle`
 * normalizes a custom property's colour to.
 */
const PROBE_BG = "rgb(1, 2, 3)";
/** How `getComputedStyle` spells "paints nothing". */
const TRANSPARENT = "rgba(0, 0, 0, 0)";

const r = report("pane theme scope");

const pageId = requireArg(
  "page",
  "a page block id to open, e.g. --page block-0bf62402-d00a-41d6-9d9d-d77dd73d1e73 " +
    "(any id from `select id from page_blocks where type = 'page' limit 1`)",
);

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1600, height: 900 } });

  // ---- The pane as a GUEST of the agent manager -------------------------
  await boot(page, pathUrl(`/agents/page/${pageId}`), {
    marker: PANE_HEADER,
    settleMs: 2000,
    // The default 30s is not enough on a loaded host: this box regularly sits at
    // loadAvg ~37 on 18 cores with a 1-2s event-loop p99, and a cold app boot
    // then misses it. A boot timeout here says nothing about the pane.
    timeoutMs: 90_000,
  });

  const guest = await readPaneScope(page, PAGE_PANE, HOST_SCOPE);
  r.note(
    `guest: visible panes —\n        ${guest.inventory.join("\n        ")}`,
  );
  r.ok(
    "guest: the page pane painted at /agents/page/<id>",
    guest.found,
    `no visible [data-pane-id="${PAGE_PANE}"] box inside ${HOST_SCOPE} — probe vacuous`,
  );
  r.eq("guest: the pane wears its home app's scope", guest.scope, GUEST_SCOPE);
  r.ok(
    "guest: the pane sits INSIDE the agent manager's scope (really hosted)",
    guest.hostScope === HOST_SCOPE,
    `nearest scope above the pane was ${guest.hostScope ?? "none"}, expected ${HOST_SCOPE} — ` +
      `a redirect to Pages would look like this`,
  );

  // ---- …and that the scope actually paints ------------------------------
  // What the deploy ACTUALLY paints right now, before touching anything. This is
  // the user-visible outcome, but it is config-dependent — the two values are
  // equal when Pages has not forked its theme (nothing to show, not a bug) — so
  // it is reported, not asserted.
  const live = await readBackgrounds(page);
  r.note(
    `guest: live --background token in pane=${live.inPane} at :root=${live.inChrome}` +
      (live.inPane === live.inChrome
        ? "  (equal — the Pages app has no forked theme on this deploy)"
        : "  (differs — Pages is forked on this deploy)"),
  );
  r.note(
    `guest: live painted background of the pane box = ${live.paintedPane}`,
  );
  r.ok(
    "guest: the pane paints a canvas of its own (not transparent over its host)",
    live.paintedPane !== TRANSPARENT,
    "the pane box is transparent, so whatever it shows is the HOST's canvas — " +
      "the scoped token cascades but nothing fills the pane with it",
  );

  // ---- …and so does every OTHER boundary on screen -----------------------
  // The assertion just above, generalized: the pane was where the bug was found,
  // not the only place it could be. One sweep over every boundary is the whole
  // class asserted once, so a new one that forgets its canvas fails here instead
  // of being noticed in a screenshot months later.
  const sweep = await sweepBoundaryPaint(page);
  r.note(
    `sweep: ${sweep.painted.length} boundaries paint —\n        ` +
      sweep.painted.join("\n        "),
  );
  if (sweep.sameTheme.length > 0) {
    r.note(
      `sweep: ${sweep.sameTheme.length} transparent, over a canvas of their OWN theme (fine) —\n        ` +
        sweep.sameTheme.join("\n        "),
    );
  }
  r.note(
    `sweep: ${sweep.skippedNoBox} elements carry a scope but have no box on screen (nothing to paint)`,
  );
  // Non-vacuity, like assertion 0 above: a sweep that found nothing to look at
  // would report success while asserting nothing at all.
  r.ok(
    "sweep: the sweep found boundaries to check",
    sweep.painted.length + sweep.sameTheme.length + sweep.halfThemed.length >=
      3,
    "fewer than 3 visible theme boundaries on a full app surface — the sweep is vacuous",
  );
  r.ok(
    "sweep: no half-themed boundary anywhere on screen",
    sweep.halfThemed.length === 0,
    `${sweep.halfThemed.length} boundar${sweep.halfThemed.length === 1 ? "y" : "ies"} ` +
      `re-theme a subtree and paint none of it, so the user sees the fill behind ` +
      `them in the WRONG theme: ${sweep.halfThemed.join("; ")}`,
  );

  // The config-independent half: inject the exact block a forked app emits —
  // BOTH selectors, because the engine's dark variant is `.dark [data-theme-scope=…]`
  // and a single-attribute rule would lose to it on specificity in dark mode.
  const painted = await injectAndRead(page, GUEST_SCOPE);
  r.eq(
    "guest: a Pages-scoped token reaches the pane",
    painted.inPane,
    PROBE_BG,
  );
  r.eq("guest: …and the pane PAINTS it", painted.paintedPane, PROBE_BG);
  r.ok(
    "guest: …while the host's own canvas stays put",
    painted.paintedHost !== PROBE_BG,
    `the tab container painted ${painted.paintedHost} too — the scope is not scoping`,
  );

  // ---- Control: the same pane AT HOME -----------------------------------
  await boot(page, pathUrl(`/pages/page/${pageId}`), {
    marker: PANE_HEADER,
    settleMs: 2000,
    // The default 30s is not enough on a loaded host: this box regularly sits at
    // loadAvg ~37 on 18 cores with a 1-2s event-loop p99, and a cold app boot
    // then misses it. A boot timeout here says nothing about the pane.
    timeoutMs: 90_000,
  });

  const home = await readPaneScope(page, PAGE_PANE, GUEST_SCOPE);
  r.ok("home: the page pane painted at /pages/page/<id>", home.found);
  r.eq("home: the pane wears the same scope at home", home.scope, GUEST_SCOPE);
  r.eq("home: the tab is Pages", home.hostScope, GUEST_SCOPE);

  await r.finish();
});

/**
 * The pane box's own scope plus the nearest scope ABOVE it. Both are read in one
 * DOM walk so they can never describe different elements.
 */
async function readPaneScope(
  page: Page,
  paneId: string,
  hostScope: string,
): Promise<{
  found: boolean;
  scope: string | null;
  hostScope: string | null;
  inventory: string[];
}> {
  return page.evaluate(
    ({ wanted, host }) => {
      // Every tab stays mounted (keep-alive) — the unfocused ones are
      // `display:none`, and their pane boxes would answer for a surface nobody is
      // looking at. Only boxes with a layout box are on screen.
      const boxes = Array.from(
        document.querySelectorAll("[data-pane-id]"),
      ).filter((el) => el.getClientRects().length > 0);
      const scopeOf = (el: Element | null) =>
        el?.getAttribute("data-theme-scope") ?? null;
      const hostOf = (el: Element) =>
        scopeOf(el.parentElement?.closest("[data-theme-scope]") ?? null);
      // Pick by (pane id, host scope), not by document order: several surfaces
      // are mounted at once (other tabs, the keep-alive fallback), and "the first
      // page-detail on screen" is whichever one React happened to paint first.
      const box =
        boxes.find(
          (el) =>
            el.getAttribute("data-pane-id") === wanted && hostOf(el) === host,
        ) ?? null;
      return {
        found: box !== null,
        scope: scopeOf(box),
        hostScope: box ? hostOf(box) : null,
        // Every visible pane on screen, so a reader can see what else was up and
        // a mis-targeted probe is obvious rather than silent.
        inventory: boxes.map(
          (el) =>
            `${el.getAttribute("data-pane-id")} → ${scopeOf(el) ?? "none"} ` +
            `(inside ${hostOf(el) ?? "none"})`,
        ),
      };
    },
    { wanted: paneId, host: hostScope },
  );
}

/**
 * Inject the block a forked app theme emits, then read `--background` back from
 * inside the pane and from the app rail (chrome that is NOT inside any pane).
 * The pair is what makes the reading mean "scoped" rather than "global".
 */
async function injectAndRead(
  page: Page,
  scope: string,
): Promise<{
  inPane: string;
  inChrome: string;
  paintedPane: string;
  paintedHost: string;
}> {
  return page.evaluate(
    ({ scope, probe }) => {
      const style = document.createElement("style");
      style.textContent =
        `[data-theme-scope="${scope}"], .dark [data-theme-scope="${scope}"] ` +
        `{ --background: ${probe}; }`;
      document.head.appendChild(style);
      const token = (el: Element | null) =>
        el ? getComputedStyle(el).getPropertyValue("--background").trim() : "";
      const paint = (el: Element | null) =>
        el ? getComputedStyle(el).backgroundColor : "";
      const box =
        Array.from(document.querySelectorAll("[data-pane-id]")).find(
          (el) => el.getClientRects().length > 0,
        ) ?? null;
      // The tab container is the element that FILLS the surface — the paint a
      // transparent pane used to show instead of its own. It must not move.
      const tab = box?.closest("[data-tab-id]") ?? null;
      return {
        inPane: token(box),
        // `:root` is the one element guaranteed to be outside every pane AND to
        // carry no `data-theme-scope` of its own, so it reads the host/global
        // value the injected block must NOT have reached.
        inChrome: token(document.documentElement),
        paintedPane: paint(box),
        paintedHost: paint(tab),
      };
    },
    { scope, probe: PROBE_BG },
  );
}

/** The `--background` token inside the visible pane and at `:root`, plus what the
 *  pane box actually PAINTS — as the deploy renders them right now, no injection
 *  and nothing mutated. */
async function readBackgrounds(page: Page): Promise<{
  inPane: string;
  inChrome: string;
  paintedPane: string;
}> {
  return page.evaluate(() => {
    const token = (el: Element | null) =>
      el ? getComputedStyle(el).getPropertyValue("--background").trim() : "";
    const box =
      Array.from(document.querySelectorAll("[data-pane-id]")).find(
        (el) => el.getClientRects().length > 0,
      ) ?? null;
    return {
      inPane: token(box),
      inChrome: token(document.documentElement),
      paintedPane: box ? getComputedStyle(box).backgroundColor : "",
    };
  });
}

/**
 * Every theme boundary on screen, classified by whether it leaves the user
 * looking at someone else's theme.
 *
 * The failure being swept for is not "transparent" — it is **half-themed**: an
 * element that re-themes its subtree and paints none of it, so the fill the user
 * actually sees is an ancestor's, in the ancestor's palette, under text that
 * reads the new one. That is the exact shape `PaneBox` shipped with, and stating
 * it that way is what makes the sweep able to cover every site instead of one.
 *
 * So a transparent boundary is only a failure when the nearest thing that DOES
 * paint behind it wears a different scope. Two consequences, and both are the
 * definition rather than an exemption bolted on:
 *
 *  - The toaster host needs no special case. It declares `surface="none"`, and
 *    the chrome canvas behind it wears the very scope it stamps — nothing is
 *    mis-themed, which is why painting there would be wrong rather than merely
 *    unnecessary.
 *  - Neither do the in-tree portal CARRIERS. An `AdaptiveBar` occupant container
 *    and a `SurfaceOverlay` root re-stamp the whole forwarded attribute bag —
 *    theme scope included — onto a box that is deliberately transparent. They
 *    carry a boundary declared elsewhere rather than declaring one, and nothing
 *    in the DOM tells them apart from a declaration today; keying on what the
 *    user can SEE sidesteps having to.
 *
 * Two things are left out of the walk entirely. Anything portaled to
 * `document.body` — every popover / menu / tooltip positioner and every
 * `ViewportOverlay` root — is a carrier by construction, since a boundary is
 * declared inside the app tree, so the sweep starts at `#root`. And an element
 * with no box is skipped, because nothing shows through a zero-area box.
 */
async function sweepBoundaryPaint(page: Page): Promise<{
  painted: string[];
  sameTheme: string[];
  halfThemed: string[];
  skippedNoBox: number;
}> {
  return page.evaluate(
    ({ transparent: none }) => {
      // Enough to walk straight to the source file. A boundary is chrome, so it
      // rarely has an id or text of its own to name it by — what identifies it
      // is its full class recipe (the paint class that is missing is precisely
      // what is being reported) plus where it sits in the tree.
      const classesOf = (el: Element) =>
        (typeof el.className === "string" ? el.className : "").trim();
      const describe = (el: Element) => {
        const trail: string[] = [];
        for (
          let p = el.parentElement;
          p && trail.length < 3 && p.id !== "root";
          p = p.parentElement
        ) {
          const first = classesOf(p).split(/\s+/).filter(Boolean)[0];
          trail.unshift(p.tagName.toLowerCase() + (first ? `.${first}` : ""));
        }
        const classes = classesOf(el);
        return (
          (trail.length > 0 ? `${trail.join(" > ")} > ` : "") +
          `${el.tagName.toLowerCase()}[${el.getAttribute("data-theme-scope")}]` +
          (el.hasAttribute("data-pane-id")
            ? `[pane=${el.getAttribute("data-pane-id")}]`
            : "") +
          (el.hasAttribute("data-tab-id")
            ? `[tab=${el.getAttribute("data-tab-id")}]`
            : "") +
          (classes ? ` class="${classes}"` : "")
        );
      };

      /** The theme worn by the nearest ancestor that actually paints a fill. */
      const themeBehind = (el: Element): string | null => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (getComputedStyle(p).backgroundColor === none) continue;
          // Inclusive: the painting element may itself be the boundary.
          return (
            p.closest("[data-theme-scope]")?.getAttribute("data-theme-scope") ??
            null
          );
        }
        return null;
      };

      const painted: string[] = [];
      const sameTheme: string[] = [];
      const halfThemed: string[] = [];
      let skippedNoBox = 0;

      const root = document.getElementById("root");
      for (const el of Array.from(
        root?.querySelectorAll("[data-theme-scope]") ?? [],
      )) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          skippedNoBox++;
          continue;
        }
        const bg = getComputedStyle(el).backgroundColor;
        if (bg !== none) {
          painted.push(`${describe(el)} → ${bg}`);
          continue;
        }
        const behind = themeBehind(el);
        if (behind === el.getAttribute("data-theme-scope")) {
          sameTheme.push(describe(el));
        } else {
          halfThemed.push(
            `${describe(el)} → transparent over a canvas themed ${behind ?? ":root"}`,
          );
        }
      }
      return { painted, sameTheme, halfThemed, skippedNoBox };
    },
    { transparent: TRANSPARENT },
  );
}
