// Measures what flipping the page's input modality costs: the element count
// of the style recalc Chrome runs after `data-input-modality` changes on
// <html> (pointer ⇄ keyboard — what `InputModalityTracker` writes on every
// pointer press after keyboard use, and on every navigation key after pointer
// use). Elements restyled, not ms: the count does not drift with host load.
//
// With --counterfactual it then rewrites, in the page's own sheets, every rule
// reading the attribute into the given replacement form and measures again —
// a before/after on the same DOM without a rebuild.
//
// It first checks the rings still follow the modality: a control reached by
// Tab is ringed, not in pointer modality, and ringed again after.
//
// Usage:
//   ./equin run plugins/primitives/plugins/css/plugins/ui-kit/e2e/input-modality-flip-cost.ts \
//     [--path /agents] [--rounds 3] [--counterfactual] [--only <selector part>]
//     [--invalidations] [--url http://<namespace>.localhost:9000]
//
// --only: with --counterfactual, rewrite only the rules whose selector holds
//   this text and drop the others — the cost of each rule on its own.
// --invalidations: also trace Chrome's invalidation tracking and list what
//   was invalidated, and why (a whole subtree, or the rule's subjects).

import {
  arg,
  flag,
  numArg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const path = arg("path", "/agents");
const rounds = numArg("rounds", 3);
const counterfactual = flag("counterfactual");
const invalidations = flag("invalidations");

interface TraceEvent {
  name: string;
  ph: string;
  args?: {
    elementCount?: number;
    data?: { elementCount?: number } & Record<string, unknown>;
  };
}

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  await page.goto(pathUrl(path));
  await page.waitForTimeout(6000);
  const browser = page.context().browser();
  if (browser === null) throw new Error("no browser to trace");

  const info = await page.evaluate(() => {
    const rules: string[] = [];
    for (const sheet of [...document.styleSheets]) {
      let list: CSSRuleList;
      try {
        list = sheet.cssRules;
      } catch (err) {
        if (err instanceof DOMException) continue; // cross-origin sheet
        throw err;
      }
      const walk = (l: CSSRuleList) => {
        for (const r of [...l]) {
          if (
            r instanceof CSSStyleRule &&
            r.selectorText.includes("data-input-modality")
          )
            rules.push(r.selectorText);
          if ("cssRules" in r && r.cssRules instanceof CSSRuleList)
            walk(r.cssRules);
        }
      };
      walk(list);
    }
    return {
      elements: document.getElementsByTagName("*").length,
      ringed: document.querySelectorAll(
        ".focus-ring, .focus-ring-within, .focus-ring-from",
      ).length,
      rules,
    };
  });
  console.log(`elements: ${info.elements}, focus-ring hosts: ${info.ringed}`);
  for (const r of info.rules) console.log(`  rule: ${r}`);

  /** Elements restyled by the recalcs that follow one write to <html>. */
  const flip = async (
    to: "pointer" | "keyboard" | "baseline",
  ): Promise<number[]> => {
    await page.evaluate(() => document.body.offsetHeight);
    await browser.startTracing(page, {
      categories: [
        "devtools.timeline",
        ...(invalidations
          ? ["disabled-by-default-devtools.timeline.invalidationTracking"]
          : []),
      ],
    });
    await page.evaluate((mode) => {
      const root = document.documentElement;
      // The floor: an attribute no rule reads, written the same way.
      if (mode === "baseline") root.toggleAttribute("data-unread-probe");
      else if (mode === "pointer") root.dataset.inputModality = "pointer";
      else delete root.dataset.inputModality;
      void document.body.offsetHeight;
    }, to);
    const trace = await browser.stopTracing();
    const { traceEvents } = JSON.parse(trace.toString("utf8")) as {
      traceEvents: TraceEvent[];
    };
    if (invalidations) {
      const tally = new Map<string, number>();
      for (const e of traceEvents) {
        if (!e.name.endsWith("InvalidationTracking")) continue;
        const d: Record<string, unknown> = e.args?.data ?? {};
        const key =
          `${e.name} ${String(d.nodeName ?? "?")} ${JSON.stringify(d.reason ?? d.changedAttribute ?? d.invalidationSet ?? "")}`.slice(
            0,
            200,
          );
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1]).slice(0, 15))
        console.log(`    ${n} ${k}`);
    }
    return traceEvents
      .filter(
        (e) => e.name === "UpdateLayoutTree" && (e.ph === "X" || e.ph === "E"),
      )
      .map((e) => e.args?.elementCount ?? e.args?.data?.elementCount ?? 0)
      .filter((n) => n > 0);
  };

  const run = async (label: string) => {
    for (let i = 1; i <= rounds; i++) {
      const toPointer = await flip("pointer");
      const toKeyboard = await flip("keyboard");
      console.log(
        `${label} #${i}: keyboard→pointer restyled [${toPointer.join(", ")}], pointer→keyboard restyled [${toKeyboard.join(", ")}]`,
      );
    }
  };
  // The rings still answer the modality: Tab onto a `focus-ring` control —
  // ringed; the same focus in pointer modality — no ring; back — ringed.
  let ringed = false;
  for (let i = 0; i < 60 && !ringed; i++) {
    await page.keyboard.press("Tab");
    ringed = await page.evaluate(
      () => document.activeElement?.classList.contains("focus-ring") ?? false,
    );
  }
  if (!ringed)
    throw new Error("no focus-ring control reached by Tab within 60 presses");
  const outline = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el === null) throw new Error("focus left the page");
      return getComputedStyle(el).outlineStyle;
    });
  const keyboardRing = await outline();
  await page.evaluate(
    () => (document.documentElement.dataset.inputModality = "pointer"),
  );
  const pointerRing = await outline();
  await page.evaluate(
    () => delete document.documentElement.dataset.inputModality,
  );
  const backRing = await outline();
  console.log(
    `ring outline-style — keyboard: ${keyboardRing}, pointer: ${pointerRing}, keyboard again: ${backRing}`,
  );
  if (
    keyboardRing !== "solid" ||
    pointerRing !== "none" ||
    backRing !== "solid"
  )
    throw new Error("focus-ring does not follow the input modality");

  console.log(
    `floor (an attribute no rule reads): restyled [${(await flip("baseline")).join(", ")}]`,
  );
  await run("as deployed");

  if (!counterfactual) return;
  // Rewrite each `X:not(:where([data-input-modality="pointer"] *))` rule
  // into the positive ancestor form `:where(:root:not([…])) X` in place.
  const rewritten = await page.evaluate((only) => {
    const out: string[] = [];
    const negated = /:not\(:where\(\[data-input-modality="pointer"\] \*\)\)/g;
    const walk = (l: CSSRuleList) => {
      for (const r of [...l]) {
        if (r instanceof CSSStyleRule && negated.test(r.selectorText)) {
          negated.lastIndex = 0;
          if (only !== undefined && !r.selectorText.includes(only)) {
            r.selectorText = ".never-matches-probe";
            out.push(`dropped`);
            continue;
          }
          // Prefix once: the deployed rules hold no top-level comma (a
          // grouped rule is one `:is(…)`).
          r.selectorText = `:where(:root:not([data-input-modality="pointer"])) ${r.selectorText.replace(negated, "")}`;
          out.push(r.selectorText);
        }
        if ("cssRules" in r && r.cssRules instanceof CSSRuleList)
          walk(r.cssRules);
      }
    };
    for (const sheet of [...document.styleSheets]) {
      try {
        walk(sheet.cssRules);
      } catch (err) {
        if (!(err instanceof DOMException)) throw err;
      }
    }
    return out;
  }, arg("only"));
  for (const r of rewritten) console.log(`  rewritten: ${r}`);
  if (rewritten.length === 0)
    throw new Error(
      "--counterfactual: no rule holds the negated form to rewrite (already the positive form?) — nothing to compare",
    );
  await run("rewritten");
});
