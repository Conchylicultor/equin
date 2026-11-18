// Fan-out scoping verification for `page-block-doc:rows`
// (research/2026-08-25-global-own-row-resource-scoping.md). The routing is now
// the lookup-only `blockDocs` collection's point membership (an id set per
// mounted block) rather than `rowIdentity` — the same narrowing, spelled as a
// collection (research/2026-09-26-global-live-values-migration-contract.md §10).
//
// What this pins, in plain language:
//
//   A page is a stack of blocks, and each block's text lives in its own CRDT
//   document row. Today, saving ONE block's document wakes EVERY open block
//   editor in the app: each one re-reads its own row, finds nothing changed,
//   and sends no frame. The frames are right; the wasted reads are the bug.
//   The `page-block-doc` lookup-only collection's point membership narrows
//   *who gets woken* — the owning block only — and is supposed to change
//   nothing else.
//
//   An earlier attempt at that narrowing (point membership) was reverted after
//   a symptom nobody ever explained: open a page in a second browser window
//   while a first window already had it open, and the blocks came up EMPTY.
//   That is the thing this script exists to catch, because the existing suite
//   catches it only by accident and only sometimes — three sibling scripts
//   wait a fixed 5 seconds after the second window navigates, which is why
//   they flake on a loaded machine and why a real regression could hide behind
//   "probably just the flake". Every wait here is a bounded poll instead: it
//   returns as soon as the app is right, and only fails after it has genuinely
//   had long enough.
//
// The three arms:
//   (a) two windows on the SAME block both see a live edit to it;
//   (b) every OTHER block keeps its own text — in both windows, at rest and
//       while the first window is actively typing (sampled continuously, so a
//       block that blanks for half a second is still a failure);
//   (c) reloading the second window still shows the text. Once the fan-out is
//       gone this resource's version counter stops climbing on every keystroke
//       anywhere, so the server's "you are already up to date, here is no
//       value" reply — today almost unreachable — becomes routine on reconnect.
//       That is a previously-dead path going live for the editor (risk R2).
//       The FIRST window deliberately stays open across that reload, and that is
//       the whole point of the arm: the reply only fires for a subscriber
//       rejoining a resource entry that is still alive, which is also what the
//       old symptom needed ("a second window opening a page the first already
//       had open"). Closing the first window first would make this a cold reopen
//       — which is `crdt-reopen-verify`, and which passes either way, so it
//       cannot catch this.
//
// Usage: bun plugins/page/plugins/editor-collab/e2e/crdt-fanout-verify.ts [--url <deploy>] [--out <path>]
import type { Page } from "playwright";
import {
  agentFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { waitFor } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { openBlankPage, typeLines } from "@plugins/page/plugins/editor/e2e";
import { fetchBlockDoc } from "./support/ydoc";

const out = arg("out", "/tmp/crdt-fanout");

const r = report();

/** Distinctive per-block text: a block showing another block's words is visible at a glance. */
const BLOCK_TEXTS = [
  "alpha block one",
  "bravo block two",
  "charlie block three",
  "delta block four",
  "echo block five",
] as const;

/** The one block context A edits live; every other block is the control group. */
const TARGET_INDEX = 2;
const SUFFIX = " plus-live-edit";

interface DomBlock {
  id: string;
  text: string;
}

/** Every editable block's id and rendered text, in document order. */
function domBlocks(page: Page): Promise<DomBlock[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-block-id]")]
      .map((el) => ({
        id: el.getAttribute("data-block-id"),
        text:
          el.querySelector<HTMLElement>("[data-block-text]")?.innerText ?? null,
      }))
      .filter(
        (b): b is { id: string; text: string } =>
          b.id !== null && b.text !== null,
      )
      .map((b) => ({ id: b.id, text: b.text.replace(/ /g, " ").trim() })),
  );
}

/** The server-side `data.text` projection for every block of a page, by block id. */
async function projectedTexts(pageId: string): Promise<Map<string, string>> {
  const res = await agentFetch(`/api/pages/${pageId}/blocks`);
  if (!res.ok) {
    throw new Error(`GET /api/pages/${pageId}/blocks: HTTP ${res.status}`);
  }
  const rows = (await res.json()) as {
    id: string;
    data?: { text?: { text?: string }[] };
  }[];
  return new Map(
    rows.map((row) => [
      row.id,
      (row.data?.text ?? []).map((run) => run.text ?? "").join(""),
    ]),
  );
}

