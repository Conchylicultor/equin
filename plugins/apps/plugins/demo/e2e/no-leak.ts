/**
 * The in-app demo is sealed: nothing inside `<DemoScope>` reaches the real
 * server (research/2026-10-22-global-demo-scope-sealed.md, Verification).
 *
 * In `/demo` (the Agent Manager on made-up data, served by the browser
 * worker), once the demo is up it:
 *
 *  1. creates a task (the tree's root Add), edits a seeded task's title
 *     inline ("Practice timer in Sonata", `stories.ts`), adds a
 *     prerequisite through the task-draft popover (pasting an image into
 *     its draft first), sets the task's thinking
 *     mode and preprompt (and its workspace / auto-start when the host offers
 *     them), and pastes an image into its description;
 *  2. opens a conversation, sees the composer say sending is not available,
 *     and tries to send anyway (type + Enter);
 *  3. switches the embed to Prototypes and opens a seeded prototype's canvas:
 *     its frames load from the host's Service Worker, so every frame `src` is
 *     under `/artifacts/*\/frames/` and no `/api/prototypes…` request reaches
 *     the page's origin;
 *  4. opens every app the embed's launcher lists, one after the other, and
 *     lets each landing settle: what an app draws on arrival (Sonata's covers,
 *     a transcript image, an icon) loads through the scope, never from the
 *     page's origin. An element load (`<img>`, `<link>`) is a request the page
 *     sends, so a route handed to an element as a plain string fails here —
 *     the class the Sonata covers fell into (research/2026-11-04-global-no-
 *     route-string-in-scoped-code.md).
 *
 *  5. opens Pages, deletes a seeded page from the sidebar and clicks Undo on
 *     the "Page moved to trash" toast: a toast raised inside the scope acts
 *     on the scope — the worker restores the page.
 *
 * And asserts that the demo's own writes RENDER — the worker's change feed
 * recomputes its live reads (research/2026-10-22-global-demo-writes-render-
 * portable-change-feed.md, G6):
 *
 *  - the created task's row appears in the tree, and the edited title shows
 *    in the tree and in the task detail's header;
 *  - the new prerequisite shows in the detail's Dependencies card;
 *  - each launch-option pick reads back from its side table (the control is
 *    not optimistic: it shows the row the worker serves) — a control the host
 *    does not offer (absent, disabled) is a SKIP, reported
 *    and counted apart, never a pass;
 *  - the image pasted into the prerequisite's DRAFT is held where it was
 *    uploaded: the draft's attachment hold (`PUT /api/attachments/holds`,
 *    paste-images' DraftAttachmentHolds) goes to the worker — a hold sent
 *    through the page's own transport would reach the page's server, which
 *    the leak list below catches;
 *  - the pasted image shows in the read-only description once the editor
 *    closes, and the task's Attachments card lists it;
 *  - a SECOND SUBSCRIBER sees all of it: the detail is closed and reopened
 *    while the tree still holds the tasks rows, so the detail's reads of
 *    them are told "up to date" by the worker — which is only true if the
 *    writes moved the version on. Never a page reload: the worker's in-memory
 *    database is reseeded on one, and a first subscribe always reloads.
 *
 * And that nothing left the scope:
 *
 *  - no page socket was opened during those steps (`page.on("websocket")`),
 *    and the page's own live-state socket — in a SharedWorker, out of
 *    Playwright's sight, so read through the networking tap — subscribed to
 *    nothing naming the demo's data (every demo id carries `demo`): a scoped
 *    read that rode the page's pipeline would;
 *  - every request to another origin — the page's own or the worker's — went
 *    to a host a scoped plugin declares (`externalHosts`, each plugin's
 *    `ExternalHosts.Declare`: Google's map, the instruments' sample CDNs),
 *    and none to an undeclared one;
 *  - no request for `/api/…` left for the page's origin during those steps,
 *    except the sanctioned telemetry routes (D3: logs, latency samples, slow
 *    ops, app usage, analytics, crash reports) — every other call, the
 *    demo's saved icons included, went to the worker, which the page sees as a
 *    `postMessage`, not as a request;
 *  - the composer shows "not available" and the send did nothing;
 *  - this deploy's database gained no row in tasks, task_dependencies,
 *    notifications, attachments or tasks_attachments;
 *  - no page error and no console error.
 *
 * The worker's own answers are logged (each step's response status, read off
 * the worker's messages) so a step that silently did nothing is visible.
 *
 * Manual only — nothing runs this automatically. Refuses main (the DB check
 * reads this deploy's database).
 *   ./equin run plugins/apps/plugins/demo/e2e/no-leak.ts [--out /tmp/demo-no-leak] [--headed]
 */
