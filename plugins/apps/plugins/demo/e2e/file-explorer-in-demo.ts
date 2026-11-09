/**
 * Files runs in the demo, on the browser's own file system.
 *
 * In `/demo`, it:
 *
 *  1. opens the launcher inside the embed and picks Files: the embed switches
 *     to the file explorer, which opens on Home — the browser storage's home
 *     folder, holding Demo's Documents, Music and Pictures and a few loose
 *     files;
 *  2. checks the Places sidebar lists Home and no place of the computer's
 *     disk (Downloads, the equin checkout, the startup volume, Trash), no
 *     empty Locations heading, and no failed row;
 *  3. opens each kind of file the seed wrote, from Home down, in the same
 *     browser the desktop has — markdown rendered, plain text and code as
 *     listings, pictures drawn, the HTML page in its sandboxed frame, the PDFs
 *     in the browser's viewer, the video and the recording loaded in the
 *     player (from the worker's storage, as blobs the transport fetched), the
 *     MIDI in Sonata's own preview — never an error;
 *  4. shows hidden files and opens `~/.equin/apps/prototypes`: the apps' own
 *     folders are folders of the same file system, where the desktop keeps
 *     them.
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
import { DATA_DIR_NAME } from "@plugins/infra/plugins/paths/core";
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
import {
  AGENT_MANAGER_LOCATION,
  demoPath,
  onDemoPage,
} from "./internal/demo-pages";

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
/** The places of the computer's disk (`apps/file-explorer/places`). */
const MACHINE_PLACES = ["Downloads", "equin", "Trash"] as const;
/**
 * What Demo's Home holds (`apps/website/demos/workspace`'s `data/home/`): three
 * folders and a few loose files, each a different preview.
 */
