// The inset, measured on a DEPLOYED panel: one content edge, and padding that
// matches the tracks the panel actually reserves.
//
//   ./equin run plugins/primitives/plugins/css/plugins/control-panel/e2e/panel-inset-verify.ts
//   ./equin run …/panel-inset-verify.ts --path /agents --steps 'until:Theme,click:Theme' --report
//
// With no `--path` it sweeps the Tasks toolbar's own control panels (the
// primitive's shipped consumers). With one, it drives to any other panel — a
// migrated consumer is typically five clicks into an app — and applies the same
// verdict there. `--report` additionally prints the full geometry.
//
// The `layout-geometry` harness measures FIXTURES; this measures the real
// panels, which is where a wrong rail declaration site actually shows up (a
// `--rail-start` published at `:root` freezes on the root's `--cp-rail-icon`
// and the whole panel drifts by a track nobody paints in). A screenshot cannot
// tell 12 from 38, either.
//
// The expected padding is NOT one number, and that is the correction v2's own
// doc needed: the published `--rail-start` is the chrome pad plus the icon
// rail, and the icon rail moves with the tracks the panel reserves. A panel where some row hangs a drag handle keeps
// the gutter (12 + gutter + icon-gap = 36px); a panel where none does drops it
// (12px). So the check reads the panel's own occupancy marks AND its own
// `--cp-gutter` / `--cp-icon-gap`, and expects what that derivation implies —
// never a hardcoded 36.
//
// Steps are applied in order, comma-separated:
//   click:<accessible name>   synthetic click (`name#2` picks the 2nd match)
//   until:<accessible name>   wait (up to 60s) for that control to exist
//   press:<accessible name>   real pointer press at the element's centre
//   hover:<css>               hover an element
//   sel:<css>                 click the first element matching a selector
//   mouse:<x>x<y>             move the real pointer (hover-revealed chrome)
//   width:<css width>         force the open panel's surface to another width
//   wait:<ms>                 pause
import type { Page } from "playwright";
import {
  withBrowser,
  boot,
  arg,
  flag,
  pathUrl,
  report,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const path = arg("path", "");
const steps = arg("steps", "");
const out = arg("out", "");
const settle = Number(arg("settle", "600"));

interface Placed {
  what: string;
  /** x relative to the panel's border box. */
  x: number;
}

interface PanelGeometry {
  width: number;
  paddingLeft: number;
  paddingRight: number;
  /** `--cp-gutter` + `--cp-icon-gap`, resolved ON the panel. */
  gutterPlusGap: number;
  /** Does any row in the panel hang a drag handle? */
  hasHandle: boolean;
  /** Does any row OCCUPY the leading cell (an icon, a check or a radio)? */
  hasIcon: boolean;
  /** The row grid the panel derived — the tracks it actually reserves. */
  rowTemplate: string | null;
  rowCount: number;
  overflows: boolean;
  /** Everything that must start on the panel's own content edge. */
  onRail: Placed[];
  /** Row label cells — one x each, but NOT the panel's edge when an icon exists. */
  labels: Placed[];
  bands: {
    footer: boolean;
    label: string | null;
    labelX: number | null;
    looseX: { tag: string; text: string; x: number; right: number }[];
    rows: { text: string; leadingX: number | null; labelX: number }[];
  }[];
}

/** Read one open panel's geometry. `which` picks the host or the topmost panel. */
async function measure(
  page: Page,
  which: string,
): Promise<PanelGeometry | null> {
  return page.evaluate((pick): PanelGeometry | null => {
    // The LAST panel in the DOM by default: a panel opened FROM a panel (the
    // date chooser over the filter builder) is portaled after it, and the
    // topmost one is the one under test. `--panel first` measures the host.
    const panels = [...document.querySelectorAll<HTMLElement>(".cp-panel")];
    const panel = pick === "first" ? panels[0] : panels[panels.length - 1];
    if (!panel) return null;
    const cs = getComputedStyle(panel);
    const box = panel.getBoundingClientRect();
    const text = (el: Element) => (el.textContent ?? "").trim().slice(0, 40);
    const px = (v: string) => parseFloat(v) || 0;
    const rel = (el: Element) =>
      Math.round((el.getBoundingClientRect().left - box.left) * 10) / 10;
    // `renderIsolated` wraps every contributed child in a `display: contents`
    // span, whose own box is 0×0 at the origin — measuring THAT reports a
    // nonsense x. Descend to the first descendant that actually has a box, the
    // same way `cp-body`'s flex layout reaches past the wrapper.
    const laidOut = (el: HTMLElement): HTMLElement => {
      let cur: HTMLElement = el;
      while (getComputedStyle(cur).display === "contents") {
        const next = cur.firstElementChild;
        if (!(next instanceof HTMLElement)) return cur;
        cur = next;
      }
      return cur;
    };

    const onRail: Placed[] = [];
    const labels: Placed[] = [];

    const bands = [...panel.querySelectorAll<HTMLElement>(".cp-band")].map(
      (band) => {
        const children = [...band.children] as HTMLElement[];
        const isRow = (el: HTMLElement) => el.classList.contains("cp-row");
        // The band's label is the SectionLabel `ControlPanel.Section` renders
        // first; a band with no label starts straight into content.
        const first = children[0];
        const labelled =
          first !== undefined && !isRow(first) && children.length > 1;
        const label = labelled ? first : null;
        const loose = children.filter((el) => !isRow(el) && el !== label);
        if (label) {
          onRail.push({
            what: `band label "${text(label)}"`,
            x: rel(laidOut(label)),
          });
        }
        return {
          footer: band.hasAttribute("data-cp-footer"),
          label: label ? text(label) : null,
          labelX: label ? rel(laidOut(label)) : null,
          looseX: loose.map((wrapper) => {
            const el = laidOut(wrapper);
            const b = el.getBoundingClientRect();
            // A zero-box helper (dnd-kit's live region, a drag overlay) is not
            // content and has no edge to hold.
            if (b.width > 1) {
              onRail.push({
                what: `loose <${el.tagName.toLowerCase()}> "${text(el)}"`,
                x: rel(el),
              });
            }
            return {
              tag: el.tagName.toLowerCase(),
              text: text(el),
              x: rel(el),
              right: Math.round((box.right - b.right) * 10) / 10,
            };
          }),
          rows: [...band.querySelectorAll<HTMLElement>(".cp-row")].map(
            (row) => {
              const lead = row.querySelector<HTMLElement>(
                '[data-cp-cell="icon"]',
              );
              const lbl = row.querySelector<HTMLElement>(
                '[data-cp-cell="label"]',
              );
              // A dropped cell is `display: none`d, so it has no box to hold a
              // rail with — the LABEL is then what sits on the panel's edge.
              const leadShown = lead !== null && lead.offsetParent !== null;
              if (leadShown && lead) {
                onRail.push({
                  what: `row leading "${text(row)}"`,
                  x: rel(lead),
                });
              } else if (lbl) {
                onRail.push({ what: `row label "${text(row)}"`, x: rel(lbl) });
              }
              if (lbl) labels.push({ what: text(row), x: rel(lbl) });
              return {
                text: text(row),
                leadingX: leadShown && lead ? rel(lead) : null,
                labelX: lbl ? rel(lbl) : -1,
              };
            },
          ),
        };
      },
    );

    return {
      width: Math.round(box.width),
      paddingLeft: px(cs.paddingLeft),
      paddingRight: px(cs.paddingRight),
      // MEASURED, not parsed: the tokens resolve to rem, and `parseFloat` on
      // "1.5rem" reports 1.5. A probe sized by the same `calc()` the row grid
      // uses converts them in the panel's own context, whatever the unit.
      gutterPlusGap: (() => {
        const probe = document.createElement("div");
        probe.style.position = "absolute";
        probe.style.visibility = "hidden";
        probe.style.width = "calc(var(--cp-gutter) + var(--cp-icon-gap))";
        panel.appendChild(probe);
        const w = probe.getBoundingClientRect().width;
        probe.remove();
        return Math.round(w * 10) / 10;
      })(),
      hasHandle: panel.querySelector("[data-cp-handle]") !== null,
      hasIcon: panel.querySelector("[data-cp-icon]") !== null,
      rowTemplate: (() => {
        const row = panel.querySelector<HTMLElement>(".cp-row");
        return row ? getComputedStyle(row).gridTemplateColumns : null;
      })(),
      rowCount: panel.querySelectorAll(".cp-row").length,
      overflows: panel.scrollWidth > panel.clientWidth + 1,
      onRail,
      labels,
      bands,
    };
  }, which);
}

/** The verdict, for one open panel. */
function verdict(r: Report, geo: PanelGeometry, label: string): void {
  if (flag("report")) console.log(`${label}:`, JSON.stringify(geo, null, 2));

  // The inset IS the icon rail. Handle-less, that rail is the row's own inline
  // padding, so the panel pads symmetrically; with a handle it also carries the
  // gutter and the column gap that follows it — derived from the panel's own
  // tokens rather than from a number typed here.
  const expectedLeft =
    geo.paddingRight + (geo.hasHandle ? geo.gutterPlusGap : 0);
  r.ok(
    `${label}: padding is the icon rail`,
    Math.abs(geo.paddingLeft - expectedLeft) < 0.5,
    `${geo.paddingLeft} / ${geo.paddingRight}, expected ${expectedLeft} left (handle: ${geo.hasHandle})`,
  );

  // Invariant #1, measured against the panel's OWN edge rather than against
  // whichever child happened to be first.
  const strays = geo.onRail.filter(
    (p) => Math.abs(p.x - geo.paddingLeft) >= 0.5,
  );
  r.ok(
    `${label}: every block starts on the panel's content edge`,
    strays.length === 0,
    strays.map((s) => `${s.what} @${s.x} (edge ${geo.paddingLeft})`).join("; "),
  );

  // …and one x for every row label, whether or not that particular row has an
  // icon — the conditional leading cell the row grid exists to delete.
  const labelXs = [...new Set(geo.labels.map((l) => Math.round(l.x)))];
  r.ok(
    `${label}: every row label starts at one x`,
    labelXs.length <= 1,
    labelXs.join(" / "),
  );

  // The two leading tracks are derived from what the panel puts in them: a
  // panel with neither is a TWO-track row, not a four-track row with two empty
  // columns nothing paints in.
  if (geo.rowCount > 0 && geo.rowTemplate) {
    const tracks = geo.rowTemplate.trim().split(/\s+/).length;
    const expected = 2 + (geo.hasHandle ? 1 : 0) + (geo.hasIcon ? 1 : 0);
    r.ok(
      `${label}: row reserves ${expected} tracks`,
      tracks === expected,
      `${geo.rowTemplate} (handle: ${geo.hasHandle}, icon: ${geo.hasIcon})`,
    );
  }

  r.ok(`${label}: no horizontal overflow`, !geo.overflows, "");
}

/** Click by accessible name, in the page rather than through Playwright. */
async function clickNamed(page: Page, raw: string): Promise<boolean> {
  return page.evaluate((spec) => {
    // `name#2` picks the SECOND match — for a repeated control (a rule row's
    // own "Remove filter"), where the first belongs to someone else.
    const hash = spec.lastIndexOf("#");
    const nth = hash > 0 ? Number(spec.slice(hash + 1)) : 1;
    const name = hash > 0 ? spec.slice(0, hash) : spec;
    const named = [...document.querySelectorAll("button, a")].map((b) => ({
      el: b,
      name: b.getAttribute("aria-label") ?? (b.textContent ?? "").trim(),
    }));
    // Exact first, then prefix — an ACTIVE data-view trigger spells its summary
    // after a colon ("Sort: Rank"), so the control's own name is the handle.
    const exact = named.filter((n) => n.name === name);
    const pool =
      exact.length > 0 ? exact : named.filter((n) => n.name.startsWith(name));
    const el = pool[nth - 1]?.el;
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  }, raw);
}

await withBrowser(async (h) => {
  const r = report("control-panel inset + rail");
  const { page } = await h.session({
    viewport: { width: 1600, height: 1000 },
    capture: false,
  });

  // `marker`, not a fixed sleep: the app's own chrome is what the steps below
  // reach for, so "a visible button exists" is the honest readiness signal.
  await boot(page, pathUrl(path || "/agents/tasks"), {
    marker: "button:visible",
    settleMs: Number(arg("boot-settle", "2500")),
  });

  if (path === "") {
    // THE SWEEP: the primitive's own shipped consumers. Every trigger is
    // icon-only, so its accessible name is the only handle on it; an ACTIVE
    // control spells its summary after a colon.
    const triggers = await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .map((b) => b.getAttribute("aria-label"))
        .filter(
          (l): l is string =>
            !!l && /^(Filter|Sort|View settings)(:|$)/.test(l),
        ),
    );
    r.ok(
      "the Tasks toolbar exposes control triggers",
      triggers.length >= 2,
      triggers.join(" | "),
    );
    for (const name of triggers) {
      await clickNamed(page, name);
      await page.waitForTimeout(1200);
      const geo = await measure(page, "last");
      r.ok(`${name}: panel opened`, geo !== null);
      if (geo) verdict(r, geo, name);
      // Close it again — an open popover would swallow the next trigger.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
    if (out) await page.screenshot({ path: `${out}.png` });
    await r.finish();
  }

  for (const step of steps
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [kind, ...rest] = step.split(":");
    const value = rest.join(":");
    if (kind === "click") {
      // A synthetic click, not Playwright's: several of these triggers sit
      // under a measurement pass (the adaptive bar) or inside a surface that
      // re-renders on press, either of which keeps Playwright's actionability
      // wait open long past the click having landed.
      if (!(await clickNamed(page, value)))
        throw new Error(`no button named "${value}"`);
    } else if (kind === "sel") {
      const hit = await page.evaluate((css) => {
        const el = document.querySelector(css);
        if (!(el instanceof HTMLElement)) return false;
        el.click();
        return true;
      }, value);
      if (!hit) throw new Error(`no element matched "${value}"`);
    } else if (kind === "until") {
      // Poll for a named control to EXIST. A boot marker only proves the shell
      // painted; a lazily-loaded surface (a Sonata song, a page's blocks)
      // arrives later, and clicking into the gap is the flake this removes.
      await page.waitForFunction(
        (name) =>
          [...document.querySelectorAll("button, a")].some((b) =>
            (
              b.getAttribute("aria-label") ?? (b.textContent ?? "").trim()
            ).startsWith(name),
          ),
        value,
        { timeout: 60_000 },
      );
    } else if (kind === "press") {
      // A REAL pointer press at the element's centre — for a trigger that opens
      // on `pointerdown` rather than on a synthetic `click`.
      const box = await page.evaluate((name) => {
        const named = [...document.querySelectorAll("button, a")].map((b) => ({
          el: b,
          name: b.getAttribute("aria-label") ?? (b.textContent ?? "").trim(),
        }));
        const el =
          named.find((n) => n.name === name)?.el ??
          named.find((n) => n.name.startsWith(name))?.el;
        if (!(el instanceof HTMLElement)) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, value);
      if (!box) throw new Error(`no button named "${value}"`);
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.up();
    } else if (kind === "width") {
      // Force the open panel's SURFACE to another width, so ONE deploy can be
      // measured at several width roles (they differ only in that class) — the
      // measurement that answers "does this body fit that role" without a build
      // per candidate. The body's own column count comes from a ResizeObserver,
      // so follow this with a `wait:`.
      const applied = await page.evaluate((width) => {
        const panels = [...document.querySelectorAll<HTMLElement>(".cp-panel")];
        const panel = panels[panels.length - 1];
        if (!panel) return null;
        // The surface and its positioner BOTH carry the role's width class and
        // both measure the same as the body, so there is no width to find by
        // measurement — override the two boxes above the panel.
        const targets = [
          panel.parentElement,
          panel.parentElement?.parentElement,
        ];
        for (const t of targets) {
          if (t instanceof HTMLElement) {
            t.style.setProperty("width", width, "important");
            t.style.setProperty("max-width", width, "important");
          }
        }
        return Math.round(panel.getBoundingClientRect().width);
      }, value);
      if (applied === null) throw new Error("no panel open to resize");
    } else if (kind === "mouse") {
      // A REAL pointer move, for chrome revealed by hover intent (the floating
      // action bar): a synthetic click cannot open what only a pointer opens.
      const [x, y] = value.split("x").map(Number);
      await page.mouse.move(x ?? 0, y ?? 0);
    } else if (kind === "hover") {
      await page.locator(value).first().hover({ timeout: 15_000 });
    } else if (kind === "wait") {
      await page.waitForTimeout(Number(value));
    } else {
      throw new Error(`unknown step "${step}"`);
    }
    await page.waitForTimeout(settle);
  }

  // `--dump` lists what is clickable right now — the fastest way to find the
  // handle on a trigger whose accessible name is not what you guessed.
  if (flag("dump")) {
    const names = await page.evaluate(() =>
      [...document.querySelectorAll("button, a")]
        .map(
          (b) => b.getAttribute("aria-label") ?? (b.textContent ?? "").trim(),
        )
        .filter((n) => n.length > 0),
    );
    console.log("clickables:", JSON.stringify(names, null, 1));
  }

  // `--grids`: every CSS grid inside the panel with the tracks it resolved to —
  // the direct read of how many columns this width gives a grid body.
  if (flag("grids")) {
    const grids = await page.evaluate(() => {
      const panels = [...document.querySelectorAll<HTMLElement>(".cp-panel")];
      const panel = panels[panels.length - 1];
      if (!panel) return null;
      return {
        panelWidth: Math.round(panel.getBoundingClientRect().width),
        grids: [...panel.querySelectorAll<HTMLElement>("*")]
          .filter((el) => getComputedStyle(el).display === "grid")
          .slice(0, 12)
          .map((el) => ({
            cols: getComputedStyle(el).gridTemplateColumns,
            width: Math.round(el.getBoundingClientRect().width),
            text: (el.textContent ?? "").trim().slice(0, 30),
          })),
      };
    });
    console.log("grids:", JSON.stringify(grids, null, 1));
  }

  const geo = await measure(page, arg("panel", "last"));
  r.ok("a control panel is open", geo !== null, path);
  if (geo) verdict(r, geo, path);

  if (out) await page.screenshot({ path: `${out}.png` });
  await r.finish();
});