import type { Locator, Page, Request, WebSocket } from "playwright";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
import { externalHosts } from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/core";
import { CANVAS_FRAME_ATTR } from "@plugins/apps/plugins/prototypes/plugins/canvas/core";
import {
  closeLauncherGrid,
  launcherTiles,
  openLauncherGrid,
  pickFromLauncher,
} from "@plugins/apps-core/plugins/app-launcher/e2e";
import {
  arg,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  tapSharedWorkerRequests,
  waitFor,
  waitForNetworkIdle,
  waitForNotBusy,
  withBrowser,
  type Settled,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  AGENT_MANAGER_LOCATION,
  demoPath,
  bootDemo,
} from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-no-leak";

/**
 * The page-origin `/api` routes a demo may still call (D3, the
 * `networking/no-page-transport` sanctioned importers): telemetry belongs to
 * the page. Nothing else — a scope's icons included: its saved icons come
 * from its own server (`ScopeIconSymbols`).
 */
const SANCTIONED: readonly RegExp[] = [
  /^\/api\/logs\/emit$/,
  /^\/api\/latency-ledger\/client$/,
  /^\/api\/slow-ops\/client$/,
  /^\/api\/app-usage\/flush$/,
  /^\/api\/analytics\/collect$/,
  /^\/api\/reports$/,
  // A site page's error reports (its report channel, the standalone website):
  // the page's collectors catch the demo's errors and send them to the site's
  // own public intake — reports/web's `reportChannel`.
  /^\/api\/site-reports$/,
  /^\/api\/health(\/ready)?$/,
];

/** The tables a leaked write would land in. */
const TABLES = [
  "tasks",
  "task_dependencies",
  "notifications",
  "attachments",
  "tasks_attachments",
] as const;
type Counts = Record<(typeof TABLES)[number], number>;

const db = openDeployDb();
onBeforeFinish(() => db.close());

/**
 * Rows a table holds that the demo could have written. A `report`
 * notification is the backend's own telemetry (a crash, a slow op, a shed
 * episode — sanctioned, D3, and raised by the server on its own clock), so it
 * is not counted.
 */
const WHERE: Partial<Record<(typeof TABLES)[number], string>> = {
  notifications: "type <> 'report'",
};

async function counts(): Promise<Counts> {
  const out = {} as Counts;
  for (const t of TABLES) {
    const where = WHERE[t];
    const [row] = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${t}${where === undefined ? "" : ` WHERE ${where}`}`,
    );
    out[t] = Number(row?.n ?? Number.NaN);
  }
  return out;
}

/** A 1×1 PNG, the image pasted into the description and the draft. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Paste `PNG_BASE64` as a file into the editor `el` (a clipboard paste event). */
async function pasteImage(el: Locator): Promise<void> {
  await el.evaluate((node, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "demo.png", { type: "image/png" }));
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, PNG_BASE64);
}

/**
 * Records every request the page sends the demo's host and every answer
 * (`t: "response"`), installed before the page's scripts run: the page reaches
 * the host by `postMessage` — on a dedicated `Worker`, or on the `port` of the
 * SharedWorker every tab of the demo shares — so this is the only place its
 * traffic is visible.
 */
async function tapWorkerResponses(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __demoWorkerLog: string[] }).__demoWorkerLog = log;
    /** Tap one end the page talks to the host on. */
    const tap = (end: Worker | MessagePort): void => {
      end.addEventListener("message", (e: Event) => {
        const d = (e as MessageEvent).data as {
          t?: string;
          id?: number;
          response?: { status: number };
        } | null;
        if (d?.t === "response" && d.response)
          log.push(`#${d.id} → ${d.response.status}`);
      });
      const send = end.postMessage.bind(end) as (
        msg: unknown,
        transfer?: Transferable[],
      ) => void;
      end.postMessage = ((msg: unknown, transfer?: Transferable[]) => {
        const m = msg as {
          t?: string;
          id?: number;
          request?: { method: string; url: string };
        } | null;
        if (m?.t === "request" && m.request)
          log.push(
            `#${m.id} ${m.request.method} ${new URL(m.request.url).pathname}`,
          );
        send(msg, transfer ?? []);
      }) as Worker["postMessage"];
    };
    const NativeWorker = window.Worker;
    class TappedWorker extends NativeWorker {
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        tap(this);
      }
    }
    window.Worker = TappedWorker;
    const NativeShared = window.SharedWorker;
    class TappedShared extends NativeShared {
      constructor(url: string | URL, opts?: string | WorkerOptions) {
        super(url, opts);
        tap(this.port);
      }
    }
    window.SharedWorker = TappedShared;
  });
}

