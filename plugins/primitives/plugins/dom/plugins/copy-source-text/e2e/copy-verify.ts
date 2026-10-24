/**
 * Copies a paragraph containing an active-data chip out of a real transcript and
 * compares what the browser WOULD have put on the clipboard against what the
 * handler actually writes.
 *
 * The copy is a synthetic `ClipboardEvent` carrying its own `DataTransfer`, so
 * the payload is readable without clipboard permissions — the handler is a plain
 * document listener and cannot tell the difference.
 *
 *   ./equin run plugins/primitives/plugins/dom/plugins/copy-source-text/e2e/copy-verify.ts \
 *     --conv <id>
 *
 * FIXTURE: pass a conversation whose transcript renders an active-data chip
 * (`att-…` / `conv-…` / a backticked plugin name) in prose. The view is
 * windowed and opens at the bottom, so a chip further up is not on the page and
 * the run fails with "no in-prose chip" — that is a wrong fixture, not a
 * regression. The failure line prints how many declaring elements were found.
 */
import {
  arg,
  pathUrl,
  report,
  requireArg,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

interface Probe {
  chips: number;
  declared: string | null;
  handled: boolean;
  nativeText: string;
  copiedText: string;
  copiedHtml: number;
  selectionRestored: boolean;
  stagesLeftBehind: number;
}

const r = report("copy-source-text");
const conv = requireArg(
  "conv",
  "copy-verify.ts --conv <conversation-id whose transcript shows an active-data chip>",
);

await withBrowser(async (harness) => {
  const { page } = await harness.session();
  await page.goto(pathUrl(`/agents/c/${conv}`), {
    waitUntil: "domcontentloaded",
  });

  const settled = await waitFor(
    () =>
      page.evaluate((): Probe | null => {
        // A chip that SUBSTITUTED something (non-empty declaration), sitting in
        // running text — not a status badge alone in a cell. "Running text" is
        // the nearest ancestor carrying meaningfully more text than the chip
        // itself, which covers markdown <p> and the plain-text walker's <div>
        // alike without naming either.
        const all = [...document.querySelectorAll("[data-copy-text]")];
        const substituting = all.filter(
          (c) => (c.getAttribute("data-copy-text") ?? "") !== "",
        );
        let chip: Element | undefined;
        let paragraph: Element | undefined;
        for (const candidate of substituting) {
          const own = (candidate.textContent ?? "").length;
          let host = candidate.parentElement;
          while (host && (host.textContent ?? "").length < own + 20) {
            host = host.parentElement;
          }
          if (host && host !== document.body) {
            chip = candidate;
            paragraph = host;
            break;
          }
        }
        if (!chip || !paragraph) {
          return {
            chips: all.length,
            declared: null,
            handled: false,
            nativeText: `<no in-prose chip: ${all.length} declaring, ${substituting.length} substituting>`,
            copiedText: "",
            copiedHtml: 0,
            selectionRestored: true,
            stagesLeftBehind: 0,
          };
        }

        const selection = window.getSelection()!;
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        selection.addRange(range);
        const nativeText = selection.toString();

        const transfer = new DataTransfer();
        const event = new ClipboardEvent("copy", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        });
        paragraph.dispatchEvent(event);

        return {
          chips: all.length,
          declared: chip.getAttribute("data-copy-text"),
          handled: event.defaultPrevented,
          nativeText,
          copiedText: transfer.getData("text/plain"),
          copiedHtml: transfer.getData("text/html").length,
          selectionRestored: window.getSelection()?.toString() === nativeText,
          stagesLeftBehind: document.querySelectorAll(
            "body > div[aria-hidden='true'][style*='-99999px']",
          ).length,
        };
      }),
    (v) => v !== null && v.declared !== null,
  );

  const probe = settled.value;
  if (!probe || probe.declared === null) {
    r.fail(
      "an in-prose chip is on the page",
      `waited ${settled.waitedMs}ms — ${probe?.nativeText ?? "page never probed"}`,
    );
    await r.finish();
    return;
  }

  const declared = probe.declared;
  const newlines = (s: string) => (s.match(/\n/g) ?? []).length;

  r.note(`${probe.chips} declaring elements on the page`);
  r.note(`declared source  ${JSON.stringify(declared)}`);
  r.note(`native copy      ${JSON.stringify(probe.nativeText)}`);
  r.note(`handled copy     ${JSON.stringify(probe.copiedText)}`);

  r.ok("the handler claimed the copy", probe.handled);
  r.ok(
    "the source text is back",
    probe.copiedText.includes(declared),
    `no ${JSON.stringify(declared)} in ${JSON.stringify(probe.copiedText)}`,
  );
  r.eq("no newlines left in the sentence", newlines(probe.copiedText), 0);
  r.ok(
    "the native copy really was broken",
    newlines(probe.nativeText) > 0,
    "nothing to fix here — the chip did not split the line",
  );
  r.ok("the html flavour was written too", probe.copiedHtml > 0);
  r.ok("the user's selection survived", probe.selectionRestored);
  r.eq("no off-screen stage left behind", probe.stagesLeftBehind, 0);

  if (arg("shot")) await page.screenshot({ path: arg("shot")! });
});

await r.finish();
