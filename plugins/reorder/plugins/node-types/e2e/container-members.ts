/**
 * Regression guard for how a CONTAINER node type's pre-rendered members are
 * wrapped by the list middleware.
 *
 * The middleware wraps each member in a key-carrying `<span>`. That span is
 * `display:contents` so it is not a layout box between a container and its
 * member — which is what lets the `overflow` container's members be real
 * children of `DropdownMenuContent`. The same span is on the `header` path, so
 * this asserts the older container still paints its members.
 *
 * The page editor's block menu is the `header` container's real consumer: its
 * committed layout (`config/page/editor/page.editor.block.jsonc`) is four
 * labelled groups.
 *
 *   ./singularity run plugins/reorder/plugins/node-types/e2e/container-members.ts --headed
 */
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const OUT = arg("out") ?? "/tmp/reorder-containers";

/** The group labels the committed `page.editor.block` layout authors. */
const GROUPS = ["Basic blocks", "Media", "Advanced", "Annotations"];

await withBrowser(async (h) => {
  const r = report("reorder — header container renders its members");
  const { page, captured } = await h.session();

  // A fresh blank page, never one of the user's: summoning the menu types a
  // "/" into the document, and in an existing page that edit outlives the run
  // (a run killed before removing it left a "/" that stopped the next run's
  // menu from opening).
  await openBlankPage(page);
  await page.keyboard.type("/");

  // The menu is the caret-anchored block picker; wait for its first group label.
  const menu = page.getByText(GROUPS[0]!, { exact: true }).first();
  await menu.waitFor({ state: "visible", timeout: 15_000 });
  await snap(page, OUT, "block-menu");

  for (const label of GROUPS) {
    const count = await page.getByText(label, { exact: true }).count();
    r.ok(`group "${label}" renders`, count > 0);
  }

  // The point of the guard: a group's MEMBERS must still paint. "Text" is the
  // first member of "Basic blocks" in the committed layout.
  r.ok(
    "container members still render inside their group",
    (await page.getByText("Text", { exact: true }).count()) > 0,
    "a header group painted its label but no members",
  );

  const errors = [...captured.pageErrors, ...captured.consoleErrors];
  r.ok("no page or console errors", errors.length === 0, errors.join("\n"));
  await r.finish();
});
