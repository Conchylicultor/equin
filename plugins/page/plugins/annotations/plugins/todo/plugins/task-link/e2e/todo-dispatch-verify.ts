// Executable spec for DISPATCHING AN AGENT FROM A TODO CARD.
//
// The flow this pins, end to end: type `TODO …` to mint a card, open the panel
// its glyph carries, dispatch, and watch the card start reporting the task it is
// now bound to — in the UI and, through `read_page`, to every agent that reads
// the page.
//
//  1. The card's glyph is a TRIGGER on the editable surface (its three siblings'
//     glyphs are inert marks), and it opens the dispatch panel.
//  2. `POST /api/todo-blocks/:blockId/task` composes a prompt carrying the page
//     id, the block id and the card's own text, and links the card to a task in
//     the `pages` category.
//  3. **One task, many attempts.** A second dispatch from the same card returns
//     the SAME task id — the extension table's primary key IS the block id, so
//     this is a fact of the schema and not a check the endpoint remembers.
//  4. The card then reports the task: the panel leads with the task's title, and
//     the card's name goes on saying `Todo` — a dispatched card no longer spells
//     the status in its corner, because its FOOT carries the runs instead.
//  5. A card with a task but no run yet has NO foot: the seam costs a card
//     nothing until there is something to put in it.
//  6. A non-TODO block is refused with a 400 naming the type it actually is.
//
// **Nothing here presses Launch**, deliberately: `LaunchControl` would create a
// conversation, and a conversation is a real agent in a real worktree. The
// endpoint above is the whole of this feature's own server work — the attempt
// itself is `createConversation`'s existing `taskId`-without-`attemptId` branch,
// pinned by `page/prompt/block`'s own spec. So this script proves everything up
// to the model call and stops.
//
// That is also why the foot's CHIPS are not asserted here — there is no run to
// chip. What is asserted is the half that does not need one: that the foot is
// empty until a run exists, and that the corner name no longer stands in for it.
//
// What it deliberately does NOT cover, because they are not browser facts:
// the `<todo task_id="…" status="…">` attributes (read with `read_page` against
// a dispatched card) and the round trip that proves they parse back off
// (`edit_page` re-sending that document unchanged). Both are MCP-tool checks.
//
// Usage: bun plugins/page/plugins/annotations/plugins/todo/plugins/task-link/e2e/todo-dispatch-verify.ts [--url <deploy>] [--out /tmp/todo-dispatch]
import {
  pageFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/todo-dispatch");

const r = report();

const CARD_TEXT = "fix the UTF-16 path in decode.ts";

interface StoredRow {
  id: string;
  type: string;
  parentId: string | null;
}

/**
 * The document's one container box: its painted fill and its painted height.
 *
 * The height is how "the card grew a foot" is asked without naming the foot's
 * markup — a foot is FLOW content inside the box, so anything it renders makes
 * the box taller and anything it does not render costs the box nothing.
 */
interface CardBox {
  tint: string;
  height: number;
}

interface DispatchResult {
  status: number;
  taskId?: string;
  prompt?: string;
  body?: string;
}

/** The page's live rows, straight off the same endpoint the editor reads. */
async function storedRows(page: Page, pageId: string): Promise<StoredRow[]> {
  const res = await pageFetch(page, `/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`GET blocks ${res.status}: ${await res.text()}`);
  return (await res.json()) as StoredRow[];
}

/**
 * The document's one container box — the TODO card's frame — as its resolved
 * fill and its measured height. A card is a TINT and nothing else now (the
 * family's dashed border went with the redesign), and this scratch page holds
 * exactly one annotation and no other framed block, so the box needs no other
 * identification: it is the only absolutely-positioned element painting a fill.
 *
 * The positioning is what keeps it apart from ordinary chrome. A frame is a
 * `ContainerBackdrop` — `position: absolute`, filling the box the surface
 * measured — where a button, a chip or a popover fill is in flow or fixed.
 *
 * `undefined` when no box is painted, which is itself a failure the caller
 * reports rather than an absorbed empty answer.
 */
async function cardBox(page: Page): Promise<CardBox | undefined> {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll("div")) {
      const style = getComputedStyle(el);
      if (style.position !== "absolute") continue;
      const bg = style.backgroundColor;
      if (
        bg === "" ||
        bg === "transparent" ||
        bg.startsWith("rgba(0, 0, 0, 0)")
      )
        continue;
      return { tint: bg, height: el.getBoundingClientRect().height };
    }
    return undefined;
  });
}

/** Just the tint, for the polling helper below. */
async function cardTint(page: Page): Promise<string | undefined> {
  return (await cardBox(page))?.tint;
}

/**
 * The card's tint once it differs from `from`, or its unchanged value at the
 * deadline — which the caller then reports as the failure it is.
 */
async function waitForTintChange(
  page: Page,
  from: string | undefined,
  deadlineMs = 10_000,
): Promise<string | undefined> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const now = await cardTint(page);
    if (now !== from || Date.now() >= until) return now;
    await page.waitForTimeout(250);
  }
}

/**
 * One dispatch, as the panel's `getRequest` makes it. The status is returned
 * rather than thrown on, because a REFUSAL is one of the things under test.
 */
async function dispatch(
  page: Page,
  blockId: string,
  context: string,
): Promise<DispatchResult> {
  const res = await pageFetch(page, `/api/todo-blocks/${blockId}/task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: context || undefined }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: text };
  return { status: res.status, ...(JSON.parse(text) as object) };
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  const doc = await openBlankPage(page, { settleMs: 3000 });

  // --- 1. mint the card ------------------------------------------------------
  // The typed trigger, which `annotations-verify.ts` pins in full; here it is
  // just the cheapest way to a real card.
  await page.keyboard.type("TODO ");
  await page.waitForTimeout(800);
  await page.keyboard.type(CARD_TEXT);
  await page.waitForTimeout(2000);

  const rows = await storedRows(page, doc.pageId);
  const card = rows.find((b) => b.type === "todo");
  if (!card) {
    r.fail("a `todo` card was minted by typing `TODO `", JSON.stringify(rows));
    await r.finish();
  }
  const cardId = card!.id;

  // --- 2. the glyph is a trigger, and it opens the panel ----------------------
  // `ContainerAnchor`'s interactive arm renders a real button with the anchor's
  // `triggerLabel` as its accessible name; the inert arm renders no button at
  // all. So finding one IS the assertion that this card has `sections`.
  const trigger = page.getByRole("button", { name: "Dispatch an agent" });
  const hasTrigger = (await trigger.count()) > 0;
  r.ok(
    "the card's glyph is a TRIGGER on the editable surface",
    hasTrigger,
    `buttons named "Dispatch an agent": ${await trigger.count()}`,
  );

  if (hasTrigger) {
    await trigger.first().click();
    await page.waitForTimeout(600);
    await snap(page, out, "1-panel-before-dispatch");
    // The context editor is Lexical, whose placeholder is a rendered NODE and
    // not an HTML `placeholder` attribute — so it is found by its text.
    r.ok(
      "the glyph opens the dispatch panel",
      (await page.getByText("Extra context (optional)…").count()) > 0 &&
        (await page.getByText("Dispatch an agent").count()) > 0,
      "extra-context editor + panel title visible",
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  // --- 3. the dispatch itself ------------------------------------------------
  // Measured BEFORE anything is dispatched, so §5's "the foot costs a card
  // nothing until there is a run" has an honest baseline to compare against.
  const boxBefore = (await cardBox(page))?.height;

  const first = await dispatch(page, cardId, "prefer a table-driven decoder");
  r.ok(
    "POST /api/todo-blocks/:blockId/task returns a task id and a prompt",
    first.status === 200 && !!first.taskId && !!first.prompt,
    JSON.stringify(first),
  );

  const prompt = first.prompt ?? "";
  r.ok(
    "the prompt carries the page id, the block id, the card's text and the extra context",
    prompt.includes(doc.pageId) &&
      prompt.includes(cardId) &&
      prompt.includes(CARD_TEXT) &&
      prompt.includes("prefer a table-driven decoder"),
    prompt,
  );
  r.ok(
    "the prompt tells the agent where to write its findings back",
    prompt.includes("<agent-inline>") && prompt.includes("read_page"),
    prompt,
  );

  // --- 4. one task, many attempts --------------------------------------------
  const second = await dispatch(
    page,
    cardId,
    "second dispatch, different notes",
  );
  r.ok(
    "a SECOND dispatch returns the SAME task — one task per card, so this is a new attempt",
    second.status === 200 && second.taskId === first.taskId,
    JSON.stringify({ first: first.taskId, second: second.taskId }),
  );
  r.ok(
    "…and recomposes the prompt against the card as it reads NOW",
    (second.prompt ?? "").includes("second dispatch, different notes"),
    second.prompt ?? "",
  );

  // --- 5. the card now reports its task ---------------------------------------
  // The link is a live resource, so the decoration re-renders without a reload.
  // What changes is the TRIGGER LABEL and the panel behind it — not the name,
  // which stays `Todo`: the status moved to the card's foot.
  await page.waitForTimeout(1500);
  const dispatchedTrigger = page.getByRole("button", {
    name: "TODO card's agent run",
  });
  const reports = (await dispatchedTrigger.count()) > 0;
  r.ok(
    "the card's glyph switches to reporting the task it is bound to",
    reports,
    `buttons named "TODO card's agent run": ${await dispatchedTrigger.count()}`,
  );

  if (reports) {
    await dispatchedTrigger.first().click();
    await page.waitForTimeout(600);
    await snap(page, out, "2-panel-after-dispatch");
    r.ok(
      "the panel leads with the task, and offers another dispatch below it",
      (await page.getByText("Dispatched", { exact: true }).count()) > 0 &&
        (await page.getByText("Dispatch another agent").count()) > 0,
      "task header + `Dispatch another agent` form",
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  // The corner name is the card's NAME again, dispatched or not. It used to
  // become the task's status here (`NEW`, `RUNNING`) and stop hiding with it;
  // the foot's chips say that now, so the name went back to being worth nothing
  // at rest. Asserted as "no status word anywhere on the card", since the name
  // itself is hover-revealed and absent from the accessible tree at rest.
  r.ok(
    "a dispatched card does NOT spell the task's status in its corner",
    (await page.getByText("New", { exact: true }).count()) === 0,
    "the status lives at the card's foot, not in its name",
  );

  // --- 6. the foot costs the card nothing until there is a run ----------------
  // The card is dispatched but nothing has been launched, so `TodoRuns` has no
  // conversation to chip and renders nothing — and a foot that renders nothing
  // must reserve no space at all, or every TODO card on every page would pay a
  // row for an act most of them never perform. A foot is flow content inside the
  // box, so the box's own height is the whole assertion.
  const boxAfter = (await cardBox(page))?.height;
  r.ok(
    "a dispatched card with no run yet is exactly as tall as before — an empty foot reserves nothing",
    boxBefore !== undefined &&
      boxAfter !== undefined &&
      Math.abs(boxAfter - boxBefore) < 1,
    JSON.stringify({ boxBefore, boxAfter }),
  );

  // --- 7. a settled task repaints the card ------------------------------------
  // The box is the one thing a reader sees WITHOUT opening anything, so it is
  // the assertion that matters most: dropping the task must fade the card from
  // the family's `warning` hue. Read as a computed colour rather than a class
  // name — the tint is a token, and what is under test is that the frame
  // re-rendered at all.
  const beforeDrop = await cardTint(page);
  const dropRes = await pageFetch(page, `/api/tasks/${first.taskId!}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ drop: true }),
  });
  if (!dropRes.ok)
    throw new Error(`PATCH task ${dropRes.status}: ${await dropRes.text()}`);
  // POLLED, not slept on. The repaint arrives with the `tasks` push, which is
  // sub-second in the ordinary case — but a fixed wait turns "usually fast
  // enough" into a test that fails on the run where a burst of writes queued
  // ahead of it. The deadline is what the assertion is actually about.
  const afterDrop = await waitForTintChange(page, beforeDrop);
  await snap(page, out, "3-card-dropped");
  r.ok(
    "dropping the task repaints the card's tint",
    beforeDrop !== undefined &&
      afterDrop !== undefined &&
      beforeDrop !== afterDrop,
    JSON.stringify({ beforeDrop, afterDrop }),
  );

  // --- 8. only a TODO card can dispatch ---------------------------------------
  // The card's own first child is a plain text block — a real id of the right
  // shape that is simply the wrong type, which is the mistake worth refusing.
  const childId = rows.find((b) => b.parentId === cardId)?.id;
  if (childId === undefined) {
    r.fail("the card has a first child to probe with", JSON.stringify(rows));
  } else {
    const refused = await dispatch(page, childId, "");
    r.ok(
      "a non-TODO block is refused with a 400 naming the type it actually is",
      refused.status === 400 && (refused.body ?? "").includes("text"),
      JSON.stringify(refused),
    );
  }

  await r.finish();
});
