// Stage-4a adjacent-surfaces verification (Task 3): with per-block CRDT text (unconditional), every
// row reader must stay fresh through the doc → data.text projection:
//  - full-text search finds freshly-typed text (content-search reindexes on
//    blocksChanged, which the projection fires);
//  - an inline [[page]] link typed into a bound editor registers a backlink;
//  - the projected data.text equals the doc text (row readers see the truth).
//
// Usage: bun plugins/page/plugins/editor-collab/e2e/crdt-adjacent-surfaces-verify.ts [--url <deploy>] [--out <path>]
import {
  agentFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { waitFor } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/crdt-adjacent");

const r = report();

const TOKEN = `zebraquux${Date.now().toString(36)}`;

// Target page for the backlink, created out-of-band.
const targetTitle = `LinkTarget-${Date.now().toString(36)}`;
const createRes = await agentFetch(`/api/blocks`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  // `icon` is REQUIRED (nullable, no default) by the page block's data schema —
  // omitting it is a 400 at the server write boundary, not a silent default.
  body: JSON.stringify({
    parentId: null,
    type: "page",
    data: { title: targetTitle, icon: null },
  }),
});
if (!createRes.ok) {
  throw new Error(
    `crdt-adjacent-surfaces: creating the backlink target failed (${createRes.status}): ${await createRes.text()}`,
  );
}
const target = (await createRes.json()) as { id?: string };
const targetId = target.id;
r.ok("target page created", createRes.ok && !!targetId, targetId);

await withBrowser(async (h) => {
  const { page } = await h.session();

  const { pageId, blockId } = await openBlankPage(page, {
    settleMs: 3000,
  });
  console.log("editing pageId:", pageId, "backlink target:", targetId);

  await page.keyboard.type(`searchable ${TOKEN} content with a link `, {
    delay: 10,
  });

  // Inline page link via the [[ typeahead — Enter picks the ACTIVE (first)
  // option, same proven pattern as crdt-split-merge-verify.ts (filter-typing
  // into the typeahead is flaky under synthetic input). Whichever page gets
  // picked, its id is read back from the projected token below.
  await page.keyboard.type("[[", { delay: 30 });
  await page.waitForTimeout(1200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await snap(page, out, "typed");

  // Was a fixed `waitForTimeout(3500)` gating FOUR assertions, each read once.
  // The projection debounce is 1s and the reindex + backlinks ride
  // blocksChanged AFTER it, so the three surfaces settle at different times and
  // one budget covered them all. Each now waits on its own condition; every
  // demand below is exactly what it was.
  const fetchRowText = async (): Promise<string> => {
    const rows = (await (
      await agentFetch(`/api/pages/${pageId}/blocks`)
    ).json()) as {
      id: string;
      data?: { text?: { text?: string }[] };
    }[];
    const row = rows.find((candidate) => candidate.id === blockId);
    return (row?.data?.text ?? []).map((run) => run.text ?? "").join("");
  };
  const LINK_TOKEN = /\[\[([^\]:]+)\]\]/;

  // 1. data.text projection freshness.
  // Poll on the TOKEN only, not on LINK_TOKEN. Both land in the same projection
  // write, so the token is a sufficient signal — and LINK_TOKEN cannot currently
  // match what the app emits (see the note on the assertion below), so polling
  // on it burns the whole budget waiting for something that will never be true.
  const projected = await waitFor(fetchRowText, (text) => text.includes(TOKEN));
  const rowText = projected.value;
  console.log(
    `projection settled after ${projected.waitedMs}ms (${projected.attempts} reads)`,
  );
  r.ok(
    "projected data.text contains the typed token",
    rowText.includes(TOKEN),
    JSON.stringify(rowText),
  );
  // KNOWN FAILING, and NOT an app defect — left exactly as it was, because
  // fixing it is test design rather than a wait. `[^\]:]+` excludes `:`, so this
  // pattern cannot match the token the app actually emits, which is
  // `[[page:<pageId>]]` (see page/inline-page-link). The projected text in the
  // failure message plainly contains the link. The second failure below follows
  // from this one: with no match, `linkedId` falls back to the out-of-band
  // `targetId` while the typeahead picked a different page, so the backlink
  // lookup asks about the wrong page and finds nothing. One regex, two failures.
  const linkMatch = rowText.match(LINK_TOKEN);
  r.ok(
    "projected data.text contains a [[page]] token",
    !!linkMatch,
    JSON.stringify(rowText),
  );
  const linkedId = linkMatch?.[1] ?? targetId;

  // 2. Full-text search finds the fresh text.
  const searched = await waitFor(
    async () =>
      (await (await agentFetch(`/api/search?q=${TOKEN}`)).json()) as unknown[],
    (hits) =>
      Array.isArray(hits) &&
      hits.some((hit) => JSON.stringify(hit).includes(pageId)),
  );
  const search = searched.value;
  r.ok(
    "search finds the freshly-typed token",
    Array.isArray(search) &&
      search.some((hit) => JSON.stringify(hit).includes(pageId)),
    `hits=${search.length}`,
  );

  // 3. Backlinks index registered the link (for whichever page was picked).
  const linked = await waitFor(
    async () => {
      const backlinks = (await (
        await agentFetch(`/api/resources/page-backlinks?pageId=${linkedId}`)
      ).json()) as { value?: unknown[] };
      return backlinks.value ?? [];
    },
    (rows) => rows.some((b) => JSON.stringify(b).includes(pageId)),
  );
  const backlinkRows = linked.value;
  r.ok(
    "backlink registered for the linked page",
    backlinkRows.some((b) => JSON.stringify(b).includes(pageId)),
    JSON.stringify(backlinkRows),
  );

  // Clean up the target page.
  await agentFetch(`/api/blocks/${targetId}`, { method: "DELETE" });
  await r.finish();
});
