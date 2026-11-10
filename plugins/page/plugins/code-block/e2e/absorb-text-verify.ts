// A line converted into a code block keeps its words as the block's code
// (`BlockHandle.absorbText`), instead of the old behaviour: an empty code block
// and the line's text deleted.
//
// Phases:
//   1. typing ``` at the START of a line that already holds text converts it,
//      and the code block holds that text;
//   2. `/code` at the end of a line converts it, and the code block holds the
//      line's text WITHOUT the `/code` query (its strip lands after the commit);
//   3. it survives a reload (the row, not just the optimistic view).
//
// Usage: ./equin run plugins/page/plugins/code-block/e2e/absorb-text-verify.ts [--url <deploy>]
import {
  ELEMENT_TIMEOUT_MS,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const r = report();

const FIRST = "const answer = 42";
const SECOND = "print(answer)";

await withBrowser(async (h) => {
  const { page } = await h.session();
  await openBlankPage(page, { settleMs: 3000 });

  const codes = (): Promise<string[]> =>
    page
      .locator("[data-block-id] textarea")
      .evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value));

  // ---- 1: ``` typed before existing words ----------------------------------
  await page.keyboard.type(FIRST);
  await page.keyboard.press("Home");
  await page.keyboard.type("```");
  await page
    .locator("[data-block-id] textarea")
    .first()
    .waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await page.waitForTimeout(500);
  r.eq("1: ``` kept the line's text as code", (await codes())[0], FIRST);

  // ---- 2: /code at the end of a line, on a fresh page ----------------------
  await page.waitForTimeout(2000);
  await openBlankPage(page, { settleMs: 3000 });
  await page.keyboard.type(SECOND + " /code");
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page
    .locator("[data-block-id] textarea")
    .first()
    .waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await page.waitForTimeout(500);
  r.eq(
    "2: /code kept the line's text, minus the query",
    (await codes())[0],
    SECOND + " ",
  );

  // ---- 3: reload ------------------------------------------------------------
  await page.waitForTimeout(2000);
  await page.reload();
  await page
    .locator("[data-block-id] textarea")
    .first()
    .waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  r.eq("3: the code survives reload", (await codes())[0], SECOND + " ");
});

await r.finish();
