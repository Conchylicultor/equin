// Verifies frame A's option pick is the prototype's SHARED, live record
// (`prototypes.picks`, an optimistic liveValue): picking a value answers at
// once, survives a reload, and a second browser context opens on it. Pins the
// no-stand-in rule too: from the first frame after the reload, frame A's
// document is never opened on any value but the pick — the record is pending
// (a loading state) until read, never the page's defaults swapped out later.
// Manual only — nothing runs this automatically. The harness reverts what this
// run wrote to the shared record.
//
// Usage:
//   ./equin run plugins/apps/plugins/prototypes/plugins/canvas/e2e/canvas-picks-persist.ts \
//     [--name <prototype id>] [--out <prefix>] [--headed]

import type { Page } from "playwright";
import {
  arg,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { humanizeToken } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { canvasFrameSelector } from "@plugins/apps/plugins/prototypes/plugins/canvas/core";
import {
  dismiss,
  frameValue,
  openCanvas,
  openOptions,
  pickPrototype,
  pickValue,
  spreadableOption,
} from "./driver";

/**
 * The prototype's shared picks record as the server reads it now (`{}` when
 * none), through the resource's HTTP read — the same loader every tab gets.
 */
async function readStoredPicks(
  page: Page,
  name: string,
): Promise<Record<string, string>> {
  return page.evaluate(async (n: string) => {
    const res = await fetch(
      `/api/resources/prototypes.picks?${new URLSearchParams({ name: n }).toString()}`,
      { cache: "no-store" },
    );
    if (!res.ok) throw new Error(`prototypes.picks read: HTTP ${res.status}`);
    const body = (await res.json()) as { value: Record<string, string> };
    return body.value;
  }, name);
}

const out = arg("out", "/tmp/canvas-picks-persist");
const meta = await pickPrototype();
const option = spreadableOption(meta);
const label = humanizeToken(option.name);

/**
 * Records, from the document's first script on, the `src` of every iframe ever
 * attached (or re-pointed) inside frame A — so a stand-in document that lived
 * for one frame is still seen.
 */
function recordFrameASrcs(selector: string): void {
  const seen: string[] = [];
  (window as unknown as { __frameASrcs: string[] }).__frameASrcs = seen;
  const note = (el: Element) => {
    if (el.tagName !== "IFRAME" || !el.closest(selector)) return;
    const src = el.getAttribute("src");
    if (src && seen.at(-1) !== src) seen.push(src);
  };
  new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === "attributes") note(rec.target as Element);
      for (const node of rec.addedNodes) {
        if (!(node instanceof Element)) continue;
        note(node);
        node.querySelectorAll("iframe").forEach(note);
      }
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src"],
  });
}

await withBrowser(async (h) => {
  const r = report(
    `canvas picks persist — ${meta.title} (${meta.name}), option ${option.name}`,
  );
  const { page, captured } = await h.session({
    viewport: { width: 1600, height: 1000 },
  });
  await openCanvas(page, meta.name);

  const before = await frameValue(page, meta, "A", option.name);
  if (before === null) throw new Error("frame A has no document");
  const target = option.values.find((v) => v !== before);
  if (!target) throw new Error(`${option.name} has no value besides ${before}`);
  console.log(`frame A: ${option.name}=${before} → picking ${target}`);

  const popover = await openOptions(page, "A");
  await pickValue(popover, label, humanizeToken(target));
  await dismiss(page);
  const picked = await waitFor(
    () => frameValue(page, meta, "A", option.name),
    (v) => v === target,
    { timeoutMs: 10_000 },
  );
  r.ok("the pick answers in frame A", picked.ok, picked.value ?? undefined);
  // The pick is confirmed once the shared record on disk carries it.
  const stored = await waitFor(
    () => readStoredPicks(page, meta.name),
    (p) => p[option.name] === target,
    { timeoutMs: 10_000 },
  );
  r.ok(
    "the shared record stores the pick",
    stored.ok,
    JSON.stringify(stored.value),
  );
  await snap(page, out, "picked");

  await page.addInitScript(
    recordFrameASrcs,
    canvasFrameSelector({ letter: "A" }),
  );
  await page.reload();
  const reloaded = await waitFor(
    () => frameValue(page, meta, "A", option.name),
    (v) => v !== null,
    { timeoutMs: 20_000 },
  );
  r.eq("after a reload frame A shows the pick", reloaded.value, target);
  const srcs = await page.evaluate(
    () => (window as unknown as { __frameASrcs: string[] }).__frameASrcs,
  );
  const values = srcs.map(
    (src) =>
      new URL(src, "http://x").searchParams.get(option.name) ?? option.default,
  );
  console.log(`frame A documents since reload: ${JSON.stringify(values)}`);
  r.ok(
    "no stand-in: every frame-A document since the reload carried the pick",
    values.length > 0 && values.every((v) => v === target),
    JSON.stringify(values),
  );
  await snap(page, out, "reloaded");

  const second = await h.session({ viewport: { width: 1600, height: 1000 } });
  await openCanvas(second.page, meta.name);
  const other = await waitFor(
    () => frameValue(second.page, meta, "A", option.name),
    (v) => v === target,
    { timeoutMs: 10_000 },
  );
  r.ok(
    "a second browser context opens on the pick",
    other.ok,
    other.value ?? undefined,
  );
  await snap(second.page, out, "second-context");
  r.ok(
    "no page errors",
    captured.pageErrors.length === 0 && second.captured.pageErrors.length === 0,
    [...captured.pageErrors, ...second.captured.pageErrors].join(" | "),
  );
  await r.finish();
});
