// Reads back the cursor the deployed app actually paints on its controls.
//
// This is the one thing a screenshot cannot show — Playwright's capture never
// draws the pointer — so the base-layer rule that hands every control its hand
// cursor is otherwise unverifiable except by hand.
//
// It walks the rendered page, groups every element by what the base rule
// classifies it as, and reports the computed `cursor` of each group. A control
// reading `default` is the regression this exists to catch; a `cursor-default`
// opt-out is reported separately rather than counted as one.
//
// Usage:
//   ./equin run plugins/primitives/plugins/css/plugins/ui-kit/e2e/control-cursor.ts
//   ./equin run …/control-cursor.ts --path /settings

import {
  pageUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/** What one control looked like to the browser. */
interface Sample {
  kind: string;
  cursor: string;
  label: string;
  optedOut: boolean;
}

// Whatever screen the caller names — this reads the controls that are on it,
// it does not know which app drew them. Home by default.
const url = pageUrl("/");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(url);
  await page.waitForTimeout(2500);

  const samples: Sample[] = await page.evaluate(() => {
    const out: {
      kind: string;
      cursor: string;
      label: string;
      optedOut: boolean;
    }[] = [];
    const CLICKABLE_INPUTS = new Set([
      "button",
      "checkbox",
      "color",
      "file",
      "radio",
      "range",
      "reset",
      "submit",
    ]);

    /** What the base rule calls this element, or null if it covers none. */
    const kindOf = (el: Element): string | null => {
      const tag = el.tagName.toLowerCase();
      if (el.getAttribute("role") === "button") return 'role="button"';
      if (tag === "button") return "<button>";
      if (tag === "summary") return "<summary>";
      if (tag === "select") return "<select>";
      if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        if (CLICKABLE_INPUTS.has(type)) return `<input type="${type}">`;
      }
      if (
        tag === "label" &&
        el.querySelector('input[type="checkbox"], input[type="radio"]')
      )
        return "<label> around a checkbox";
      return null;
    };

    for (const el of Array.from(document.querySelectorAll("*"))) {
      const kind = kindOf(el);
      if (kind === null) continue;
      // A control nobody can press says nothing about the rule.
      if ((el as HTMLButtonElement).disabled) continue;
      if (el.getAttribute("aria-disabled") === "true") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      out.push({
        kind,
        cursor: getComputedStyle(el).cursor,
        label: (el.getAttribute("aria-label") ?? el.textContent ?? "")
          .trim()
          .slice(0, 40),
        // An explicit opt-out is a decision, not a regression.
        optedOut: el.className.toString().includes("cursor-default"),
      });
    }
    return out;
  });

  const wrong = samples.filter((s) => !s.optedOut && s.cursor !== "pointer");
  const optedOut = samples.filter((s) => s.optedOut);

  const byKind = new Map<string, number>();
  for (const s of samples) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);

  const r = report(`control-cursor ${new URL(url).pathname}`);
  r.note(`${samples.length} controls on screen`);
  for (const [kind, n] of [...byKind].sort()) r.note(`  ${kind}: ${n}`);
  if (optedOut.length > 0)
    r.note(`opted out with cursor-default: ${optedOut.length}`);
  for (const s of wrong.slice(0, 20))
    r.note(`  ${s.cursor.padEnd(10)} ${s.kind} ${s.label}`);

  r.ok(
    "every control on screen shows the pointer cursor",
    wrong.length === 0,
    `${wrong.length} of ${samples.length} do not`,
  );
  await r.finish();
});
