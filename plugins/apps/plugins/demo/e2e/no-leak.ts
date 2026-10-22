/**
 * The in-app demo is sealed: nothing inside `<DemoScope>` reaches the real
 * server (research/2026-10-22-global-demo-scope-sealed.md, Verification).
 *
 * In `/demo` (the Agent Manager on made-up data, served by the browser
 * worker), once the demo is up it:
 *
 *  1. creates a task (the tree's root Add), edits a task's title inline,
 *     adds a prerequisite through the task-draft popover, sets the task's
 *     thinking mode and preprompt (and its workspace / auto-start when the
 *     host offers them), and pastes an image into its description;
 *  2. opens a conversation, sees the composer say sending is not available,
 *     and tries to send anyway (type + Enter).
 *
 * And asserts:
 *
 *  - no page socket was opened during those steps (`page.on("websocket")`),
 *    and the page's own live-state socket — in a SharedWorker, out of
 *    Playwright's sight, so read through the networking tap — subscribed to
 *    nothing naming the demo's data (every demo id carries `demo`): a scoped
 *    read that rode the page's pipeline would;
 *  - no request for `/api/…` left for the page's origin during those steps,
 *    except the sanctioned telemetry routes (D3: logs, latency samples, slow
 *    ops, app usage, analytics, crash reports) and the page-wide icon sprites
 *    — every other call went to the worker, which the page sees as a
 *    `postMessage`, not as a request;
 *  - the composer shows "not available" and the send did nothing;
 *  - this deploy's database gained no row in tasks, task_dependencies,
 *    notifications, attachments or tasks_attachments;
 *  - no page error and no console error.
 *
 * Whether the demo's own writes then RENDER (the created task's row, the
 * edited title) is noted, not asserted: the worker has no change feed yet, so
 * a write lands in PGlite but no live read recomputes (open item, see the
 * plan's G6 / the review notes).
 *
 * The worker's own answers are logged (each step's response status, read off
 * the worker's messages) so a step that silently did nothing is visible.
 *
 * Manual only — nothing runs this automatically. Refuses main (the DB check
 * reads this deploy's database).
 *   ./singularity run plugins/apps/plugins/demo/e2e/no-leak.ts [--out /tmp/demo-no-leak] [--headed]
 */
import type { Page, Request, WebSocket } from "playwright";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
import {
  arg,
  boot,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/demo-no-leak";

/**
 * The page-origin `/api` routes a demo may still call (D3, the
 * `networking/no-page-transport` sanctioned importers): telemetry belongs to
 * the page, and the icon sprites are page-wide.
 */
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

/** A 1×1 PNG, the image pasted into the description. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Records every message the demo's worker answers with (`t: "response"`),
 * installed before the page's scripts run: the page reaches the worker by
 * `postMessage`, so this is the only place its answers are visible.
 */
async function tapWorkerResponses(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __demoWorkerLog: string[] }).__demoWorkerLog = log;
    const Native = window.Worker;
    class Tapped extends Native {
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        this.addEventListener("message", (e: MessageEvent) => {
          const d = e.data as {
            t?: string;
            id?: number;
            response?: { status: number };
          } | null;
          if (d?.t === "response" && d.response)
            log.push(`#${d.id} → ${d.response.status}`);
        });
        const send = this.postMessage.bind(this);
        this.postMessage = ((msg: unknown, ...rest: [Transferable[]]) => {
          const m = msg as {
            t?: string;
            id?: number;
            request?: { method: string; url: string };
          } | null;
          if (m?.t === "request" && m.request)
            log.push(
              `#${m.id} ${m.request.method} ${new URL(m.request.url).pathname}`,
            );
          send(msg, ...rest);
        }) as Worker["postMessage"];
      }
    }
    window.Worker = Tapped;
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

/** Pick the first option other than the current one of a combobox in a launch-option row. */
async function pickOther(
  page: Page,
  label: string,
): Promise<string | "disabled" | "absent"> {
  const row = page
    .locator('[data-ui-owner^="BoundOptionRow"]')
    .filter({ has: page.getByText(label, { exact: true }) });
  if ((await row.count()) === 0) return "absent";
  const trigger = row.getByRole("combobox").first();
  if ((await trigger.count()) === 0 || (await trigger.isDisabled()))
    return "disabled";
  const before = (await trigger.textContent())?.trim() ?? "";
  await trigger.click();
  const options = page.getByRole("option");
  await options.first().waitFor({ timeout: 10_000 });
  const n = await options.count();
  for (let i = 0; i < n; i++) {
    const text = (await options.nth(i).textContent())?.trim() ?? "";
    if (text !== "" && text !== before) {
      await options.nth(i).click();
      return `${before} → ${text}`;
    }
  }
  await page.keyboard.press("Escape");
  return `${before} (no other option)`;
}

