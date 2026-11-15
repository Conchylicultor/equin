// Stage-4a doc-init ordering-race verification
// (research/2026-07-07-page-per-block-crdt-plan-b.md, Task 1).
//
// With per-block CRDT text (now unconditional — the flag is deleted):
//  1. create a blank page and drive FAST create-block + split-block sequences —
//     Enter immediately followed by typing in the freshly-minted block, i.e.
//     the editor mounts from the optimistic overlay BEFORE the structural op's
//     POST has created the `_blocks` row (the exact doc-init FK race);
//  2. assert NO doc-init / doc-update / blocks request ever returns >= 400
//     (previously: FK violation → 500 → wedged initStarted latch);
//  3. assert EVERY block ends up with a `page_block_docs` row whose decoded
//     Yjs state matches the DOM text (the latch never wedged — buffered
//     keystrokes flushed after the gated seed);
//  4. assert `data.text` (the projection) converges to the same text;
//  5. open a second browser context and assert it converges.
//
// Usage: bun plugins/page/plugins/editor-collab/e2e/crdt-newblock-verify.ts [--url <deploy>] [--out <path>]
import {
  agentFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { waitFor } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { openBlankPage, typeLines } from "@plugins/page/plugins/editor/e2e";
import { blockDocText, fetchBlockDoc } from "./support/ydoc";

const out = arg("out", "/tmp/crdt-newblock");

const r = report();

await withBrowser(async (h) => {
  const { page: pageA, captured } = await h.session({ label: "A" });
  const pageErrors = captured.pageErrors;

  const badResponses: string[] = [];
  pageA.on("response", (res) => {
    const url = res.url();
    if (!/\/api\/(blocks|pages)/.test(url)) return;
    if (res.status() >= 400) {
      badResponses.push(`${res.status()} ${res.request().method()} ${url}`);
      console.log("BAD RESPONSE:", res.status(), res.request().method(), url);
    }
  });

  const { pageUrl, pageId } = await openBlankPage(pageA, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl, "pageId:", pageId);

  // --- The race: rapid Enter-then-type chains ---------------------------------
  // Each Enter dispatches a split op minting a new block and typing begins in it
  // immediately — no settle at all, i.e. far inside the structural-op round-trip
  // + confirm-push + doc-init window (the FK race Stage 4a gates). Landing those
  // keystrokes in the NEW block rather than the origin is the caret authority's
  // job, gated by `@plugins/page/plugins/editor`'s `e2e/split-typing-verify.ts`;
  // what this script adds on top is that the doc-init seed survives the same
  // window.
  const LINES = [
    "alpha one",
    "bravo two",
    "charlie three",
    "delta four",
  ] as const;
  await typeLines(pageA, LINES);
  // Mid-text split: caret placed mid-word, then Enter and immediate typing in
  // the tail-seeded new block.
  await typeLines(pageA, ["splitXtail"], { leadingEnter: true });
  // Lexical absorbs native caret moves via selectionchange, which lags a
  // zero-delay synthetic arrow burst (same caveat as crdt-split-merge-verify).
  for (let i = 0; i < "Xtail".length; i++) {
    await pageA.keyboard.press("ArrowLeft");
    await pageA.waitForTimeout(50);
  }
  await typeLines(pageA, ["typed-immediately-"], { leadingEnter: true });

  // Was a fixed `waitForTimeout(3500)` covering the flush debounce (300ms), the
  // projection debounce (1s) and the pushes — then ONE read of each. Measured
  // against main, it is not enough: the last block typed had not rendered yet,
  // so DOM reported five blocks instead of six and DOCS reported two rows
  // "never created" that appeared moments later. Three condition waits now,
  // asserting exactly what they asserted before.
  interface DomBlock {
    id: string;
    text: string;
  }
  const readDom = (): Promise<DomBlock[]> =>
    pageA.evaluate(() => {
      return [...document.querySelectorAll("[data-block-id]")]
        .map((el) => ({
          id: el.getAttribute("data-block-id"),
          text:
            el.querySelector<HTMLElement>('[contenteditable="true"]')
              ?.innerText ?? null,
        }))
        .filter(
          (b): b is { id: string; text: string } =>
            b.text !== null && b.id !== null,
        );
    });

  const EXPECTED = [...LINES, "split", "typed-immediately-Xtail"];
  const domText = (b: DomBlock): string => b.text.replace(/ /g, " ").trim();
  const dom = await waitFor(
    readDom,
    (blocks) =>
      JSON.stringify(blocks.map(domText)) === JSON.stringify(EXPECTED),
  );
  const domBlocks = dom.value;
  console.log("DOM blocks:", JSON.stringify(domBlocks, null, 1));
  console.log(`DOM settled after ${dom.waitedMs}ms (${dom.attempts} reads)`);
  await snap(pageA, out, "a");
  r.eq("DOM", domBlocks.map(domText), EXPECTED);

  // Server truth 1: every block has a page_block_docs row whose decoded state
  // matches the DOM (proves the seed happened AND the buffered typing flushed).
  const checkDocs = async (): Promise<string[]> => {
    const problems: string[] = [];
    for (const b of domBlocks) {
      // fetchBlockDoc (not fetchBlockDocText) — this assertion needs to tell
      // "no row at all" apart from "row whose text is empty".
      const stored = await fetchBlockDoc(b.id);
      if (!stored) {
        problems.push(
          `DOC MISSING for block ${b.id} ("${b.text}") — page_block_docs row never created`,
        );
        continue;
      }
      const docText = blockDocText(stored.state);
      const want = domText(b);
      if (docText.trim() !== want) {
        problems.push(
          `DOC MISMATCH for block ${b.id}: doc="${docText}" dom="${want}"`,
        );
      }
    }
    return problems;
  };
  const docs = await waitFor(checkDocs, (problems) => problems.length === 0);
  for (const problem of docs.value) console.log(problem);
  r.ok(
    "DOCS — every block has a converged page_block_docs row",
    docs.value.length === 0,
  );

  // Server truth 2: the data.text projection converged too.
  const checkProjection = async (): Promise<string[]> => {
    const rows = (await (
      await agentFetch(`/api/pages/${pageId}/blocks`)
    ).json()) as {
      id: string;
      data?: { text?: { text?: string }[] };
    }[];
    const rowTextById = new Map(
      rows.map((row) => [
        row.id,
        (row.data?.text ?? []).map((run) => run.text ?? "").join(""),
      ]),
    );
    const problems: string[] = [];
    for (const b of domBlocks) {
      const want = domText(b);
      const got = (rowTextById.get(b.id) ?? "<row missing>").trim();
      if (got !== want) {
        problems.push(
          `PROJECTION MISMATCH for ${b.id}: data.text="${got}" dom="${want}"`,
        );
      }
    }
    return problems;
  };
  const projection = await waitFor(
    checkProjection,
    (problems) => problems.length === 0,
  );
  for (const problem of projection.value) console.log(problem);
  r.ok(
    "PROJECTION — data.text agrees for every block",
    projection.value.length === 0,
  );

  // Convergence: a second, fresh browser context.
  const { page: pageB } = await h.session({ label: "B" });
  await pageB.goto(pageUrl);
  // Was a fixed `waitForTimeout(5000)`. A second context measured 6.2-6.4s to
  // render against main on an IDLE machine, so this read landed before the
  // blocks had text and CONVERGENCE reported `["","","","","",""]` — the clock,
  // not the app. The assertion below is unchanged; only WHEN it reads is.
  const readB = async (): Promise<string[]> =>
    (
      await pageB.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLElement>(
            '[data-block-id] [contenteditable="true"]',
          ),
        ].map((el) => el.innerText),
      )
    ).map((t) => t.replace(/ /g, " ").trim());
  const convergedB = await waitFor(
    readB,
    (texts) => JSON.stringify(texts) === JSON.stringify(EXPECTED),
  );
  const bTexts = convergedB.value;
  console.log(
    `context B converged after ${convergedB.waitedMs}ms (${convergedB.attempts} reads)`,
  );
  await snap(pageB, out, "b");
  r.eq("CONVERGENCE", bTexts, EXPECTED);

  r.ok(
    "HTTP — no >=400 on any blocks/doc endpoint",
    badResponses.length === 0,
    badResponses.join("; "),
  );
  r.ok("NO PAGE ERRORS", pageErrors.length === 0, pageErrors.join("; "));

  await r.finish();
});
