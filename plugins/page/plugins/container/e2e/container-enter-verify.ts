// Enter inside a container never splits the container.
//
// A container (callout, quote, …) is an ANCHOR whose content is its children.
// Enter on an EMPTY child steps out of the box only when nothing follows it in
// the box; anywhere else it is an ordinary split that mints another empty line
// inside the box. The bug this guards: an empty line in the MIDDLE of a callout
// took the generic empty-Enter outdent rung, whose `outdentOne` adopts the
// followers — the box ended above the caret and the lines below were re-nested
// under the escaped line, which painted as a SECOND callout.
//
//  1. MIDDLE (text): callout [aaa, ∅, bbb], Enter on ∅ → [aaa, ∅, ∅, bbb], all
//     inside the one callout.
//  2. MIDDLE (bullet): the same with bulleted-list children — the type with an
//     empty-Enter break-out policy, which used to reach the outdent rung. Enter
//     turns it into text in place, the next Enter splits; neither leaves the box.
//  3. LAST: callout [aaa], Enter at the end of aaa → [aaa, ∅] inside; Enter
//     again → ∅ leaves the box as the callout's next sibling, aaa stays inside.
//
// Usage: ./equin run plugins/page/plugins/container/e2e/container-enter-verify.ts [--out /tmp/container-enter]
import {
  pageFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/container-enter");
const r = report();

interface Row {
  id: string;
  parentId: string | null;
  type: string;
  rank: string;
  data: { text?: { text: string }[] };
}

async function rows(page: Page, pageId: string): Promise<Row[]> {
  const res = await pageFetch(page, `/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`GET blocks ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

/** `parentId`'s children in rank order, each as its type + text. */
function childLines(all: Row[], parentId: string): string[] {
  return all
    .filter((b) => b.parentId === parentId)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((b) => `${b.type}:${(b.data.text ?? []).map((t) => t.text).join("")}`);
}

async function caretInto(page: Page, blockId: string): Promise<void> {
  const editable = page
    .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
    .first();
  const box = await editable.boundingBox();
  if (!box) throw new Error(`no editable for ${blockId}`);
  // Past the last glyph lands at the end (an empty line's only position).
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await page.waitForTimeout(400);
}

async function enter(page: Page): Promise<void> {
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });
  const { pageId } = await openBlankPage(page, { settleMs: 3000 });

  const seeded = await (async () => {
    const post = async (body: unknown) => {
      const res = await pageFetch(page, "/api/blocks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new Error(`POST /api/blocks ${res.status}: ${await res.text()}`);
      return ((await res.json()) as { id: string }).id;
    };
    const callout = () =>
      post({
        parentId: pageId,
        type: "callout",
        data: { icon: null, color: "info" },
      });
    const line = (parentId: string, type: string, body: string) =>
      post({
        parentId,
        type,
        data: { text: body ? [{ text: body }] : [] },
      });

      const c1 = await callout();
      await line(c1, "text", "aaa");
      const c1Empty = await line(c1, "text", "");
      await line(c1, "text", "bbb");
      await line(pageId, "text", "between 1");

      const c2 = await callout();
      await line(c2, "bulleted-list", "aaa");
      const c2Empty = await line(c2, "bulleted-list", "");
      await line(c2, "bulleted-list", "bbb");
      await line(pageId, "text", "between 2");

      const c3 = await callout();
      const c3Only = await line(c3, "text", "aaa");
      await line(pageId, "text", "the end");
      return { c1, c1Empty, c2, c2Empty, c3, c3Only };
  })();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator(`[data-block-id="${seeded.c3Only}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "0-seeded");

  const calloutCount = (all: Row[]) =>
    all.filter((b) => b.type === "callout").length;
  const before = calloutCount(await rows(page, pageId));

  // --- 1. middle, text ------------------------------------------------------
  await caretInto(page, seeded.c1Empty);
  await enter(page);
  let all = await rows(page, pageId);
  r.ok(
    "middle text: the callout keeps every line, plus one more empty line",
    JSON.stringify(childLines(all, seeded.c1)) ===
      JSON.stringify(["text:aaa", "text:", "text:", "text:bbb"]),
    JSON.stringify(childLines(all, seeded.c1)),
  );
  r.ok(
    "middle text: no callout was minted",
    calloutCount(all) === before,
    `${before} → ${calloutCount(all)}`,
  );
  await snap(page, out, "1-middle-text");

  // --- 2. middle, bullet ----------------------------------------------------
  // The list's own type escape still comes first (the empty bullet becomes
  // text, in place); the next Enter splits. Neither leaves the box.
  await caretInto(page, seeded.c2Empty);
  await enter(page);
  all = await rows(page, pageId);
  r.ok(
    "middle bullet: the first Enter turns the empty bullet into text, in the box",
    JSON.stringify(childLines(all, seeded.c2)) ===
      JSON.stringify(["bulleted-list:aaa", "text:", "bulleted-list:bbb"]),
    JSON.stringify(childLines(all, seeded.c2)),
  );
  await enter(page);
  all = await rows(page, pageId);
  r.ok(
    "middle bullet: the second Enter mints another empty line in the box",
    JSON.stringify(childLines(all, seeded.c2)) ===
      JSON.stringify([
        "bulleted-list:aaa",
        "text:",
        "text:",
        "bulleted-list:bbb",
      ]),
    JSON.stringify(childLines(all, seeded.c2)),
  );
  r.ok(
    "middle bullet: no callout was minted",
    calloutCount(all) === before,
    `${before} → ${calloutCount(all)}`,
  );
  await snap(page, out, "2-middle-bullet");

  // --- 3. last line: Enter, Enter → out ---------------------------------------
  await caretInto(page, seeded.c3Only);
  await enter(page);
  all = await rows(page, pageId);
  r.ok(
    "last: the first Enter mints an empty line INSIDE the callout",
    JSON.stringify(childLines(all, seeded.c3)) ===
      JSON.stringify(["text:aaa", "text:"]),
    JSON.stringify(childLines(all, seeded.c3)),
  );
  await enter(page);
  all = await rows(page, pageId);
  const top = childLines(all, pageId);
  const c3Index = all
    .filter((b) => b.parentId === pageId)
    .sort((a, b) => (a.rank < b.rank ? -1 : 1))
    .findIndex((b) => b.id === seeded.c3);
  r.ok(
    "last: the second Enter moves the empty line OUT, right after the callout",
    JSON.stringify(childLines(all, seeded.c3)) ===
      JSON.stringify(["text:aaa"]) && top[c3Index + 1] === "text:",
    `inside=${JSON.stringify(childLines(all, seeded.c3))} top=${JSON.stringify(top)}`,
  );
  await snap(page, out, "3-last");
  await r.finish();
});
