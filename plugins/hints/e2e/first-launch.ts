// First launch, end to end: the Home tour from a blank seen state through the
// handoff on the request's conversation row, every exit pointing at ?, and the
// ? menu's Replay / Show tips again.
//
//   1. reset every seen row (POST /api/hints/reset over the ids hint_seen holds)
//   1b. docked (the bar in the tab strip): walk to improve with Next, then the
//      Improve ↔ ask round trips (below), then Esc
//   2. /home, solo — the welcome card shows; walk apps → bar (hover) → improve,
//      the Improve ↔ ask round trips: the real Improve button advances to ask
//      with the first request seeded; closing the popover unsent (a click
//      elsewhere, Esc, Cancel) comes back to a visible improve step; "Try it"
//      reaches ask every time — then ask (send it) → agents
//   3. "Open Agent Manager" before any conversation exists (auto-start
//      launches only on main — a worktree never does): the handoff card waits
//      centered ("the agent is starting on it") with Finish tour. Then launch
//      the filed task the way the task's Launch does: the card moves onto that
//      conversation's sidebar row, in its running state
//   4. stop the agent's turn: the card turns to "Your request is ready" — and
//      the run launches no long-lived agent
//   5. Esc ends the tour: ? pulses and the toast says where the tour lives
//   6. ? → Replay the tour, from the Agent Manager: back on Home, welcome card
//   7. ? → Show tips again clears the tip rows (a seeded one), not the tour's
//
// Writes, so a worktree deploy only (`openDeployDb` refuses main).
//
//   ./singularity run plugins/hints/e2e/first-launch.ts [--out /tmp/first-launch]

import type { Locator, Page } from "playwright";
import {
  agentFetch,
  arg,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tryItHint } from "@plugins/conversations/plugins/conversation-view/plugins/open-app/core";

const out = arg("out") ?? "/tmp/first-launch";
const db = openDeployDb();
const r = report("hints: first launch");

/** How long a live update (a filed task, a started conversation) may take. */
const LIVE_TIMEOUT_MS = 30_000;
/** How long the agent's conversation may take to be created after a launch. */
const LAUNCH_TIMEOUT_MS = 90_000;

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await agentFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  // Some answer 204 (reset, mark seen): no body to read.
  const text = await res.text();
  return text === "" ? null : (JSON.parse(text) as unknown);
}

async function seenIds(): Promise<string[]> {
  const rows = await db.query<{ hint_id: string }>(
    "select hint_id from hint_seen",
  );
  return rows.map((row) => row.hint_id);
}

