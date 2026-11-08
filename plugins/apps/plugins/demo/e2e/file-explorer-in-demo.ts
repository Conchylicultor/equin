/**
 * Files runs in the demo, as a virtual file system.
 *
 * In `/demo`, it:
 *
 *  1. opens the launcher inside the embed and picks Files: the embed switches
 *     to the file explorer, which lands on App data (the host has no home
 *     folder) — the App data place marked, the roots the worker's apps keep
 *     listed (Documents, Prototypes);
 *  2. checks the Places sidebar lists no place that needs the computer (Home,
 *     Downloads, the equin checkout, the startup volume, Trash) and no failed
 *     row;
 *  3. opens Documents: the seeded folders are listed, and each kind of file
 *     the seed wrote opens in its viewer beside its folder — markdown
 *     rendered, plain text and code as listings, the picture drawn, the HTML
 *     page in its sandboxed frame, the PDF and the recording each in their
 *     viewer or saying they are not available — never an error;
 *  4. opens Prototypes: the gallery's folders are files here too.
 *
 * Every file-type and Lucide icon is drawn from the demo's own server
 * (`ScopeIconSymbols` reads `icons.sprite` through the scope).
 *
 * And asserts, throughout, that nothing left the scope — the list `no-leak.ts`
 * checks against (D3): no `/api/…` request for the page's origin but the
 * sanctioned telemetry routes, no page socket, no page or console error.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/file-explorer-in-demo.ts [--out /tmp/demo-files] [--headed]
 */
import type { Locator, Page, Request, WebSocket } from "playwright";
import { pickFromLauncher } from "@plugins/apps-core/plugins/app-launcher/e2e";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Settled,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/demo-files";

/** The page-origin `/api` routes a demo may still call — `no-leak.ts`'s list (D3). */
const SANCTIONED: readonly RegExp[] = [
  /^\/api\/logs\/emit$/,
  /^\/api\/latency-ledger\/client$/,
  /^\/api\/slow-ops\/client$/,
  /^\/api\/app-usage\/flush$/,
  /^\/api\/analytics\/collect$/,
  /^\/api\/reports$/,
  /^\/api\/icons\/(sprite|symbols)\//,
  /^\/api\/health(\/ready)?$/,
];

/** The app's launcher name and id (`apps/file-explorer/shell`'s `fileExplorerApp`). */
const APP_NAME = /^\s*Files\s*$/;
const APP_ID = "file-explorer";
/** The places that need the computer (`apps/file-explorer/places`). */
const MACHINE_PLACES = ["Home", "Downloads", "equin", "Trash"] as const;
/** The demo's Documents (`apps/website/demos/workspace`'s `data/documents/`). */
const DOCUMENT_FOLDERS = [
  "Code",
  "Lisbon trip",
  "Notes",
  "Piano",
  "Recipes",
] as const;
/** How long an app swap, a worker read or a viewer gets. */
const RENDER_TIMEOUT_MS = 30_000;

/** What a viewer that cannot show its file says — never an error. */
const NOT_AVAILABLE = /not available|No preview/i;
/** What a broken pane says. */
const BROKEN = /Something went wrong|failed to load|Couldn.t load|Error:/i;

function embedRoot(page: Page): Locator {
  return page.locator("[data-app-embed]").first();
}

function sidebar(page: Page): Locator {
  return embedRoot(page).locator("[data-slot=sidebar-container]").first();
}

/** The preview panel beside the listing (`app-data`'s split). */
function preview(page: Page): Locator {
  return embedRoot(page).locator('[data-panel][id="preview"]').first();
}

/**
 * A row of App data's lists, by its key: a root by its id, an entry by its
 * path relative to the root (`app-data`'s row keys).
 */
function row(page: Page, key: string): Locator {
  return embedRoot(page).locator(`[data-row-key="${key}"]`).first();
}

/** A crumb of App data's path (`App data › <root> › …`), by its label. */
function crumb(page: Page, label: string): Locator {
  return embedRoot(page)
    .locator("a")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first();
}

/** The roots (`apps/file-explorer/documents`, `apps/prototypes`). */
const DOCUMENTS_ROOT = "apps.file-explorer.documents";
const PROTOTYPES_ROOT = "apps.prototypes";

async function previewText(page: Page): Promise<string> {
  if ((await preview(page).count()) === 0) return "";
  return (await preview(page).innerText()).replace(/\s+/g, " ");
}

