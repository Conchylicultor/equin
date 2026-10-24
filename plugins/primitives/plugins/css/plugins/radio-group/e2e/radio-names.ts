/**
 * Verifies in the deployed app that a config page rendering an enum field as
 * radios still paints, and that its inputs carry a minted `name` rather than a
 * shared literal.
 *
 * The independence invariant itself (two mounted groups, two distinct names,
 * independent checked state) is covered far more precisely by the jsdom suite in
 * `web/__tests__/radio-group.test.tsx` — this script exists to prove the wiring
 * survives on the real config surface, which the unit test cannot see.
 *
 *   ./equin run plugins/primitives/plugins/css/plugins/radio-group/e2e/radio-names.ts
 *   ./equin run …/radio-names.ts --config chord-l… --headed
 */
import {
  arg,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const target = arg("config", "notation");
const r = report(`radio-names(${target})`);

await withBrowser(async (h) => {
  const { page } = await h.session();

  await page.goto(pathUrl("/settings/config"));
  await page.waitForTimeout(4000);

  // The config nav is a DataView tree, so its rows are not buttons — click the
  // row by its label text and let the pane route itself.
  await page.getByText(target, { exact: true }).first().click();
  await page.waitForTimeout(3000);
  r.note(`routed to ${page.url()}`);

  const radios = await page.$$eval("input[type=radio]", (els) =>
    els.map((e) => {
      const i = e as HTMLInputElement;
      return { name: i.name, value: i.value, checked: i.checked };
    }),
  );
  const names = [...new Set(radios.map((x) => x.name))];
  r.note(`radios=${radios.length} names=${names.join(",")}`);

  r.ok("renders radios", radios.length > 0, "no input[type=radio] on the page");
  r.ok(
    "name is minted, not a shared literal",
    !names.includes("enum-field") && !names.includes("dynamic-enum-field"),
    `saw ${names.join(",")}`,
  );
  r.ok(
    "one name for the whole group",
    names.length === 1,
    `expected a single group, saw ${names.length}`,
  );
  r.eq("exactly one option checked", radios.filter((x) => x.checked).length, 1);
});

await r.finish();