/** Wait until `poll` answers a value (the DB, read on a short cadence). */
async function until<T>(
  what: string,
  timeoutMs: number,
  poll: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await poll();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function visible(
  name: string,
  locator: Locator,
  timeout = 10_000,
): Promise<boolean> {
  const shown = await locator
    .first()
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch((err: unknown) => {
      if (err instanceof Error && err.name === "TimeoutError") return false;
      throw err;
    });
  r.ok(name, shown);
  return shown;
}

/**
 * Put the pointer on the folded action bar, which unfolds it. The health dot
 * is the folded bar's home slot; the bar's hitbox lies over it (that is what
 * the pointer enters), so the hover is forced past Playwright's "covered" check.
 */
async function hoverActionBar(page: Page): Promise<void> {
  await page.locator("[data-health]").first().hover({ force: true });
}

/**
 * The ? button, reached through the folded bar (solo mode). Wait for the bar
 * to fold first — a tour end holds it unfolded while ? pulses — so the hover
 * lands on the folded dot, not where the health dot sits in the unfolded bar.
 * The bar is open while an ancestor of ? carries `data-open` (FloatingAction;
 * a closed panel is only `inert`, which Playwright still counts as visible).
 */
async function openHelpMenu(page: Page): Promise<void> {
  const help = page.getByRole("button", { name: "Getting started" });
  const openBar = page.locator("[data-open]", { has: help }).first();
  await page.mouse.move(700, 850);
  await openBar.waitFor({ state: "detached" });
  await hoverActionBar(page);
  await openBar.waitFor({ state: "attached" });
  await help.click();
}

/**
 * Pick a surface mode in the gear's Layout row (the bar must be reachable).
 * The mode radios carry no accessible name (the placement control hands its
 * label to an option field the segmented control does not read), so they are
 * picked by position: the modes are sorted by `order` — docked first, solo
 * last.
 */
async function pickSurfaceMode(
  page: Page,
  mode: "docked" | "solo",
): Promise<void> {
  await page.getByRole("button", { name: "View options", exact: true }).click();
  const radios = page.getByRole("radiogroup").first().getByRole("radio");
  await (mode === "docked" ? radios.first() : radios.last()).click();
  await page.keyboard.press("Escape");
}

/**
 * Forget every seen row and reload Home, where the tour auto-starts again (a
 * page that already ran it this session never auto-starts it twice).
 */
async function resetSeen(page: Page): Promise<void> {
  const ids = await seenIds();
  if (ids.length > 0) await post("/api/hints/reset", { ids });
  await page.goto(pathUrl("/home"));
}

/**
 * On the improve step: every way onto ask and back. The real Improve button
 * is "Try it" done by hand (the popover opens with the first request, the
 * tour moves to ask); closing the popover unsent — a click elsewhere, Esc,
 * Cancel — returns to improve with its card showing, the bar held open when
 * it floats; "Try it" reaches ask every time.
 */
async function improveRoundTrips(
  page: Page,
  mode: string,
  floating: boolean,
): Promise<void> {
  const improveCard = page.getByText("Improve anything you see", {
    exact: true,
  });
  const askCard = page.getByText("See what an agent can do", { exact: true });
  const improveButton = page.getByRole("button", {
    name: "Improve",
    exact: true,
  });
  const draft = page.getByText(
    "Make my home screen's background follow the time of day",
  );
  const backOnImprove = async (how: string) => {
    await visible(`${mode}: ${how} → back on improve`, improveCard);
    if (floating) {
      // The step holds the bar open over its Improve button.
      await page.mouse.move(700, 850);
      const openBar = page.locator("[data-open]", { has: improveButton });
      r.ok(
        `${mode}: ${how} → bar held open on improve`,
        await openBar
          .first()
          .waitFor({ state: "attached", timeout: 5000 })
          .then(() => true)
          .catch((err: unknown) => {
            if (err instanceof Error && err.name === "TimeoutError")
              return false;
            throw err;
          }),
      );
    }
  };

  // The real button: the same as "Try it".
  await improveButton.first().click();
  await visible(`${mode}: real Improve click → ask`, askCard);
  await visible(`${mode}: real Improve click seeds the first request`, draft);
  await snap(page, out, `${mode}-ask-by-hand`);

  // A click elsewhere closes it unsent.
  await page.mouse.click(200, 820);
  await backOnImprove("click outside");
  await snap(page, out, `${mode}-improve-after-outside`);

  // Esc closes the popover — and does not end the tour.
  await improveButton.first().click();
  await visible(`${mode}: Improve again → ask`, askCard);
  await page.keyboard.press("Escape");
  await backOnImprove("Esc");

  // "Try it", every time; Cancel back.
  for (let i = 1; i <= 3; i++) {
    await page.getByRole("button", { name: "Try it", exact: true }).click();
    await visible(`${mode}: Try it → ask (${i})`, askCard);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await backOnImprove(`Cancel (${i})`);
  }
}

function viewportHeight(page: Page): number {
  return page.viewportSize()?.height ?? 0;
}

const passed = await withBrowser(async (h) => {
  // 1. A blank seen state: forget every row there is.
  const before = await seenIds();
  if (before.length > 0) await post("/api/hints/reset", { ids: before });
  r.eq("seen state reset", await seenIds(), []);

  const { page } = await h.session();
  const card = (title: string) => page.getByText(title, { exact: true });
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });

  // 1b. Docked: the bar sits open in the tab strip.
  await page.goto(pathUrl("/home"));
  if (
    !(await visible("welcome card on /home", card("Welcome to equin"), 20_000))
  )
    return false;
  await button("I'll explore on my own").click();
  await page.mouse.move(700, 850);
  await page.waitForTimeout(3500); // the exit pulse holds the bar; let it fold
  await hoverActionBar(page);
  await pickSurfaceMode(page, "docked");
  await resetSeen(page);
  if (
    !(await visible(
      "docked: welcome card again",
      card("Welcome to equin"),
      20_000,
    ))
  )
    return false;
  await button("Show me around").click();
  await visible("docked: apps step", card("Your apps"));
  await button("Next").click();
  await visible("docked: bar step", card("Your way to talk to equin"));
  await button("Next").click();
  if (
    !(await visible("docked: improve step", card("Improve anything you see")))
  )
    return false;
  await improveRoundTrips(page, "docked", false);
  await page.keyboard.press("Escape");
  await visible(
    "docked: Esc on improve ends the tour",
    page.getByText("The tour is here whenever you want it"),
  );
  await pickSurfaceMode(page, "solo");
  await page.mouse.move(700, 850);
  await page.waitForTimeout(3500);

  // 2. The tour, auto-started on Home, solo (the floating bar).
  await resetSeen(page);
  if (
    !(await visible(
      "welcome card again (solo)",
      card("Welcome to equin"),
      20_000,
    ))
  )
    return false;
  await snap(page, out, "1-welcome");
  await button("Show me around").click();

  await visible("apps step", card("Your apps"));
  await snap(page, out, "2-apps");
  await button("Next").click();

  await visible("bar step", card("Your way to talk to equin"));
  await snap(page, out, "3-bar");
  // Hovering the folded bar unfolds it, and moves the tour on.
  await hoverActionBar(page);
  await visible(
    "improve step (hover advanced)",
    card("Improve anything you see"),
  );
  // The step holds the bar unfolded with the pointer gone.
  await page.mouse.move(700, 850);
  await page.waitForTimeout(800);
  await visible("bar stays unfolded on the improve step", button("Improve"));
  await snap(page, out, "4-improve");
  await improveRoundTrips(page, "solo", true);

  const startedAt = new Date();
  await button("Try it").click();
  await visible("ask step", card("See what an agent can do"));
  const draft = page.getByText(
    "Make my home screen's background follow the time of day",
  );
  await visible("Improve opened with the first request", draft);
  await snap(page, out, "5-ask");
  await page.getByRole("button", { name: /^Create task/ }).click();

  await visible("agents step (send advanced)", card("Your agent is on it"));
  await snap(page, out, "6-agents");

  // 3. The filed task, started; its conversation reaches the tour.
  const task = await until("the filed task", LIVE_TIMEOUT_MS, async () => {
    const rows = await db.query<{ id: string; description: string }>(
      "select id, description from tasks where created_at >= $1 order by created_at desc limit 1",
      [startedAt],
    );
    return rows[0] ?? null;
  });
  r.note(`filed ${task.id}`);

  // No conversation yet: the handoff still comes, waiting for it.
  await button("Open Agent Manager").click();
  await page.waitForURL(/\/agents/);
  await visible(
    "handoff card (pending) before the conversation exists",
    page.getByText(/The agent is starting on it/),
  );
  await visible("pending handoff offers Finish tour", button("Finish tour"));
  await snap(page, out, "7-handoff-pending");

  const launched = (await post("/api/tasks/launch", {
    prompt: task.description,
    options: {},
    task: { id: task.id },
  })) as { started: boolean; conversation?: { id: string } };
  if (!launched.started || !launched.conversation) {
    r.fail("launch the filed task", JSON.stringify(launched));
    return false;
  }
  const convId = launched.conversation.id;
  r.note(`launched ${convId}`);
  onBeforeFinish(async () => {
    // Whatever happened, leave no agent working on the tour's request.
    const rows = await db.query<{ status: string }>(
      "select status from conversations where id = $1",
      [convId],
    );
    if (rows[0]?.status === "working")
      await post(`/api/conversations/${convId}/stop`, {});
  });

  // The conversation's live row reaches the tracker: the card moves onto it.
  const running = page.getByText(/The agent is building it now/);
  if (await visible("handoff card (running)", running, LIVE_TIMEOUT_MS)) {
    await visible("handoff offers Finish tour", button("Finish tour"));
    // The step brought its row into view: the spotlight's cut-out (the mask's
    // hole) lies inside the viewport, not off below the sidebar's fold.
    const hole = await page.evaluate(() => {
      const r = document.querySelector("svg mask rect:nth-of-type(2)");
      return r
        ? {
            y: Number(r.getAttribute("y")),
            h: Number(r.getAttribute("height")),
          }
        : null;
    });
    r.ok(
      "handoff spotlight is on screen",
      hole !== null && hole.y >= 0 && hole.y + hole.h <= viewportHeight(page),
      JSON.stringify(hole),
    );
    await snap(page, out, "8-handoff-running");
  }

  // 4. The turn ends → the card says the request is ready.
  await until("the agent to be working", LAUNCH_TIMEOUT_MS, async () => {
    const rows = await db.query<{ status: string }>(
      "select status from conversations where id = $1",
      [convId],
    );
    return rows[0]?.status === "working" ? true : null;
  });
  await post(`/api/conversations/${convId}/stop`, {});
  if (
    await visible(
      "handoff card (ready) once the turn ends",
      card("Your request is ready"),
      LAUNCH_TIMEOUT_MS,
    )
  ) {
    await visible("ready card offers Open it", button("Open it"));
    await snap(page, out, "9-handoff-ready");
  }

  // 5. Esc: the one exit path — ? pulses, the toast says where the tour is.
  await page.keyboard.press("Escape");
  await visible(
    "exit toast",
    page.getByText("The tour is here whenever you want it"),
  );
  const help = page.getByRole("button", { name: "Getting started" });
  r.ok(
    "? pulses after the tour ends",
    (await help.getAttribute("class"))?.includes("ring-primary") ?? false,
  );
  await snap(page, out, "10-exit");
  r.eq(
    "tour outcome recorded",
    await db.query("select outcome from hint_seen where hint_id = 'home.tour'"),
    [{ outcome: "dismissed" }],
  );

  // 6. ? → Replay the tour, from the Agent Manager: back to Home.
  await openHelpMenu(page);
  await button("Replay the tour").click();
  await page.waitForURL(/\/home/);
  await visible("Replay restarts the tour on Home", card("Welcome to equin"));
  await snap(page, out, "11-replay");
  await button("I'll explore on my own").click();

  // 7. ? → Show tips again: the tip rows go, the tour's stays.
  await post("/api/hints/seen", { id: tryItHint.id, outcome: "dismissed" });
  await openHelpMenu(page);
  await button("Show tips again").click();
  await visible("tips-back toast", page.getByText("Tips are back on"));
  const left = await seenIds();
  r.ok("Show tips again cleared the tip row", !left.includes(tryItHint.id));
  r.ok("Show tips again kept the tour row", left.includes("home.tour"));
  return true;
});

// Last: the teardown above (stopping the agent) still reads the database.
onBeforeFinish(() => db.close());
if (!passed) r.fail("flow stopped early (see above)");
await r.finish();