await withBrowser(async (h) => {
  const r = report("demo: nothing in the scope reaches the real server");
  const { page, captured } = await h.session();
  await tapWorkerResponses(page);
  const socketTap = await tapSharedSocket(page);

  await boot(page, pathUrl("/demo"), {
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
  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
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
  await clickButton(page, "Tasks");
  const tree = page.getByRole("treegrid");
  await tree.waitFor();
  const addRoot = page.locator('button[data-ui-owner^="TreeRootAdd"]');
  const rowsBefore = await tree.getByRole("row").count();
  await addRoot.click();
  await page.waitForTimeout(1_500);
  noteSubs("New task");
  r.note(`after New task: ${(await workerLog(page)).slice(-2).join(" · ")}`);
  r.note(
    `the created task renders: ${(await tree.getByRole("row").count()) > rowsBefore ? "yes" : "no (no change feed on the worker)"}`,
  );

  // Open the first task, edit its title inline from the list.
  const firstRow = tree.getByRole("row").first();
  const firstTitle =
    (await firstRow.getByRole("gridcell").first().textContent())?.trim() ?? "";
  await firstRow.getByRole("gridcell").first().dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(`${firstTitle} (edited)`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_000);
  noteSubs("title edit");
  r.note(`after title edit: ${(await workerLog(page)).slice(-2).join(" · ")}`);
  r.note(
    `the edited title renders: ${(await tree.getByText(`${firstTitle} (edited)`).count()) > 0 ? "yes" : "no (no change feed on the worker)"}`,
  );

  // The detail pane is open on that task: add a prerequisite.
  await page.getByRole("button", { name: "+ Prerequisite" }).click();
  const draft = page.locator('[aria-placeholder="Describe the task…"]');
  await draft.click();
  await page.keyboard.type("A prerequisite drafted in the demo");
  await page.getByRole("button", { name: /Create task/ }).click();
  await page.waitForTimeout(1_500);
  r.note(
    `after add prerequisite: ${(await workerLog(page)).slice(-3).join(" · ")}`,
  );
  noteSubs("prerequisite");
  await snap(page, OUT, "prerequisite");
  await page.keyboard.press("Escape");

  for (const label of [
    "Thinking mode",
    "Preprompt",
    "Workspace",
    "Auto-start",
  ]) {
    const outcome = await pickOther(page, label);
    r.note(`${label}: ${outcome}`);
    await page.waitForTimeout(500);
  }
  r.note(
    `after launch options: ${(await workerLog(page)).slice(-4).join(" · ")}`,
  );

  // Paste an image into the description.
  // The description reads as text until clicked; the click opens its editor.
  await page.getByText("Add a description…", { exact: true }).first().click();
  const description = page.locator('[aria-placeholder^="Add a description"]');
  await description
    .first()
    .waitFor({ timeout: 10_000 })
    .catch((err: unknown) => {
      if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
    });
  if ((await description.count()) > 0) {
    await description.first().click();
    await description.first().evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], "demo.png", { type: "image/png" }));
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, PNG_BASE64);
    await page.waitForTimeout(2_000);
    r.note(`after paste: ${(await workerLog(page)).slice(-3).join(" · ")}`);
  } else {
    r.fail("paste image", "no description editor on the task detail");
  }
  noteSubs("options + paste");
  await snap(page, OUT, "task-detail");

  // ── 2. a conversation: the composer says sending is not available ──────
  await clickButton(page, "Conversations");
  await page.locator('[data-ui-owner^="ConvTitle"]').first().click();
  // The composer is the prompt editor, disabled, its placeholder saying why.
  const composer = page.locator(
    '[aria-placeholder*="available in this version of the app"]',
  );
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
  r.eq("no page errors", captured.pageErrors, []);
  r.eq("no console errors", captured.consoleErrors, []);
  await r.finish();
});