await withBrowser(async (h) => {
  const r = report("demo: Files on the browser worker");
  const { page, captured } = await h.session();

  let demoUp = false;
  const leaked: string[] = [];
  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
    if (!demoUp || url.origin !== new URL(page.url()).origin) return;
    if (!url.pathname.startsWith("/api/")) return;
    if (!SANCTIONED.some((re) => re.test(url.pathname)))
      leaked.push(`${req.method()} ${url.pathname}`);
  };
  page.on("request", onRequest);
  const openedSockets: string[] = [];
  const onSocket = (ws: WebSocket): void => {
    openedSockets.push(new URL(ws.url()).pathname);
  };
  page.on("websocket", onSocket);

  const renders = async <T>(
    name: string,
    read: () => Promise<T>,
    ok: (value: T) => boolean,
  ): Promise<Settled<T>> => {
    const settled = await waitFor(read, ok, { timeoutMs: RENDER_TIMEOUT_MS });
    r.ok(
      name,
      settled.ok,
      `${JSON.stringify(settled.value)} (waited ${settled.waitedMs} ms)`,
    );
    return settled;
  };

  const embedText = async (): Promise<string> =>
    (await embedRoot(page).innerText()).replace(/\s+/g, " ");

  // ── 1. launcher → Files, landing on App data ────────────────────────────
  await boot(page, pathUrl("/demo"), {
    marker: 'button:has-text("Conversations")',
  });
  demoUp = true;
  r.ok(
    "the launcher offers Files",
    await pickFromLauncher(embedRoot(page), APP_NAME),
  );
  await renders(
    "the embed switches to Files",
    () => embedRoot(page).getAttribute("data-app-embed"),
    (id) => id === APP_ID,
  );
  await renders(
    "Files lands on App data, listing the roots the worker's apps keep",
    embedText,
    (text) => text.includes("Documents") && text.includes("Prototypes"),
  );
  await snap(page, OUT, "1-app-data");

  // ── 2. no place that needs the computer ─────────────────────────────────
  await renders(
    "the Places sidebar lists App data",
    async () => (await sidebar(page).innerText()).split("\n"),
    (lines) => lines.some((l) => l.trim() === "App data"),
  );
  const sidebarLines = (await sidebar(page).innerText())
    .split("\n")
    .map((l) => l.trim());
  for (const place of MACHINE_PLACES)
    r.ok(
      `the sidebar has no "${place}" place (it needs the computer)`,
      !sidebarLines.includes(place),
      sidebarLines.join(" | "),
    );
  r.ok(
    "the sidebar has no failed row",
    !/not available|not known/i.test(sidebarLines.join(" ")),
    sidebarLines.join(" | "),
  );

  // ── 3. Documents: the seeded tree, each viewer ──────────────────────────
  await row(page, DOCUMENTS_ROOT).click();
  await renders("Documents lists the seeded folders", embedText, (text) =>
    DOCUMENT_FOLDERS.every((f) => text.includes(f)),
  );
  await snap(page, OUT, "3-documents");

  /** Open `folder/file` and wait for its viewer to read `ok`. */
  const view = async (
    folder: string,
    file: string,
    what: string,
    ok: (preview: Locator, text: string) => Promise<boolean>,
  ): Promise<void> => {
    await row(page, folder).click();
    await row(page, `${folder}/${file}`).click();
    await renders(
      `${folder}/${file}: ${what}`,
      async () => {
        const text = await previewText(page);
        return { ok: await ok(preview(page), text), text: text.slice(0, 160) };
      },
      (v) => v.ok,
    );
    r.ok(
      `${folder}/${file}: the pane shows no error`,
      !BROKEN.test(await previewText(page)),
      await previewText(page),
    );
    await snap(page, OUT, `3-${file.replace(/\W+/g, "-")}`);
    // Back to Documents through its crumb.
    await crumb(page, "Documents").click();
  };

  await view(
    "Notes",
    "Ideas for equin.md",
    "the markdown is rendered (its heading, no `#`)",
    async (p, text) =>
      (await p.getByRole("heading", { name: "Ideas for equin" }).count()) > 0 &&
      !text.includes("# Ideas"),
  );
  await view("Notes", "groceries.txt", "the text is shown", async (_p, text) =>
    text.includes("coffee beans"),
  );
  await view(
    "Code",
    "practice-timer.js",
    "the code is listed",
    async (_p, text) => text.includes("class PracticeTimer"),
  );
  await view("Code", "split_bill.py", "the code is listed", async (_p, text) =>
    text.includes("expenses"),
  );
  await view(
    "Lisbon trip",
    "tram 28.png",
    "the picture is drawn",
    async (p) => {
      const img = p.locator("img").first();
      if ((await img.count()) === 0) return false;
      return img.evaluate(
        (el: HTMLImageElement) => el.complete && el.naturalWidth === 640,
      );
    },
  );
  await view(
    "Recipes",
    "shakshuka.html",
    "the page is rendered in its frame",
    async (p) => (await p.locator("iframe").count()) > 0,
  );
  await view(
    "Lisbon trip",
    "boarding pass.pdf",
    "the PDF is shown, or says it is not available",
    async (p, text) =>
      (await p.locator("iframe, embed, object").count()) > 0 ||
      NOT_AVAILABLE.test(text),
  );
  await view(
    "Piano",
    "C major arpeggio.wav",
    "the recording plays, or says it is not available",
    async (p, text) =>
      (await p.locator("audio, video").count()) > 0 || NOT_AVAILABLE.test(text),
  );

  // ── 4. Prototypes: the gallery's folders are files here too ─────────────
  await crumb(page, "App data").click();
  await row(page, PROTOTYPES_ROOT).click();
  await renders(
    "Prototypes lists the demo's prototype folders",
    embedText,
    (text) => /-demo\d+/.test(text),
  );
  await snap(page, OUT, "4-prototypes");

  r.eq("the page URL stays /demo", new URL(page.url()).pathname, "/demo");

  page.off("request", onRequest);
  page.off("websocket", onSocket);
  r.eq(
    "no /api request left for the page's origin (sanctioned telemetry aside)",
    leaked,
    [],
  );
  r.eq("the page opened no socket of its own", openedSockets, []);
  r.eq("no page errors", captured.pageErrors, []);
  r.eq("no console errors", captured.consoleErrors, []);
  await r.finish();
});