async function workerLog(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __demoWorkerLog?: string[] }).__demoWorkerLog ??
      [],
  );
}

async function clickButton(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).first().click();
}

/** A seeded prototype (`website/demos/workspace`'s `data/prototypes/`) and where its frames are served from. */
const PROTOTYPE_TITLE = "Family Recipes";
/** The seeded page deleted and brought back through its toast's Undo. */
const TRASHED_PAGE = "Ideas";
const FRAMES_RE = /^\/artifacts\/[^/]+\/frames\/[^/]+\/api\/prototypes\//;

/** The seeded task the steps edit (`website/demos/workspace`'s `stories.ts`). */
const TARGET_TITLE = "Practice timer in Sonata";
const EDITED_TITLE = `${TARGET_TITLE} (edited)`;
/** How long a write gets to come back through the worker's change feed. */
const RENDER_TIMEOUT_MS = 20_000;

/**
 * The task detail's launch options, by the row label the Prompt card paints
 * and the aria-label its control carries (each option's own control file).
 * `optional` ones are noted, not asserted, when the host does not offer them
 * (no row, or a disabled control).
 */
const LAUNCH_OPTIONS = [
  { label: "Thinking mode", control: "Task thinking mode", optional: false },
  { label: "Preprompt", control: "Task preprompt", optional: false },
  { label: "Workspace", control: "Task workspace", optional: true },
  { label: "Auto-start", control: "Auto-start model", optional: true },
] as const;
type LaunchOption = (typeof LAUNCH_OPTIONS)[number];

type PickOutcome =
  | { kind: "picked"; before: string; picked: string }
  | { kind: "absent" | "disabled" }
  | { kind: "no-other"; before: string };

