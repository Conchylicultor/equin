// Reload drill: text typed into a page is there after a reload.
//
// Opens a fresh blank page, types two lines, waits for the surface's sync
// status to say Saved (the CRDT doc flush), and runs the reload drill
// (`e2e-harness` reload-drill.ts): the route, every block's text and the rest
// of what the page showed must come back. The text is server truth (the
// per-block CRDT), so this checks the page's place and its save path rather
// than browser storage. The page is trashed at the end.
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/reload-drill.ts [--no-record] [--headed] [--attach <ticket>]
import type { Page } from "playwright";
import {
  agentFetch,
  arg,
  onBeforeFinish,
  reloadDrill,
  reloadDrillText,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { blockText, editableBlocks, openBlankPage } from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const OUT = arg("out") ?? "/tmp/page-reload-drill";
const LINES = ["reload drill first line", "and a second one, still typing"];

/** The surface's sync cloud says everything typed is saved (not syncing, no error). */
async function waitSaved(page: Page): Promise<void> {
  await page
    .locator('[data-sync-phase="saved"]')
    .waitFor({ state: "attached", timeout: 30_000 });
  await page
    .locator('[data-sync-phase="syncing"]')
    .waitFor({ state: "detached", timeout: 30_000 });
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  const r = report("page editor: typed text survives a reload");
  const { pageId, pageUrl } = await openBlankPage(page);
  r.note(`page ${pageId} (${pageUrl})`);
  onBeforeFinish(async () => {
    const res = await agentFetch(`/api/blocks/${pageId}`, { method: "DELETE" });
    if (!res.ok)
      throw new Error(
        `trashing page ${pageId}: ${res.status} ${await res.text()}`,
      );
  });

  const drill = await reloadDrill(page, {
    step: async (p) => {
      await typeLines(p, LINES);
      await waitSaved(p);
    },
    restore: async (p) => {
      await editableBlocks(p)
        .first()
        .waitFor({ state: "visible", timeout: 60_000 });
    },
  });
  console.log(reloadDrillText(drill));
  await snap(page, OUT, "after-reload");

  const texts = await Promise.all(
    (await editableBlocks(page).all()).map((b) => blockText(b)),
  );
  r.ok(
    "every typed line is on the page after the reload",
    LINES.every((l) => texts.includes(l)),
    JSON.stringify(texts),
  );
  r.ok(
    "the reload gave everything back",
    drill.differences.length === 0 && drill.compared > 0,
    reloadDrillText(drill),
  );
  await r.finish();
});