const textsOf = (blocks: readonly DomBlock[]): string[] =>
  blocks.map((b) => b.text);
const idsOf = (blocks: readonly DomBlock[]): string[] =>
  blocks.map((b) => b.id);
const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

await withBrowser(async (h) => {
  // --- 1. Context A authors several blocks -------------------------------------
  const { page: pageA, captured: capturedA } = await h.session({ label: "A" });

  const { pageUrl, pageId } = await openBlankPage(pageA, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl, "pageId:", pageId);

  await typeLines(pageA, BLOCK_TEXTS);

  // Settle on the DOM first (the local editor is the fastest truth), then on the
  // server: the ~300ms doc flush and the ~1s data.text projection both have to
  // land before a second context can possibly read the right thing.
  const authored = await waitFor(
    () => domBlocks(pageA),
    (blocks) => sameStrings(textsOf(blocks), [...BLOCK_TEXTS]),
  );
  r.ok(
    `context A authored ${BLOCK_TEXTS.length} blocks`,
    authored.ok,
    JSON.stringify(textsOf(authored.value)),
  );
  if (!authored.ok) {
    await snap(pageA, out, "fail-authored");
    await r.finish();
  }
  const blocks = authored.value;
  const blockIds = idsOf(blocks);
  const targetId = blockIds[TARGET_INDEX]!;
  console.log("block ids:", JSON.stringify(blockIds));
  console.log("target block:", targetId);

  const projected = await waitFor(
    () => projectedTexts(pageId),
    (byId) => blocks.every((b) => (byId.get(b.id) ?? "").trim() === b.text),
  );
  r.ok(
    "server data.text projection caught up for every block",
    projected.ok,
    JSON.stringify(blocks.map((b) => [b.id, projected.value.get(b.id)])),
  );
  r.note(
    `projection settled after ${projected.waitedMs}ms (${projected.attempts} reads)`,
  );

  // The CRDT rows themselves exist — otherwise arm (b) below would be asserting
  // that a second context correctly renders text that was never stored.
  // A condition wait, not one read: the doc rows are seeded per block by a
  // debounced flush, so the last block authored can legitimately have no row
  // yet at the instant the projection finishes. Read once and it fails on a
  // healthy app — which it did, before this was a wait.
  const docRows = await waitFor(
    async () => {
      const missing: string[] = [];
      for (const b of blocks) {
        const stored = await fetchBlockDoc(b.id);
        if (!stored) missing.push(`${b.id} ("${b.text}")`);
      }
      return missing;
    },
    (missing) => missing.length === 0,
  );
  r.ok(
    "every block has a page_block_docs row",
    docRows.value.length === 0,
    docRows.value.join("; "),
  );
  await snap(pageA, out, "1-authored-a");

  // --- 2. Arm (b): a SECOND browser context opens the same page ----------------
  // A genuinely separate context (own storage, own live-state socket), not a
  // second tab — a second tab shares the leader-elected socket, which is a
  // different code path and is not the one that regressed.
  const { page: pageB, captured: capturedB } = await h.session({ label: "B" });
  await pageB.goto(pageUrl, { waitUntil: "domcontentloaded" });

  const openedB = await waitFor(
    () => domBlocks(pageB),
    (seen) =>
      sameStrings(idsOf(seen), blockIds) &&
      sameStrings(textsOf(seen), [...BLOCK_TEXTS]),
  );
  r.ok(
    "arm (b) — a second context opening the page renders EVERY block's own text",
    openedB.ok,
    JSON.stringify(textsOf(openedB.value)),
  );
  r.note(
    `context B converged after ${openedB.waitedMs}ms (${openedB.attempts} reads)`,
  );
  if (!openedB.ok) await snap(pageB, out, "fail-second-context-open");
  await snap(pageB, out, "2-opened-b");

  // --- 3. Arm (a) + (b) under live write pressure ------------------------------
  // A types into ONE block. The other four must converge on nothing at all —
  // and must not flicker empty on the way there, which is what the sampler
  // below watches for. Only B is sampled: reading A's DOM in parallel with A's
  // own keystrokes would race the typing this arm depends on.
  const targetBlock = pageA
    .locator(`[data-block-id="${targetId}"] [data-block-text]`)
    .first();
  await targetBlock.click();
  await pageA.keyboard.press("End");

  const drift: string[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const seen = await domBlocks(pageB);
      if (!sameStrings(idsOf(seen), blockIds)) {
        drift.push(`block set/order changed: ${JSON.stringify(idsOf(seen))}`);
      }
      for (const [i, b] of seen.entries()) {
        if (b.id === targetId) continue;
        const want = BLOCK_TEXTS[blockIds.indexOf(b.id)];
        if (want !== undefined && b.text !== want) {
          drift.push(
            `block ${i} (${b.id}) showed ${JSON.stringify(b.text)}, want ${JSON.stringify(want)}`,
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  })();

  await pageA.keyboard.type(SUFFIX, { delay: 40 });

  const EXPECTED_AFTER = BLOCK_TEXTS.map((text, i) =>
    i === TARGET_INDEX ? text + SUFFIX : text,
  );

  const convergedA = await waitFor(
    () => domBlocks(pageA),
    (seen) => sameStrings(textsOf(seen), EXPECTED_AFTER),
  );
  const convergedB = await waitFor(
    () => domBlocks(pageB),
    (seen) => sameStrings(textsOf(seen), EXPECTED_AFTER),
  );

  sampling = false;
  await sampler;

  r.ok(
    "arm (a) — the writing context shows the edited block's new text",
    convergedA.value[TARGET_INDEX]?.text === EXPECTED_AFTER[TARGET_INDEX],
    JSON.stringify(convergedA.value[TARGET_INDEX]?.text),
  );
  r.ok(
    "arm (a) — the second context converges on the edited block",
    convergedB.value[TARGET_INDEX]?.text === EXPECTED_AFTER[TARGET_INDEX],
    JSON.stringify(convergedB.value[TARGET_INDEX]?.text),
  );
  r.note(
    `context B saw the edit after ${convergedB.waitedMs}ms (${convergedB.attempts} reads)`,
  );

  r.ok(
    "arm (b) — every other block kept its own text in the writing context",
    sameStrings(textsOf(convergedA.value), EXPECTED_AFTER),
    JSON.stringify(textsOf(convergedA.value)),
  );
  r.ok(
    "arm (b) — every other block kept its own text in the second context",
    sameStrings(textsOf(convergedB.value), EXPECTED_AFTER),
    JSON.stringify(textsOf(convergedB.value)),
  );
  r.ok(
    "arm (b) — no other block blanked, churned or reordered WHILE the edit was in flight",
    drift.length === 0,
    drift.slice(0, 6).join(" | "),
  );
  r.ok(
    "arm (b) — block order is identical in both contexts",
    sameStrings(idsOf(convergedA.value), blockIds) &&
      sameStrings(idsOf(convergedB.value), blockIds),
    `A=${JSON.stringify(idsOf(convergedA.value))} B=${JSON.stringify(idsOf(convergedB.value))}`,
  );
  if (drift.length > 0 || !convergedB.ok)
    await snap(pageB, out, "fail-live-edit-b");
  await snap(pageA, out, "3-edited-a");
  await snap(pageB, out, "3-edited-b");

  // --- 4. Arm (c): reload the second context -----------------------------------
  // The resubscribe path after a reload is where "same epoch, same version ⇒
  // up-to-date, no value" can now actually fire for this resource. If the client
  // ever mistook that reply for "the value is empty", this is where the text
  // would come back blank.
  await pageB.reload({ waitUntil: "domcontentloaded" });
  const reloadedB = await waitFor(
    () => domBlocks(pageB),
    (seen) =>
      sameStrings(idsOf(seen), blockIds) &&
      sameStrings(textsOf(seen), EXPECTED_AFTER),
  );
  r.ok(
    "arm (c) — after a reload the second context still shows every block's text",
    reloadedB.ok,
    JSON.stringify(textsOf(reloadedB.value)),
  );
  r.note(
    `context B re-hydrated after ${reloadedB.waitedMs}ms (${reloadedB.attempts} reads)`,
  );
  if (!reloadedB.ok) await snap(pageB, out, "fail-reload-b");
  await snap(pageB, out, "4-reloaded-b");

  // A blank render caused by a thrown component is a page error, not a wrong
  // string — assert both, or a crash reads as a plain text mismatch.
  r.ok(
    "no page errors in the writing context",
    capturedA.pageErrors.length === 0,
    capturedA.pageErrors.join("; "),
  );
  r.ok(
    "no page errors in the second context",
    capturedB.pageErrors.length === 0,
    capturedB.pageErrors.join("; "),
  );

  await r.finish();
});
