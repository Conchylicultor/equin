// Verifies the website's Improve button end to end, on the landing page:
//
//   - the header shows Improve and no "Get in touch"; the footer carries the
//     email and the GitHub link; the contact band is two cards and no link row;
//   - opening the panel focuses the field, and "Show me" is disabled until
//     there is text; a closed-and-reopened panel keeps the draft;
//   - after "Show me", "File it" is live at once — before the second step
//     finishes — and links to the repo's new-issue form with the typed title and
//     a body naming the page; nothing opens a tab until it is clicked;
//   - the steps reach done, ending on "Preview is live" with Auto-deploy off and
//     "Merged & deployed" with it on; ⌘↵ in the field starts the replay;
//   - clicking "File it" opens the form in a new tab, closes the panel and
//     clears the draft;
//   - "Point to it on the page" hides the panel and shows the hint; hovering
//     the hero headline outlines it, and clicking it brings the panel back with
//     one chip at the caret, the text on both sides kept; Esc while pointing
//     brings the panel back with nothing added; the issue then titles the pick
//     by its label, and carries its raw tag in a collapsed, fenced block;
//   - under reduced motion the replay opens already finished;
//   - screenshots at 1280px and 420px.
//
// GitHub itself is never contacted: the new tab's request is answered by a stub.
//
// Usage:
//   ./equin run plugins/apps/plugins/website/plugins/improve/e2e/improve-verify.ts \
//     [--out /tmp/improve] [--headed]
//
// Manual only — nothing runs this automatically.

import type { Locator, Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  CONTACT_EMAIL,
  SOURCE_URL,
} from "@plugins/apps/plugins/website/plugins/shell/core";

const out = arg("out", "/tmp/improve");

const FIRST_LINE = "Show a 20-second demo under the headline";
const SECOND_LINE = "Muted, looping, no controls.";
const NEW_ISSUE = `${SOURCE_URL}/issues/new?`;
// The pick goes between these two, at a caret put there with the arrow keys.
const BEFORE_PICK = "Make the";
const AFTER_PICK = " bigger";
const MARKER = "text=Curious how equin came to be?";

/** The panel: base-ui's popover popup, found by its title in either view. */
function panel(page: Page): Locator {
  return page
    .getByRole("dialog")
    .filter({ hasText: /Improve this page|What equin would do now/ });
}

/**
 * The site header's Improve: the one in the same row as the site's wordmark.
 * A page-wide lookup is ambiguous on a full deploy, where the app's own
 * floating action bar carries a button named "Improve" too. Anchored on the
 * wordmark, not a nav link: on a narrow screen the nav links move into the
 * header's "⋯" panel, and the wordmark never does.
 */
function improveButton(page: Page): Locator {
  return page
    .getByRole("button", { name: "equin.", exact: true })
    .locator('xpath=ancestor::*[.//button[normalize-space()="Improve"]][1]')
    .getByRole("button", { name: "Improve", exact: true });
}

function field(page: Page): Locator {
  return panel(page).locator('[contenteditable="true"]');
}

/** Each replay step's state, top to bottom. */
async function stepStates(page: Page): Promise<string[]> {
  return panel(page)
    .locator("li[data-state]")
    .evaluateAll((lis) => lis.map((li) => li.getAttribute("data-state") ?? ""));
}

async function fieldHasFocus(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return (
      el instanceof HTMLElement &&
      el.isContentEditable &&
      el.closest('[role="dialog"]') !== null
    );
  });
}

/** The pick chips in the field: the inline chip renders as a non-editable button. */
function chips(page: Page): Locator {
  return field(page).locator('button[contenteditable="false"]');
}

/** The field's text on either side of its one chip. */
async function aroundChip(
  page: Page,
): Promise<{ before: string; after: string } | null> {
  return field(page).evaluate((root) => {
    const chip = root.querySelector('button[contenteditable="false"]');
    if (!chip) return null;
    const before = document.createRange();
    before.setStart(root, 0);
    before.setEndBefore(chip);
    const after = document.createRange();
    after.setStartAfter(chip);
    after.setEnd(root, root.childNodes.length);
    return { before: before.toString(), after: after.toString() };
  });
}

/** The picker's overlay, which draws the hover outline and its label. */
function pickerOverlay(page: Page): Locator {
  return page.locator("[data-element-picker]");
}

async function openPanel(page: Page): Promise<void> {
  await improveButton(page).click();
  await panel(page).waitFor({ state: "visible", timeout: 10_000 });
  // The editor is code-split: wait for it before typing into it.
  await field(page).waitFor({ state: "visible", timeout: 10_000 });
}

