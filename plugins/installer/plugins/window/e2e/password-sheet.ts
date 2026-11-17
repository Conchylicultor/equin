// The password sheet (sudo's askpass in the window, Linux): the page asks,
// the person types, and the page hands back exactly one `password` command —
// in a headless Chromium over the bundled page, with the window's bridge
// recorded. Writes `<out>.png` with the sheet open.
//
//   ./equin run plugins/installer/plugins/window/e2e/password-sheet.ts --url http://equin.localhost:<port> --out "$EQUIN_SCRATCH/password"
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { bundlePage } from "../deps";

const out = requireArg(
  "out",
  "password-sheet.ts --url http://equin.localhost:<port> --out <prefix>",
);
const html = await bundlePage(join(import.meta.dir, "../../../../.."));
const r = report("installer password sheet");
await withBrowser(async (h) => {
  const { page, captured } = await h.session({
    viewport: { width: 760, height: 640 },
    colorScheme: "dark",
  });
  await page.addInitScript(() => {
    const sent: string[] = [];
    (window as unknown as { ipc: unknown }).ipc = {
      postMessage: (m: string) => sent.push(m),
    };
    (window as unknown as { ipcSent: string[] }).ipcSent = sent;
  });
  const PAGE_URL = "http://installer.invalid/";
  await page.route(PAGE_URL, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(PAGE_URL);
  await page.evaluate(() =>
    (
      window as unknown as { installer: { askPassword(p: string): void } }
    ).installer.askPassword(
      "equin needs your password to install git and a C compiler, and to keep running while nobody is logged in. It is used for this only and never stored.",
    ),
  );
  await page.keyboard.type("s3cr et");
  writeFileSync(
    `${out}.png`,
    await page.screenshot({ animations: "disabled" }),
  );
  r.note(`sheet: ${out}.png`);
  await page.keyboard.press("Enter");
  const sent = await page.evaluate(
    () => (window as unknown as { ipcSent: string[] }).ipcSent,
  );
  r.eq("ready, then the password once", sent, [
    '{"cmd":"ready"}',
    '{"cmd":"password","value":"s3cr et"}',
  ]);
  r.eq("the sheet closed", await page.locator(".iw-scrim").count(), 0);
  r.eq(
    "no page errors",
    [...captured.pageErrors, ...captured.consoleErrors],
    [],
  );
});
await r.finish();