const HOME_ENTRIES = [
  "~/Documents",
  "~/Music",
  "~/Pictures",
  "~/Tram 28 ride.webm",
  "~/This week.md",
  "~/Alfama at dusk.png",
  "~/Fado night ticket.pdf",
  "~/Twinkle Twinkle Little Star.mid",
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

/** The preview beside the listing (the file's own column). */
function preview(page: Page): Locator {
  return embedRoot(page).locator("[data-files-preview]").first();
}

/** A row of the browser's tree, by its key: the entry's path (`~/…`). */
function row(page: Page, path: string): Locator {
  return embedRoot(page).locator(`[data-row-key="${path}"]`).first();
}

/** A toolbar button of the browser, by its label. */
function toolbarButton(page: Page, label: string): Locator {
  return embedRoot(page).getByRole("button", { name: label }).first();
}

/** The hidden folder holding the apps' data dirs, as on the desktop. */
const DATA = `~/${DATA_DIR_NAME}`;

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

  // ── 1. launcher → Files, opening on Home ────────────────────────────────
  await boot(page, pathUrl(demoPath(AGENT_MANAGER_LOCATION)), {
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
    "Files opens on Home: its folders and loose files",
    async () =>
      Promise.all(
        HOME_ENTRIES.map(async (p) => (await row(page, p).count()) > 0),
      ),
    (there) => there.every(Boolean),
  );
  r.ok(
    "App data is gone",
    !(await embedText()).includes("App data"),
    (await embedText()).slice(0, 200),
  );
  await snap(page, OUT, "1-home");

  // ── 2. Home, and no place of the computer's disk ────────────────────────
  await renders(
    "the Places sidebar lists Home",
    async () => (await sidebar(page).innerText()).split("\n"),
    (lines) => lines.some((l) => l.trim() === "Home"),
  );
  const sidebarLines = (await sidebar(page).innerText())
    .split("\n")
    .map((l) => l.trim());
  for (const place of MACHINE_PLACES)
    r.ok(
      `the sidebar has no "${place}" place (it is the computer's)`,
      !sidebarLines.includes(place),
      sidebarLines.join(" | "),
    );
  r.ok(
    "the sidebar's section headings are read (Favorites, holding Home)",
    sidebarLines.includes("Favorites"),
    sidebarLines.join(" | "),
  );
  r.ok(
    "the sidebar has no empty Locations heading (every location is the computer's)",
    !sidebarLines.includes("Locations"),
    sidebarLines.join(" | "),
  );
  r.ok(
    "the sidebar has no failed row",
    !/not available|not known/i.test(sidebarLines.join(" ")),
    sidebarLines.join(" | "),
  );

  // ── 3. every kind of preview, from Home down ────────────────────────────
  /** Back to Home through its place in the sidebar. */
  const home = async (): Promise<void> => {
    await sidebar(page).getByText("Home", { exact: true }).first().click();
    await renders(
      "back on Home",
      // A loose file of Home's: listed only while Home itself is.
      async () => (await row(page, "~/Tram 28 ride.webm").count()) > 0,
      (there) => there,
    );
  };

  /**
   * Open `path` (a `~/…` file): each folder above it from Home, then the
   * file, and wait for its viewer to read `ok`.
   */
  const view = async (
    path: string,
    what: string,
    ok: (preview: Locator, text: string) => Promise<boolean>,
  ): Promise<void> => {
    const segments = path.split("/");
    for (let i = 2; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      await renders(
        `${dir} is listed`,
        async () => (await row(page, dir).count()) > 0,
        (there) => there,
      );
      await row(page, dir).click();
    }
    await renders(
      `${path} is listed`,
      async () => (await row(page, path).count()) > 0,
      (there) => there,
    );
    await row(page, path).click();
    await renders(
      `${path}: ${what}`,
      async () => {
        const text = await previewText(page);
        return { ok: await ok(preview(page), text), text: text.slice(0, 160) };
      },
      (v) => v.ok,
    );
    r.ok(
      `${path}: the pane shows no error`,
      !BROKEN.test(await previewText(page)),
      await previewText(page),
    );
    await snap(page, OUT, `3-${path.replace(/\W+/g, "-")}`);
    await home();
  };

  const markdown = (heading: string) => async (p: Locator, text: string) =>
    (await p.getByRole("heading", { name: heading }).count()) > 0 &&
    !text.includes(`# ${heading}`);
  const picture = (width: number) => async (p: Locator) => {
    const img = p.locator("img").first();
    if ((await img.count()) === 0) return false;
    return img.evaluate(
      (el: HTMLImageElement, w) => el.complete && el.naturalWidth === w,
      width,
    );
  };
  // Every file system serves every file's bytes (file-systems' `fileUrl`), so
  // the PDF, the recording and the video preview from the worker's storage —
  // a blob the transport fetched, never "No preview".
  const pdf = async (p: Locator, text: string) => {
    if (NOT_AVAILABLE.test(text)) return false;
    const frame = p.locator("iframe, embed, object").first();
    if ((await frame.count()) === 0) return false;
    // Headless Chromium has no PDF viewer (the frame stays blank, on the
    // desktop's disk too): what is checked is that the frame holds the
    // worker's bytes as a PDF, which a real browser's viewer renders.
    const src =
      (await frame.getAttribute("src")) ?? (await frame.getAttribute("data"));
    if (!(src?.startsWith("blob:") ?? false)) return false;
    const type = await page.evaluate(
      async (url) => (await (await fetch(url)).blob()).type,
      src!,
    );
    return type === "application/pdf";
  };
  const media =
    (tag: "audio" | "video") => async (p: Locator, text: string) => {
      if (NOT_AVAILABLE.test(text)) return false;
      const el = p.locator(tag).first();
      if ((await el.count()) === 0) return false;
      return el.evaluate(
        (m: HTMLMediaElement) =>
          m.currentSrc.startsWith("blob:") &&
          m.readyState >= HTMLMediaElement.HAVE_METADATA &&
          m.duration > 0,
      );
    };
  // A MIDI file shows Sonata's own preview, settled.
  const midi = async (p: Locator, text: string) =>
    !/Loading/.test(text) &&
    (await p.locator("[inert]").count()) === 0 &&
    (await p.getByRole("slider", { name: "Song position" }).count()) > 0 &&
    (await p.getByRole("button", { name: "Open in Sonata" }).count()) > 0;

  // Home's loose files: a video, a note, a picture, a ticket, a MIDI tune.
  await view(
    "~/Tram 28 ride.webm",
    "the video is loaded in the player, from the worker",
    media("video"),
  );
  await view(
    "~/This week.md",
    "the markdown is rendered (its heading, no `#`)",
    markdown("This week"),
  );
  await view("~/Alfama at dusk.png", "the picture is drawn", picture(640));
  await view(
    "~/Fado night ticket.pdf",
    "the PDF is shown in the browser's viewer, from the worker",
    pdf,
  );
  await view(
    "~/Twinkle Twinkle Little Star.mid",
    "the MIDI is drawn in Sonata's preview (song position, Open in Sonata, no loading veil)",
    midi,
  );
  // Music: the MIDI in Sonata's own preview, the recording in the player.
  await view(
    "~/Music/Ode to Joy.mid",
    "the MIDI is drawn in Sonata's preview (song position, Open in Sonata, no loading veil)",
    midi,
  );
  await view(
    "~/Music/C major arpeggio.wav",
    "the recording is loaded in the player, from the worker",
    media("audio"),
  );
  await view(
    "~/Pictures/Trips/Lisbon/tram 28.png",
    "the picture is drawn",
    picture(640),
  );
  // Documents.
  await view(
    "~/Documents/Notes/Ideas for equin.md",
    "the markdown is rendered (its heading, no `#`)",
    markdown("Ideas for equin"),
  );
  await view(
    "~/Documents/Notes/groceries.txt",
    "the text is shown",
    async (_p, text) => text.includes("coffee beans"),
  );
  await view(
    "~/Documents/Code/practice-timer.js",
    "the code is listed",
    async (_p, text) => text.includes("class PracticeTimer"),
  );
  await view(
    "~/Documents/Code/split_bill.py",
    "the code is listed",
    async (_p, text) => text.includes("expenses"),
  );
  await view(
    "~/Documents/Recipes/shakshuka.html",
    "the page is rendered in its frame",
    async (p) => (await p.locator("iframe").count()) > 0,
  );
  await view(
    "~/Documents/Lisbon trip/boarding pass.pdf",
    "the PDF is shown in the browser's viewer, from the worker",
    pdf,
  );

  // ── 4. the apps' folders, under the hidden ~/.equin ─────────────────────
  await toolbarButton(page, "Show hidden files").click();
  for (const path of [DATA, `${DATA}/apps`, `${DATA}/apps/prototypes`]) {
    await renders(
      `${path} is listed`,
      async () => (await row(page, path).count()) > 0,
      (there) => there,
    );
    await row(page, path).click();
  }
  await renders(
    `${DATA}/apps/prototypes lists the demo's prototype folders`,
    embedText,
    (text) => /-demo\d+/.test(text),
  );
  await snap(page, OUT, "4-prototypes");

  r.ok("the page stays on the demo", onDemoPage(page.url()), page.url());

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
