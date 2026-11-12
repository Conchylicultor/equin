// End-to-end check that equin boots and stays live in a browser WITHOUT
// SharedWorker and Web Locks (Chrome for Android before 148, Android System
// WebView — Instagram's in-app browser): `SharedWebSocket` then runs its worker
// host in the page (`web/in-page-ws-host.ts`).
//
// Both globals are deleted by an init script before any page script runs. The
// page is booted (the public website by default), and the script checks that
// it renders (not the boot error, not the boot loader), that its live socket
// binds to a server connection and receives frames, and that a dropped
// connection reconnects — observed through the socket tap, which the in-page
// host reports to exactly as the SharedWorker one does.
//
// Usage:
//   1. `./equin build`
//   2. `./equin run plugins/primitives/plugins/networking/e2e/no-shared-worker.ts [--path /about] [--headed]`
//
// Exits non-zero on any failure.
import {
  arg,
  boot,
  pathUrl,
  report,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tapSharedSocket } from "./index";

const WS = "/ws/notifications";
const SETTLE_TIMEOUT_MS = 15_000;
const path = arg("path", "/about");

const r = report(
  `networking · boots without SharedWorker / Web Locks (${path})`,
);

await withBrowser(async (h) => {
  const { context, page, captured } = await h.session({ label: "no-sw" });
  try {
    await page.addInitScript(() => {
      // As absent as in a browser without them: `"locks" in navigator` is
      // false (its getter lives on Navigator.prototype).
      delete (globalThis as { SharedWorker?: unknown }).SharedWorker;
      delete (Navigator.prototype as { locks?: unknown }).locks;
    });
    const tap = await tapSharedSocket(page);
    let rx = 0;
    tap.onFrame((f) => {
      if (f.url === WS) rx++;
    });

    await boot(page, pathUrl(path), { settleMs: 1500 });

    r.eq(
      "the page has neither SharedWorker nor navigator.locks",
      await page.evaluate(() => ({
        sharedWorker: typeof (globalThis as { SharedWorker?: unknown })
          .SharedWorker,
        locks: typeof (navigator as { locks?: unknown }).locks,
      })),
      { sharedWorker: "undefined", locks: "undefined" },
    );

    const body = await page.evaluate(() => document.body.innerText);
    r.ok(
      "the page rendered (no boot error, no boot loader)",
      !/Couldn.t start the app|Loading the app/i.test(body) &&
        body.trim().length > 200,
      body.slice(0, 300),
    );

    const bound = await waitFor(
      () => Promise.resolve(tap.connections(WS)),
      (conns) => conns.length > 0,
      { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 100 },
    );
    r.ok(`the live socket ${WS} bound to a server connection`, bound.ok);
    r.eq("…and is open", tap.status(WS), "open");
    const framed = await waitFor(
      () => Promise.resolve(rx),
      (n) => n > 0,
      { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 100 },
    );
    r.ok("…and receives server frames", framed.ok, `${rx} frames`);

    // ── a dropped connection reconnects (a fresh server connection) ───────
    const before = tap.connections(WS).at(-1);
    await tap.drop(WS);
    const reconnected = await waitFor(
      () => Promise.resolve(tap.connections(WS).at(-1)),
      (conn) => conn !== undefined && conn !== before,
      { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 100 },
    );
    r.ok("a dropped connection reconnects", reconnected.ok);
    r.eq("…and is open again", tap.status(WS), "open");

    r.eq("no page error", captured.pageErrors, []);
    const named = captured.consoleErrors.filter((e) =>
      /SharedWorker|navigator\.locks|SharedWebSocket|Web Locks/i.test(e),
    );
    r.eq("no console error names SharedWorker / Web Locks", named, []);
    for (const e of captured.consoleErrors) r.note(`console error: ${e}`);
  } finally {
    await context.close();
  }
});

await r.finish();