/** The prefilled issue a "File it" link opens, read back out of its href. */
function readIssue(href: string | null) {
  const url = new URL(href ?? "about:blank");
  return {
    href: href ?? "",
    title: url.searchParams.get("title") ?? "",
    body: url.searchParams.get("body") ?? "",
  };
}

/** Wait for every step to be done, and report the last step's title. */
async function expectFinished(
  r: Report,
  page: Page,
  lastTitle: string,
  label: string,
): Promise<void> {
  const finished = await waitFor(
    () => stepStates(page),
    (s) => s.length === 5 && s.every((x) => x === "done"),
    { timeoutMs: 15_000, intervalMs: 100 },
  );
  r.ok(
    `${label}: every step reaches done`,
    finished.ok,
    JSON.stringify(finished.value),
  );
  const last = await panel(page).locator("li[data-state]").last().innerText();
  r.ok(
    `${label}: the last step reads "${lastTitle}"`,
    last.includes(lastTitle),
    last,
  );
}

await withBrowser(async (h) => {
  const r = report("website Improve");

  // --- 1280px -----------------------------------------------------------------
  const { page, context } = await h.session({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
  });
  // The one outside request this flow makes: answer it here, so the run never
  // depends on reaching GitHub.
  await context.route("https://github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "stub" }),
  );
  let tabsOpened = 0;
  context.on("page", () => tabsOpened++);

  await boot(page, pathUrl("/website"), { marker: MARKER, settleMs: 800 });

  // --- chrome: header, footer, contact band -----------------------------------
  const chrome = await page.evaluate(
    ({ email, source }) => {
      const story = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === "Story",
      );
      let header: HTMLElement | null = story ?? null;
      while (header && getComputedStyle(header).position !== "sticky") {
        header = header.parentElement;
      }
      const footer = document.querySelector("footer");
      // The innermost matching section — document order puts it last — so a
      // pane-level wrapper that happens to be a <section> is never mistaken
      // for the band.
      const band = [...document.querySelectorAll("section")]
        .filter((s) =>
          s.textContent.includes("Interested in supporting this vision?"),
        )
        .at(-1);
      return {
        headerFound: header !== null,
        headerText: header?.textContent ?? "",
        footerMail:
          footer?.querySelector(`a[href="mailto:${email}"]`)?.textContent ??
          null,
        footerSource: footer?.querySelector(`a[href="${source}"]`) != null,
        bandFound: band !== undefined,
        bandHeadings: band?.querySelectorAll("h2").length ?? 0,
        bandSource: band?.querySelector(`a[href="${source}"]`) != null,
        bandEmailText: band?.textContent.includes(email) ?? false,
      };
    },
    { email: CONTACT_EMAIL, source: SOURCE_URL },
  );
  r.ok("the site header is found", chrome.headerFound);
  r.ok(
    "the header offers Improve",
    chrome.headerText.includes("Improve"),
    chrome.headerText,
  );
  r.ok(
    'the header no longer says "Get in touch"',
    !chrome.headerText.includes("Get in touch"),
    chrome.headerText,
  );
  r.eq("the footer links the email", chrome.footerMail?.trim(), CONTACT_EMAIL);
  r.ok("the footer links the source on GitHub", chrome.footerSource);
  r.ok("the contact band is found", chrome.bandFound);
  r.eq("the contact band has two cards", chrome.bandHeadings, 2);
  r.ok(
    "the contact band has no link row",
    !chrome.bandSource && !chrome.bandEmailText,
    JSON.stringify(chrome),
  );

  // --- compose ------------------------------------------------------------------
  await openPanel(page);
  const focused = await waitFor(
    () => fieldHasFocus(page),
    (f) => f,
    {
      timeoutMs: 3_000,
      intervalMs: 100,
    },
  );
  r.ok("opening the panel focuses the field", focused.ok);
  const showMe = panel(page).getByRole("button", { name: "Show me" });
  r.ok(
    "Show me is disabled while the field is empty",
    await showMe.isDisabled(),
  );

  await page.keyboard.type(FIRST_LINE);
  await page.keyboard.press("Enter");
  await page.keyboard.type(SECOND_LINE);
  r.ok("Show me is enabled once there is text", await showMe.isEnabled());
  await snap(page, `${out}-1280`, "compose");

  // The draft survives the panel closing.
  await page.keyboard.press("Escape");
  await panel(page).waitFor({ state: "hidden", timeout: 5_000 });
  await openPanel(page);
  const kept = await field(page).innerText();
  r.ok(
    "a closed-and-reopened panel keeps the draft",
    kept.includes(FIRST_LINE) && kept.includes(SECOND_LINE),
    kept,
  );

  // --- replay, Auto-deploy off ----------------------------------------------------
  const pageUrl = page.url();
  await panel(page).getByRole("button", { name: "Show me" }).click();
  const fileIt = panel(page).getByRole("link", { name: "File it" });
  await fileIt.waitFor({ state: "visible", timeout: 5_000 });
  // Read at once: this must hold before the second step has finished.
  const early = {
    states: await stepStates(page),
    enabled: await fileIt.isEnabled(),
    disabledAttr: await fileIt.getAttribute("aria-disabled"),
    href: await fileIt.getAttribute("href"),
  };
  r.ok(
    "File it is live before the second step finishes",
    early.enabled &&
      early.disabledAttr !== "true" &&
      early.states[1] !== "done" &&
      early.href !== null,
    JSON.stringify(early),
  );
  const issue = readIssue(early.href);
  r.ok(
    "File it links to the repo's new-issue form",
    issue.href.startsWith(NEW_ISSUE),
    issue.href,
  );
  r.eq("the issue's title is the first line", issue.title, FIRST_LINE);
  r.ok(
    "the issue's body holds the idea and the page it was written on",
    issue.body.startsWith(`${FIRST_LINE}\n${SECOND_LINE}`) &&
      issue.body.includes(`Page: ${pageUrl}`),
    issue.body,
  );
  r.ok(
    "the issue's body records Auto-deploy off",
    issue.body.includes("Auto-deploy: no (review first)"),
    issue.body,
  );
  r.ok(
    "File it takes focus when the replay starts",
    await fileIt.evaluate((el) => el === document.activeElement),
  );

  await expectFinished(r, page, "Preview is live", "Auto-deploy off");
  r.eq("no tab opened before File it was clicked", tabsOpened, 0);
  await snap(page, `${out}-1280`, "replay-review");

  // --- File it ------------------------------------------------------------------------
  const [tab] = await Promise.all([
    context.waitForEvent("page", { timeout: 5_000 }),
    fileIt.click(),
  ]);
  await tab.waitForURL((u) => u.href.startsWith(NEW_ISSUE), { timeout: 5_000 });
  r.ok(
    "clicking File it opens the issue form in a new tab",
    tab.url().startsWith(NEW_ISSUE),
    tab.url(),
  );
  await tab.close();
  await panel(page).waitFor({ state: "hidden", timeout: 5_000 });
  r.ok("clicking File it closes the panel", !(await panel(page).isVisible()));

  await openPanel(page);
  const cleared = (await field(page).innerText()).trim();
  r.ok("filing clears the draft", cleared === "", JSON.stringify(cleared));

  // --- replay, Auto-deploy on, started with ⌘↵ ---------------------------------------
  await field(page).click();
  await page.keyboard.type(FIRST_LINE);
  const autoDeploy = panel(page).getByRole("switch", { name: /Auto-deploy/ });
  await autoDeploy.click();
  r.eq(
    "the Auto-deploy switch turns on",
    await autoDeploy.getAttribute("aria-checked"),
    "true",
  );
  const tabsBefore = tabsOpened;
  await field(page).click();
  await page.keyboard.press("ControlOrMeta+Enter");
  const started = await waitFor(
    () => panel(page).getByRole("link", { name: "File it" }).count(),
    (n) => n === 1,
    { timeoutMs: 3_000, intervalMs: 100 },
  );
  r.ok("⌘↵ in the field starts the replay", started.ok);
  const onIssue = readIssue(
    await panel(page)
      .getByRole("link", { name: "File it" })
      .getAttribute("href"),
  );
  r.ok(
    "the issue's body records Auto-deploy on",
    onIssue.body.includes("Auto-deploy: yes"),
    onIssue.body,
  );
  await expectFinished(r, page, "Merged & deployed", "Auto-deploy on");
  r.eq("the replay opens no tab by itself", tabsOpened, tabsBefore);
  await snap(page, `${out}-1280`, "replay-deployed");

  // --- pointing at the part to change -----------------------------------------------
  await page.keyboard.press("Escape");
  await panel(page).waitFor({ state: "hidden", timeout: 5_000 });
  await openPanel(page);
  await field(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(BEFORE_PICK + AFTER_PICK);
  for (let i = 0; i < AFTER_PICK.length; i++) {
    await page.keyboard.press("ArrowLeft");
  }
  const point = panel(page).getByRole("button", {
    name: "Point to it on the page",
  });
  await point.click();
  await panel(page).waitFor({ state: "hidden", timeout: 5_000 });
  r.ok("pointing hides the panel", !(await panel(page).isVisible()));
  const hint = page.getByText("Click the part you'd change", { exact: true });
  await hint.waitFor({ state: "visible", timeout: 5_000 });
  r.ok("pointing shows the hint", await hint.isVisible());

  const headline = page.locator("h1").filter({ hasText: "shaped by agents" });
  const target = await headline.boundingBox();
  if (!target) throw new Error("the hero headline has no box to point at");
  const at = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  await page.mouse.move(at.x, at.y);
  const outlined = await waitFor(
    () => pickerOverlay(page).innerText(),
    (text) => /\bh1\b|\bspan\b/.test(text),
    { timeoutMs: 3_000, intervalMs: 100 },
  );
  r.ok(
    "hovering the headline outlines it",
    outlined.ok,
    JSON.stringify(outlined.value),
  );
  await snap(page, `${out}-1280`, "pointing");
  await page.mouse.click(at.x, at.y);

  await panel(page).waitFor({ state: "visible", timeout: 5_000 });
  r.ok("a pick brings the panel back", await panel(page).isVisible());
  r.eq("the pick lands as one chip", await chips(page).count(), 1);
  const around = await aroundChip(page);
  r.ok(
    "the chip sits at the caret, the text on both sides kept",
    around?.before === BEFORE_PICK && around.after === AFTER_PICK,
    JSON.stringify(around),
  );
  // Polled: the insert focuses the field from Lexical's update callback, not
  // synchronously with the click.
  const refocused = await waitFor(
    () => fieldHasFocus(page),
    (f) => f,
    { timeoutMs: 3_000, intervalMs: 100 },
  );
  r.ok("after a pick the field has focus", refocused.ok);
  await snap(page, `${out}-1280`, "picked");

  await point.click();
  await panel(page).waitFor({ state: "hidden", timeout: 5_000 });
  await page.keyboard.press("Escape");
  await panel(page).waitFor({ state: "visible", timeout: 5_000 });
  r.ok(
    "Esc while pointing brings the panel back",
    await panel(page).isVisible(),
  );
  r.eq("Esc while pointing adds no chip", await chips(page).count(), 1);
  // Polled: focus moves in the effect that runs once the panel is back, a
  // beat after it becomes visible.
  const returned = await waitFor(
    () => point.evaluate((el) => el === document.activeElement),
    (f) => f,
    { timeoutMs: 3_000, intervalMs: 100 },
  );
  r.ok("after Esc, focus is back on the button that started it", returned.ok);

  await panel(page).getByRole("button", { name: "Show me" }).click();
  const picked = readIssue(
    await panel(page)
      .getByRole("link", { name: "File it" })
      .getAttribute("href"),
  );
  r.ok(
    "the issue's title names the pick, never its raw tag",
    picked.title.startsWith(BEFORE_PICK) &&
      picked.title.includes("[1]") &&
      !picked.title.includes("<ui-context"),
    picked.title,
  );
  r.ok(
    "the issue's body numbers the pick in the text",
    picked.body.split("\n---\n")[0]?.includes("[1]") ?? false,
    picked.body,
  );
  r.ok(
    "the issue's body carries the raw tag in a collapsed, fenced block",
    /<details><summary>\[1\] [^\n]*<\/summary>\n\n```html\n<ui-context [^\n]*<\/ui-context>\n```\n\n<\/details>/.test(
      picked.body,
    ),
    picked.body,
  );
  await snap(page, `${out}-1280`, "replay-picked");

  // --- 420px, reduced motion ----------------------------------------------------------
  const narrow = await h.session({
    viewport: { width: 420, height: 900 },
    colorScheme: "dark",
    label: "420",
  });
  await narrow.page.emulateMedia({ reducedMotion: "reduce" });
  await boot(narrow.page, pathUrl("/website"), {
    marker: MARKER,
    settleMs: 800,
  });
  r.ok(
    "at 420px the header still offers Improve",
    await improveButton(narrow.page).isVisible(),
  );
  await openPanel(narrow.page);
  await narrow.page.keyboard.type(FIRST_LINE);
  const box = await panel(narrow.page).boundingBox();
  r.ok(
    "at 420px the panel fits the viewport",
    box !== null && box.x >= 0 && box.x + box.width <= 420,
    JSON.stringify(box),
  );
  await snap(narrow.page, `${out}-420`, "compose");
  await panel(narrow.page).getByRole("button", { name: "Show me" }).click();
  await panel(narrow.page)
    .getByRole("link", { name: "File it" })
    .waitFor({ state: "visible", timeout: 5_000 });
  const reduced = await stepStates(narrow.page);
  r.ok(
    "under reduced motion the replay opens already finished",
    reduced.length === 5 && reduced.every((s) => s === "done"),
    JSON.stringify(reduced),
  );
  await snap(narrow.page, `${out}-420`, "replay");

  await r.finish();
});
