/**
 * The live demo where the browser has no Web Locks — neither in the page nor
 * in the demo's worker (iOS Lockdown Mode, some in-app webviews; equin.ai's
 * demo on Safari died in its worker on "undefined is not an object
 * (evaluating 'navigator.locks.request')", report-1795088221-b1uksj).
 *
 * An init script deletes `navigator.locks` from the page, and wraps the page's
 * `Worker` / `SharedWorker` constructors so every worker it starts begins with
 * a module that deletes `WorkerNavigator.prototype.locks` and only then
 * imports the real entry — so the host's code runs exactly as in such a
 * browser. Then, in one fresh context:
 *
 *  1. the demo boots (Enter equin → the Agent Manager renders), its worker
 *     really having no `navigator.locks`;
 *  2. its storage is in memory, filled from the snapshot (the boot report
 *     says so; nothing is written to the storage's IndexedDB);
 *  3. a page created in Pages is listed (the host serves writes);
 *  4. no page error, no console error naming Web Locks.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/website/plugins/landing/plugins/screenshot/e2e/no-web-locks.ts [--out /tmp/demo-no-web-locks] [--headed]
 */
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  AGENT_MANAGER_LOCATION,
  bootDemo,
  demoPath,
  createPage,
  listed,
  MARKER,
  openPages,
  RENDER_TIMEOUT_MS,
} from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-no-web-locks";
const CREATED = "Made without Web Locks";

const r = report("website · the live demo boots without Web Locks");

await withBrowser(async (h) => {
  const { context, page, captured } = await h.session({ label: "no-locks" });
  try {
    await page.addInitScript(() => {
      // As absent as in a browser without them: the getter lives on the prototype.
      delete (Navigator.prototype as { locks?: unknown }).locks;
      const prelude = (url: string): string =>
        URL.createObjectURL(
          new Blob(
            [
              `delete WorkerNavigator.prototype.locks;\n` +
                // A SharedWorker's \`connect\` fires before the entry (imported
                // below) listens: keep each, and hand it to every later listener.
                `const early = [];\n` +
                `const keep = (e) => early.push(e);\n` +
                `self.addEventListener("connect", keep);\n` +
                `const add = self.addEventListener.bind(self);\n` +
                `self.addEventListener = (type, fn, o) => {\n` +
                `  add(type, fn, o);\n` +
                `  if (type === "connect") for (const e of early) fn(e);\n` +
                `};\n` +
                `await import(${JSON.stringify(url)});\n` +
                `self.removeEventListener("connect", keep);\n`,
            ],
            { type: "text/javascript" },
          ),
        );
      const abs = (u: string | URL): string => new URL(u, location.href).href;
      const W = globalThis.Worker;
      globalThis.Worker = class extends W {
        constructor(url: string | URL, opts?: WorkerOptions) {
          super(prelude(abs(url)), { ...opts, type: "module" });
        }
      };
      const S = (globalThis as { SharedWorker?: typeof SharedWorker })
        .SharedWorker;
      if (S !== undefined) {
        (globalThis as { SharedWorker?: unknown }).SharedWorker =
          class extends S {
            constructor(url: string | URL, opts?: string | WorkerOptions) {
              const o =
                typeof opts === "string" ? { name: opts } : (opts ?? {});
              super(prelude(abs(url)), { ...o, type: "module" });
            }
          };
      }
    });

    page.on("worker", (w) => {
      // Dedicated workers only: Playwright does not surface SharedWorkers.
      r.note(`dedicated worker started: ${w.url()}`);
    });

    const consoleLines: string[] = [];
    page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
    try {
      await bootDemo(page, pathUrl(demoPath(AGENT_MANAGER_LOCATION)), {
        marker: MARKER,
        timeoutMs: RENDER_TIMEOUT_MS * 2,
      });
    } catch (err) {
      for (const l of consoleLines) r.note(`console: ${l.slice(0, 600)}`);
      for (const e of captured.pageErrors) r.note(`page error: ${e}`);
      for (const e of captured.consoleErrors) r.note(`console error: ${e}`);
      await snap(page, OUT, "0-failed", { allowBlank: true });
      throw err;
    }
    r.ok("the demo boots and renders the Agent Manager", true);
    await snap(page, OUT, "1-booted");

    r.ok(
      "the host's boot report says its data is in memory",
      consoleLines.some((l) =>
        /\[demo-scope\].*data: snapshot, in memory \(no Web Locks in this worker\)/.test(l),
      ),
      consoleLines.find((l) => l.includes("[demo-scope]"))?.slice(0, 400),
    );
    r.eq(
      "the page has no navigator.locks",
      await page.evaluate(
        () => typeof (navigator as { locks?: unknown }).locks,
      ),
      "undefined",
    );

    // The host's storage: nothing of it is in IndexedDB (it serves from memory).
    const dbs = await page.evaluate(async () =>
      (await indexedDB.databases()).map((d) => d.name ?? ""),
    );
    r.eq(
      "the demo's storage wrote nothing to IndexedDB (in memory)",
      dbs.filter((n) => n.includes("equin-host--")),
      [],
    );

    await openPages(r, page, "3");
    await createPage(page, CREATED);
    await listed(
      r,
      page,
      "3: a page created in Pages is listed",
      CREATED,
      "some",
    );
    await snap(page, OUT, "2-created");

    r.eq("no page error", captured.pageErrors, []);
    const named = captured.consoleErrors.filter((e) =>
      /navigator\.locks|Web Locks|PortHostBootError/i.test(e),
    );
    r.eq("no console error names Web Locks or a failed host boot", named, []);
    for (const e of captured.consoleErrors) r.note(`console error: ${e}`);
  } finally {
    await context.close();
  }
});

await r.finish();