/** A control's visible text, whitespace collapsed. */
async function textOf(el: Locator): Promise<string> {
  return ((await el.textContent()) ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Whether a select trigger reads as the option that was picked. The option
 * row may carry more than the trigger's collapsed label (a model row's
 * label component, a preprompt's glyph), so either may contain the other.
 */
function readsAs(trigger: string, picked: string): boolean {
  return (
    trigger !== "" &&
    picked !== "" &&
    (trigger === picked || trigger.includes(picked) || picked.includes(trigger))
  );
}

function launchControl(detail: Locator, option: LaunchOption): Locator {
  return detail.getByRole("combobox", { name: option.control, exact: true });
}

/** Pick the first option other than the current one of a launch option's select. */
async function pickOther(
  page: Page,
  detail: Locator,
  option: LaunchOption,
): Promise<PickOutcome> {
  const trigger = launchControl(detail, option);
  if ((await trigger.count()) === 0) return { kind: "absent" };
  if (await trigger.first().isDisabled()) return { kind: "disabled" };
  const before = await textOf(trigger.first());
  await trigger.first().click();
  const options = page.getByRole("option");
  await options.first().waitFor({ timeout: 10_000 });
  const n = await options.count();
  for (let i = 0; i < n; i++) {
    const text = await textOf(options.nth(i));
    if (text !== "" && !readsAs(before, text)) {
      await options.nth(i).click();
      return { kind: "picked", before, picked: text };
    }
  }
  await page.keyboard.press("Escape");
  return { kind: "no-other", before };
}

/**
 * The body of one of the task detail's section cards, found by its title:
 * the header row's control names its body (`aria-controls`). Opens a
 * collapsed card first (its body is unmounted while shut). `null` while the
 * card is not painted — a card with `useAvailable` (Attachments) appears
 * only once it has something to show.
 */
async function sectionBody(
  detail: Locator,
  label: string,
): Promise<Locator | null> {
  const header = detail
    .locator("[aria-controls][aria-expanded]")
    .filter({ hasText: new RegExp(`^\\s*${label}`) })
    .first();
  if ((await header.count()) === 0) return null;
  if ((await header.getAttribute("aria-expanded")) === "false")
    await header.click();
  const id = await header.getAttribute("aria-controls");
  if (id === null)
    throw new Error(`the "${label}" card's header names no body`);
  return detail.page().locator(`[id="${id}"]`);
}

/**
 * The title the task detail's header shows: its title field (`TaskHeader`'s
 * input, the detail's one "Untitled"-placeholder field). `null` while the
 * detail is not open.
 */
async function headerTitle(detail: Locator): Promise<string | null> {
  const input = detail.locator('input[placeholder="Untitled"]').first();
  return (await input.count()) > 0 ? input.inputValue() : null;
}

/** Image thumbnails (`ViewerThumbnail`'s open button) under a locator. */
function thumbnails(scope: Locator): Locator {
  return scope.getByRole("button", { name: /^View image / });
}

/** How many images the task's Attachments card lists (0 while it is not painted). */
async function attachmentCount(detail: Locator): Promise<number> {
  const body = await sectionBody(detail, "Attachments");
  return body === null ? 0 : thumbnails(body).count();
}

/** The task's prerequisites, as the Dependencies card's chips name them. */
async function prerequisites(detail: Locator): Promise<string[]> {
  const body = await sectionBody(detail, "Dependencies");
  if (body === null) return [];
  const labels = await body
    .getByRole("button", { name: /^Remove dependency / })
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
  return labels.map((l) => l.replace(/^Remove dependency /, ""));
}

await withBrowser(async (h) => {
  const r = report("demo: nothing in the scope reaches the real server");
  // Before the page exists: a worker's requests are seen from its attach on.
  const workerRequests = await tapSharedWorkerRequests(h.browser);
  const { page, captured } = await h.session();
  await tapWorkerResponses(page);
  const socketTap = await tapSharedSocket(page);

  await bootDemo(page, pathUrl(demoPath(AGENT_MANAGER_LOCATION)), {
    marker: 'button:has-text("Conversations")',
  });
  // The scope renders its sidebar once the worker answered the first reads.
  await page
    .getByRole("button", { name: "Tasks", exact: true })
    .first()
    .waitFor();

  const before = await counts();
  r.note(`db before: ${JSON.stringify(before)}`);

  // From here on, every /api request the page itself sends is recorded.
  const leaked: string[] = [];
  const sanctioned: string[] = [];
  /** Hosts of every request the page sent to another origin. */
  const offOrigin: string[] = [];
  const pageOrigin = new URL(page.url()).origin;
  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (url.origin !== pageOrigin) {
      offOrigin.push(url.host);
      return;
    }
    if (!url.pathname.startsWith("/api/")) return;
    const line = `${req.method()} ${url.pathname}`;
    if (SANCTIONED.some((re) => re.test(url.pathname))) sanctioned.push(line);
    else leaked.push(line);
  };
  page.on("request", onRequest);
  // A socket the page opens itself (a per-tab feed such as `/ws/logs`).
  const openedSockets: string[] = [];
  const onSocket = (ws: WebSocket): void => {
    openedSockets.push(new URL(ws.url()).pathname);
  };
  page.on("websocket", onSocket);
  // What the page's own live-state socket sent before the steps: only what
  // it sends from here on counts. The page's chrome (outside the scope)
  // subscribes as its deferred tier mounts, so the baseline is taken once the
  // socket has sent nothing for a few seconds.
  const NOTIFICATIONS = "/ws/notifications";
  let sentBefore = socketTap.sent(NOTIFICATIONS).length;
  for (let quiet = 0; quiet < 3;) {
    await page.waitForTimeout(1_000);
    const now = socketTap.sent(NOTIFICATIONS).length;
    quiet = now === sentBefore ? quiet + 1 : 0;
    sentBefore = now;
  }
  let subsSeen = sentBefore;
  const noteSubs = (step: string): void => {
    const frames = socketTap.sent(NOTIFICATIONS).slice(subsSeen);
    subsSeen += frames.length;
    const keys = frames
      .filter((f) => f.op === "sub" || f.op === "sub-batch")
      .map((f) => String(f.key ?? f.op));
    if (keys.length > 0)
      r.note(`page socket subs during ${step}: ${keys.join(", ")}`);
  };

  // ── 1. tasks ────────────────────────────────────────────────────────────
  // Every check below waits for a write to come back through the worker's
  // change feed: the reads re-render only once a NOTIFY recomputes them.
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

  await clickButton(page, "Tasks");
  const tree = page.getByRole("treegrid");
  await tree.waitFor();
  const targetRow = tree
    .getByRole("row")
    .filter({ hasText: TARGET_TITLE })
    .first();
  await targetRow.waitFor({ timeout: RENDER_TIMEOUT_MS });
  const detail = page.locator('[data-pane-id="task-detail"]');

  const addRoot = page.locator('button[data-ui-owner^="TreeRootAdd"]');
  const rowsBefore = await tree.getByRole("row").count();
  await addRoot.click();
  await renders(
    `the created task's row renders in the tree (${rowsBefore} rows before)`,
    () => tree.getByRole("row").count(),
    (n) => n > rowsBefore,
  );
  noteSubs("New task");
  r.note(`after New task: ${(await workerLog(page)).slice(-2).join(" · ")}`);

  // Open the seeded task's detail, then edit its title inline from the list.
  await targetRow.getByRole("gridcell").first().click();
  await renders(
    "the task detail opens on the seeded task",
    () => headerTitle(detail),
    (title) => title === TARGET_TITLE,
  );
  await targetRow.getByRole("gridcell").first().dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(EDITED_TITLE);
  await page.keyboard.press("Enter");
  await renders(
    "the edited title renders in the tree",
    () => tree.getByText(EDITED_TITLE).count(),
    (n) => n > 0,
  );
  await renders(
    "the edited title shows in the task detail header",
    () => headerTitle(detail),
    (title) => title === EDITED_TITLE,
  );
  noteSubs("title edit");
  r.note(`after title edit: ${(await workerLog(page)).slice(-2).join(" · ")}`);

  // Add a prerequisite through the Dependencies card's draft popover.
  const prereqsBefore = await prerequisites(detail);
  await detail.getByRole("button", { name: "+ Prerequisite" }).click();
  const draft = page.locator('[aria-placeholder="Describe the task…"]');
  await draft.click();
  // An image pasted into the draft is uploaded to the worker at once and
  // held there while the draft lives: the hold rides the scope's transport.
  const holdsBefore = (await workerLog(page)).filter((l) =>
    l.endsWith(" PUT /api/attachments/holds"),
  ).length;
  await pasteImage(draft);
  await renders(
    "the image pasted into the prerequisite draft lands in it",
    () => thumbnails(draft).count(),
    (n) => n > 0,
  );
  await renders(
    "the draft's attachment hold goes to the worker",
    async () =>
      (await workerLog(page)).filter((l) =>
        l.endsWith(" PUT /api/attachments/holds"),
      ).length,
    (n) => n > holdsBefore,
  );
  // Focus, not click: the draft's centre is now the image's chip, which opens
  // the image viewer.
  await draft.focus();
  await page.keyboard.press("End");
  await page.keyboard.type("A prerequisite drafted in the demo");
  // The draft form's submit ("Launch ⌘↵"), not a row's or the form's own
  // "Launch <model>" launch control.
  await page
    .getByRole("button", { name: /^Launch( \d+ tasks)?\s*⌘↵$/ })
    .click();
  await page.waitForTimeout(1_500);
  r.note(
    `after add prerequisite: ${(await workerLog(page)).slice(-3).join(" · ")}`,
  );
  noteSubs("prerequisite");
  await snap(page, OUT, "prerequisite");
  await page.keyboard.press("Escape");
  const prereqsAfter = await renders(
    `the new prerequisite shows in the Dependencies card (before: ${JSON.stringify(prereqsBefore)})`,
    () => prerequisites(detail),
    (names) => names.length > prereqsBefore.length,
  );

  // Each pick is a PUT to the option's side table; the control is bound to
  // that table's live row, so it reads back the pick only once it recomputed.
  const picks: { option: LaunchOption; picked: string }[] = [];
  for (const option of LAUNCH_OPTIONS) {
    const outcome = await pickOther(page, detail, option);
    if (outcome.kind === "picked") {
      picks.push({ option, picked: outcome.picked });
      await renders(
        `${option.label}: the pick "${outcome.picked}" (was "${outcome.before}") renders from its side table`,
        () => textOf(launchControl(detail, option).first()),
        (shown) => readsAs(shown, outcome.picked),
      );
    } else if (
      option.optional &&
      (outcome.kind === "absent" || outcome.kind === "disabled")
    ) {
      r.skip(
        `${option.label}: a pick renders from its side table`,
        `${outcome.kind} on this host`,
      );
    } else {
      r.fail(`${option.label}: pick another value`, JSON.stringify(outcome));
    }
  }
  r.note(
    `after launch options: ${(await workerLog(page)).slice(-4).join(" · ")}`,
  );

  // Paste an image into the description. It reads as text until clicked;
  // the click opens its editor (a corner, so it lands on no inline chip).
  const description = detail
    .locator('[role="button"]')
    .filter({
      has: page.getByRole("button", { name: "Edit description", exact: true }),
    })
    .last();
  await description.waitFor({ timeout: RENDER_TIMEOUT_MS });
  const imagesBefore = await thumbnails(description).count();
  const attachmentsBefore = await attachmentCount(detail);
  await description.click({ position: { x: 6, y: 6 } });
  const editor = detail.locator('[aria-placeholder^="Add a description"]');
  await editor.first().waitFor({ timeout: 10_000 });
  await editor.first().click();
  await pasteImage(editor.first());
  // The upload goes to the worker; its node joins the editor once answered.
  await renders(
    "the pasted image lands in the description editor",
    () => thumbnails(editor.first()).count(),
    (n) => n > imagesBefore,
  );
  r.note(`after paste: ${(await workerLog(page)).slice(-3).join(" · ")}`);
  // Leave the editor: focus going nowhere closes it back to the read-only
  // view and flushes the description (which links the attachment).
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await renders(
    "the pasted image renders in the read-only description",
    async () =>
      (await description.count()) > 0 ? thumbnails(description).count() : -1,
    (n) => n > imagesBefore,
  );
  await renders(
    `the task's Attachments card lists the pasted image (${attachmentsBefore} before)`,
    () => attachmentCount(detail),
    (n) => n > attachmentsBefore,
  );
  noteSubs("options + paste");
  await snap(page, OUT, "task-detail");

  // ── a second subscriber sees the new state ──────────────────────────────
  // Close the detail while the tree keeps the tasks rows subscribed, then
  // reopen it: the detail's reads of those rows join a tuple another reader
  // holds, so the worker answers "up to date" from its version — which shows
  // the writes only if they moved it on. A reload would not test this (it
  // reseeds the worker's in-memory database, and a first subscribe reloads).
  await detail
    .getByRole("button", { name: /^(Close|Back)$/ })
    .first()
    .click();
  await renders(
    "the task detail closes, the tree stays",
    async () => ({
      detail: await detail.count(),
      tree: await tree.count(),
    }),
    (s) => s.detail === 0 && s.tree > 0,
  );
  await targetRow.getByRole("gridcell").first().click();
  await renders(
    "reopened: the header shows the edited title",
    () => headerTitle(detail),
    (title) => title === EDITED_TITLE,
  );
  await renders(
    "reopened: the Dependencies card shows the new prerequisite",
    () => prerequisites(detail),
    (names) => JSON.stringify(names) === JSON.stringify(prereqsAfter.value),
  );
  for (const { option, picked } of picks) {
    await renders(
      `reopened: ${option.label} reads "${picked}"`,
      async () => {
        const control = launchControl(detail, option);
        return (await control.count()) > 0 ? textOf(control.first()) : "";
      },
      (shown) => readsAs(shown, picked),
    );
  }
  await renders(
    "reopened: the description shows the pasted image",
    async () =>
      (await description.count()) > 0 ? thumbnails(description).count() : -1,
    (n) => n > imagesBefore,
  );
  await renders(
    "reopened: the Attachments card lists the pasted image",
    () => attachmentCount(detail),
    (n) => n > attachmentsBefore,
  );
  await snap(page, OUT, "task-detail-reopened");

  // ── 2. a conversation: the composer says sending is not available ──────
  await clickButton(page, "Conversations");
  await page.locator('[data-ui-owner^="ConvTitle"]').first().click();
  // The composer is the prompt editor, disabled, its placeholder saying why.
  // (Lexical drops `aria-placeholder` from an editor that is not editable:
  // the placeholder is read from the cell the editable shares with it.)
  const composer = page
    .locator(
      'div:has(> [data-ui-owner^="EditorShell"]):has-text("available in this version of the app")',
    )
    .locator('> [data-ui-owner^="EditorShell"]');
  const unavailable = await waitFor(
    () => composer.count(),
    (n) => n > 0,
    { timeoutMs: 20_000 },
  );
  r.ok(
    "the composer says sending is not available",
    unavailable.ok,
    `waited ${unavailable.waitedMs} ms`,
  );
  if (unavailable.ok) {
    const state = await composer.first().evaluate((el) => ({
      editable: el.getAttribute("contenteditable"),
      disabled: el.getAttribute("aria-disabled"),
    }));
    r.ok(
      "the composer is disabled",
      state.editable === "false" && state.disabled === "true",
      JSON.stringify(state),
    );
    // Try to send anyway: focus it as a user would and press Enter.
    await composer.first().click({ force: true });
    await page.keyboard.type("Please fix it");
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(1_500);
  noteSubs("conversation");
  await snap(page, OUT, "conversation");

  // ── 3. Prototypes: frames come from the host, never the page's origin ──
  const grid = await openLauncherGrid(page.locator("[data-app-embed]").first());
  await launcherTiles(grid)
    .filter({ hasText: /Prototypes/ })
    .first()
    .click();
  await closeLauncherGrid(grid);
  await page
    .locator("[data-app-embed]")
    .first()
    .locator("[data-row-key]")
    .filter({ hasText: PROTOTYPE_TITLE })
    .first()
    .click();
  const frameSrcs = await waitFor(
    () =>
      page
        .locator(`[${CANVAS_FRAME_ATTR}] iframe`)
        .evaluateAll((els) =>
          els.map((el) => el.getAttribute("src") ?? "").filter((s) => s !== ""),
        ),
    (srcs) => srcs.length > 0,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  const framePaths = frameSrcs.value.map(
    (src) => new URL(src, page.url()).pathname,
  );
  r.ok(
    "every prototype frame src is under /artifacts/*/frames/",
    frameSrcs.ok && framePaths.every((p) => FRAMES_RE.test(p)),
    framePaths.join(", "),
  );
  await page.waitForTimeout(1_500);
  noteSubs("prototypes");
  await snap(page, OUT, "prototypes");

  // ── 4. every app the launcher lists: what it draws stays in the scope ───
  const embed = page.locator("[data-app-embed]").first();
  const firstGrid = await openLauncherGrid(embed);
  const tiles = await launcherTiles(firstGrid).evaluateAll((els) =>
    els.map((el) => ({
      key: el.getAttribute("data-row-key") ?? "",
      name: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
  );
  await closeLauncherGrid(firstGrid);
  r.ok(
    "the launcher lists apps to visit",
    tiles.length > 0,
    JSON.stringify(tiles),
  );
  for (const tile of tiles) {
    const leakedBefore = leaked.length;
    const grid = await openLauncherGrid(embed);
    await launcherTiles(grid)
      .and(page.locator(`[data-row-key="${tile.key}"]`))
      .first()
      .click();
    await closeLauncherGrid(grid);
    // The landing's own reads (through the worker: its loaders show them),
    // then what the rendered landing loads itself (covers, thumbnails): two
    // seconds with nothing in flight.
    const loaded = await waitForNotBusy(embed, {
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    if (!loaded.ok)
      r.note(`${tile.name}: still loading — ${loaded.value.join(" | ")}`);
    await waitForNetworkIdle(page, {
      timeoutMs: RENDER_TIMEOUT_MS,
      idleMs: 2_000,
    }).catch((err: unknown) => {
      if (!(
        err instanceof Error && err.message.startsWith("waitForNetworkIdle:")
      ))
        throw err;
      r.note(`${tile.name}: the page never went quiet — ${err.message}`);
    });
    r.ok(
      `${tile.name}: its landing (${(await embed.getAttribute("data-app-embed")) ?? "?"}) loads nothing from the page's origin`,
      leaked.length === leakedBefore,
      leaked.slice(leakedBefore).join(", "),
    );
    await snap(page, OUT, `app-${tile.key.replace(/[^\w-]/g, "_")}`);
  }
  noteSubs("every app");

  // ── 5. a toast raised inside the demo, and its action ───────────────────
  // Deleting a page raises "Page moved to trash" with Undo: the toast shows
  // in the page's stack, and its action must act on the demo — the worker
  // restores the page; nothing reaches the page's server.
  r.ok(
    "the launcher offers Pages",
    await pickFromLauncher(embed, /^\s*Pages\s*$/),
  );
  await renders(
    "the embed shows Pages",
    () => embed.getAttribute("data-app-embed"),
    (id) => id === "pages",
  );
  const trashed = embed.locator("[data-row-key]").filter({
    // The page's icon, an emoji glyph, is part of the row's text.
    hasText: new RegExp(
      `^\\s*\\p{Extended_Pictographic}?\\uFE0F?\\s*${TRASHED_PAGE}\\s*$`,
      "u",
    ),
  });
  const listed = await renders(
    `the sidebar lists "${TRASHED_PAGE}"`,
    () => trashed.count(),
    (n) => n > 0,
  );
  // The Recent list's row offers Delete directly (the tree's keeps it in ⋯).
  const deletable = trashed.filter({
    has: page.getByRole("button", { name: "Delete page" }),
  });
  await deletable.first().hover();
  await deletable.first().getByRole("button", { name: "Delete page" }).click();
  await renders(
    `"${TRASHED_PAGE}" leaves the sidebar`,
    () => trashed.count(),
    (n) => n === 0,
  );
  const toast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Page moved to trash" })
    .first();
  await toast.waitFor({ timeout: RENDER_TIMEOUT_MS });
  await snap(page, OUT, "toast");
  await toast.getByRole("button", { name: "Undo" }).click();
  await renders(
    `the toast's Undo brings "${TRASHED_PAGE}" back — through the demo's server`,
    () => trashed.count(),
    (n) => n === listed.value,
  );
  r.note(`after Undo: ${(await workerLog(page)).slice(-3).join(" · ")}`);
  noteSubs("toast");

  page.off("request", onRequest);
  page.off("websocket", onSocket);

  // ── assertions ──────────────────────────────────────────────────────────
  r.ok(
    "no /api request left for the page's origin (sanctioned telemetry aside)",
    leaked.length === 0,
    leaked.length === 0
      ? `${sanctioned.length} sanctioned (${[...new Set(sanctioned)].join(", ")})`
      : leaked.join("\n  "),
  );
  const worker = await workerLog(page);
  r.ok(
    "the demo's writes went to the worker",
    worker.some((l) => /POST \/api\/tasks$/.test(l)),
    worker.filter((l) => /(POST|PATCH|PUT|DELETE) /.test(l)).join(" · "),
  );
  const after = await counts();
  r.note(`db after: ${JSON.stringify(after)}`);
  for (const t of TABLES) r.eq(`no new row in ${t}`, after[t] - before[t], 0);
  r.eq("the page opened no socket of its own", openedSockets, []);
  // The page's chrome may subscribe as it changes (leaving solo mode mounts
  // the app rail and its badges): those are the page's own reads. A scoped
  // read riding the page's pipeline names the demo's data — every demo id
  // carries `demo` (`stories.ts`) — so that is what fails.
  const pageSubs = socketTap
    .sent(NOTIFICATIONS)
    .slice(sentBefore)
    .filter((f) => f.op === "sub" || f.op === "sub-batch");
  r.note(
    `page socket subs during the steps (the page's own chrome): ${pageSubs.map((f) => String(f.key ?? f.op)).join(", ") || "none"}`,
  );
  r.eq(
    "the page's live-state socket subscribed to no demo data",
    pageSubs
      .filter((f) => JSON.stringify(f).includes("demo"))
      .map((f) => JSON.stringify(f)),
    [],
  );
  // The one exception to "no request leaves the browser": a third-party host
  // a scoped plugin declares — never an undeclared one, never the page's own.
  const declared = new Set(externalHosts.map((x) => x.host));
  const workerHosts = workerRequests.requests
    .map((req) => new URL(req.url))
    .filter(
      (url) => url.origin !== pageOrigin && url.protocol.startsWith("http"),
    )
    .map((url) => url.host);
  const reached = [...new Set([...offOrigin, ...workerHosts])].sort();
  r.note(`third-party hosts reached: ${reached.join(", ") || "none"}`);
  r.eq(
    "every third-party host reached is declared (ExternalHosts.Declare)",
    reached.filter((host) => !declared.has(host)),
    [],
  );
  await workerRequests.release();
  r.eq("no page errors", captured.pageErrors, []);
  // Google's own console error when it cannot draw the vector map (headless
  // Chromium has no WebGL for it): it falls back to the raster map. Counted
  // apart — a real browser draws the vector map.
  const rasterFallback =
    /^Attempted to load a Vector Map, but failed\. Falling back to Raster/;
  const fallback = captured.consoleErrors.filter((e) => rasterFallback.test(e));
  if (fallback.length > 0)
    r.note(
      `Google fell back to the raster map ${fallback.length}× (no WebGL here)`,
    );
  r.eq(
    "no console errors",
    captured.consoleErrors.filter((e) => !rasterFallback.test(e)),
    [],
  );
  await r.finish();
});
