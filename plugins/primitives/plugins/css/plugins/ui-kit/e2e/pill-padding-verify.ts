// Verifies the one relation between a pill's side padding and a rectangle's:
// at the same size a pill pads by the size's own `controlPad*` PLUS the shape
// group's pill extra, on each side that is a rounded end — and a split pill's
// inner seam takes none of it.
//
// Measured on probe elements mounted into a live theme scope, not on whatever
// buttons a screen happens to show: the relation is a property of the CSS, and
// the utilities under test (`px-control-*`, `pill-ends`, `pill-start`) are the
// same ones Button, ButtonGroup and Badge apply. jsdom evaluates no stylesheet,
// so this is the only place the arithmetic is actually run.
//
// Two scopes, because the interesting cases are "extra is 0" and "extra is set":
// the app's own theme (0 by default — a pill pads exactly like a rectangle) and
// the website's equin-document sub-theme (6px).
//
// Usage:
//   ./equin run plugins/primitives/plugins/css/plugins/ui-kit/e2e/pill-padding-verify.ts
//
// Manual only — nothing runs this automatically.

import type { Page } from "playwright";
import {
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

type Probe = {
  extra: number;
  rect: [number, number];
  pill: [number, number];
  start: [number, number];
  end: [number, number];
};

/**
 * Mounts four probes inside `hostSelector` (or the body) and reads their
 * computed inline padding: a plain size, the same size declared a pill, and the
 * two one-sided forms a split pill's end segments wear.
 */
async function probe(
  page: Page,
  hostSelector: string | null,
  size: "xs" | "sm" | "md" | "lg",
): Promise<Probe | null> {
  return page.evaluate(
    ({ sel, size }) => {
      const host = sel === null ? document.body : document.querySelector(sel);
      if (!host) return null;
      const box = document.createElement("div");
      host.appendChild(box);
      const mount = (classes: string) => {
        const el = document.createElement("div");
        el.className = `px-control-${size} ${classes}`;
        box.appendChild(el);
        return el;
      };
      const pad = (el: Element): [number, number] => {
        const s = getComputedStyle(el);
        return [
          parseFloat(s.paddingInlineStart),
          parseFloat(s.paddingInlineEnd),
        ];
      };
      const pillEl = mount("pill-ends");
      const result = {
        // Read off the pill itself: the shape token is an unresolved string on
        // the scope ("0.375rem"), while the per-side property it feeds is a
        // registered <length> and therefore computed in px.
        extra: parseFloat(
          getComputedStyle(pillEl).getPropertyValue("--pill-extra-start"),
        ),
        rect: pad(mount("")),
        pill: pad(pillEl),
        start: pad(mount("pill-start")),
        end: pad(mount("pill-end")),
      };
      box.remove();
      return result;
    },
    { sel: hostSelector, size },
  );
}

await withBrowser(async (h) => {
  const r = report("pill padding vs rectangle padding");
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });

  await boot(page, pathUrl("/agents"), { settleMs: 1200 });
  const app = await probe(page, null, "md");
  r.ok("the app's own theme was measured", app !== null);
  if (app) {
    r.ok(
      "the app's theme sets no pill extra, so a pill pads like a rectangle",
      app.extra === 0 && app.pill[0] === app.rect[0],
      `extra ${app.extra}px, rect ${app.rect[0]}px, pill ${app.pill[0]}px`,
    );
  }

  await boot(page, pathUrl("/website"), {
    marker: "text=Curious how equin came to be?",
    settleMs: 800,
  });
  const site = await probe(page, '[data-theme-scope*="equin-document"]', "sm");
  r.ok("the website's document sub-theme was measured", site !== null);
  if (site) {
    r.ok(
      "the website sets a 6px pill extra over a 12px small control",
      site.extra === 6 && site.rect[0] === 12,
      `extra ${site.extra}px, rect ${site.rect.join("/")}px`,
    );
    r.ok(
      "a pill takes the extra on both ends",
      site.pill[0] === site.rect[0] + site.extra &&
        site.pill[1] === site.rect[1] + site.extra,
      `pill ${site.pill.join("/")}px`,
    );
    r.ok(
      "a split pill's first segment takes it on its start side only",
      site.start[0] === site.rect[0] + site.extra &&
        site.start[1] === site.rect[1],
      `first segment ${site.start.join("/")}px`,
    );
    r.ok(
      "a split pill's last segment takes it on its end side only",
      site.end[0] === site.rect[0] && site.end[1] === site.rect[1] + site.extra,
      `last segment ${site.end.join("/")}px`,
    );
  }

  await r.finish();
});
