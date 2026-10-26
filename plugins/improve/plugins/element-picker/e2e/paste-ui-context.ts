// E2E verification: pasting a `<ui-context …>` tag into the Improve prompt
// lands as the rich chip, not literal text.
//
// Flow: open the app → open the Improve popover → focus the editor → fire a
// real paste event carrying the tag as text/plain → assert the chip rendered
// (and that no literal "<ui-context" text survived in the editor).
//
// Usage: bun plugins/improve/plugins/element-picker/e2e/paste-ui-context.ts [--url <deploy>] [--headed]
import {
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/paste-ui-context";

// A representative capture — exactly what the element picker hands over and
// what the user copies out of a prompt.
const TAG =
  '<ui-context url="http://equin.localhost:9000/agents" plugin="improve" ' +
  'slot="action-bar.item" contribution="improve:improve" selector="div>div>span" ' +
  'source="plugins/improve/web/components/improve-button.tsx:16">' +
  "<hint>picked in the live app</hint><picked-content>Improve</picked-content></ui-context>";

await withBrowser(async (h) => {
  const { page } = await h.session();

  await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });

  // 1. The action bar floats collapsed at the top-right — hover to reveal it,
  //    then open the Improve popover and focus its prompt editor.
  // The action bar floats collapsed at the top-right unless it is pinned into
  // the tab bar: the floating one is hovered open, the pinned one is already.
  const bar = page.locator('[data-source*="floating-action"]').first();
  const revealBar = async () => {
    if (await bar.isVisible()) await bar.hover();
  };
  await page
    .getByRole("button", { name: "Wish" })
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
  await revealBar();
  const improve = page.getByRole("button", { name: "Wish" }).first();
  await improve.waitFor({ state: "visible", timeout: 10_000 });
  await improve.click();
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ state: "visible", timeout: 10_000 });
  await editor.click();
  await page.keyboard.type("please fix ");

  // 2. A genuine paste: a ClipboardEvent carrying the tag as text/plain, which
  //    is exactly what the browser dispatches on Cmd+V.
  await editor.evaluate((el, tag) => {
    const data = new DataTransfer();
    data.setData("text/plain", tag);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, TAG);
  await page.waitForTimeout(600);
  await snap(page, OUT, "pasted");

  // 3. The chip renders (its label is the picked element's content) and no raw
  //    tag text survived anywhere in the editor.
  // The chip is a non-editable inline decorator inside the contenteditable.
  const chips = await editor.locator('button[contenteditable="false"]').count();
  const editorText = (await editor.innerText()).trim();

  const r = report("element-picker: paste <ui-context> as chip");
  r.note(`editor text: ${JSON.stringify(editorText)}`);
  r.note(`editor html: ${await editor.innerHTML()}`);
  r.ok("chip rendered", chips > 0, `chips=${chips}`);
  r.ok(
    "no literal tag left in the editor",
    !editorText.includes("<ui-context"),
  );
  r.ok("surrounding text preserved", editorText.startsWith("please fix"));
  await r.finish();
});
