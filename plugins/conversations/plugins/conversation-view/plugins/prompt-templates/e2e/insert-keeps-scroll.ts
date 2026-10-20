/**
 * Prompt-template insert must not move the editor's scroll or steal focus.
 *
 * Puts a long draft in the conversation prompt editor, parks the view where the
 * user would be reading it, clicks a template chip, and reports what happened to
 * the editor's scroll position, its focus, and where the text landed.
 *
 * `--caret` selects how the draft got there, because that decides where Lexical
 * thinks the caret is:
 *   typed    — typed at the keyboard: caret at the end, view at the bottom
 *   restored — seeded into localStorage and reloaded, never clicked into
 *   end/middle — seeded, then clicked to place the caret
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/prompt-templates/e2e/insert-keeps-scroll.ts \
 *     --conv <id> [--caret typed|restored|end|middle] [--panel] [--out <prefix>] [--headed]
 *
 * `--panel` opens the template panel first (and screenshots it to `--out`).
 */
import {
  arg,
  snap,
  boot,
  flag,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const EDITOR = '[data-lexical-editor="true"]';

const LONG_DRAFT = Array.from(
  { length: 40 },
  (_, i) => `line ${i + 1} — some reasonably long draft text to make it scroll`,
).join("\n");

await withBrowser(async (h) => {
  const convId = requireArg(
    "conv",
    "--conv <conversation-id> [--caret typed|restored|end|middle] [--panel]",
  );
  const caret = arg("caret") ?? "end";
  const r = report(`prompt-template insert — caret:${caret}`);
  const { page } = await h.session();
  const url = pathUrl(`/agents/c/${convId}`);

  await page.goto(url);
  if (caret !== "typed") {
    await page.evaluate(
      ({ id, text }) => {
        localStorage.setItem(
          `s:conversations.prompt-draft:${id}`,
          JSON.stringify({ v: text, ts: Date.now() }),
        );
      },
      { id: convId, text: LONG_DRAFT },
    );
  }
  await boot(page, url, { marker: EDITOR, settleMs: 2000, timeoutMs: 90_000 });

  const editor = page.locator(EDITOR).first();
  if (caret === "typed") {
    // Never presses Enter — that would send the turn.
    await editor.click();
    await page.keyboard.insertText(LONG_DRAFT);
  } else if (caret === "restored") {
    // The restore path: the draft came back from localStorage and the user
    // only scrolled — they never clicked into the field.
    await editor.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  } else {
    await editor.evaluate((el, mode) => {
      el.scrollTop =
        mode === "middle" ? Math.round(el.scrollHeight / 2) : el.scrollHeight;
    }, caret);
    const box = (await editor.boundingBox())!;
    await page.mouse.click(box.x + 40, box.y + box.height - 12);
  }
  await page.waitForTimeout(600);

  const read = () =>
    editor.evaluate((el) => ({
      scrollTop: Math.round(el.scrollTop),
      maxScroll: el.scrollHeight - el.clientHeight,
      focused: document.activeElement === el,
      len: el.textContent?.length ?? 0,
    }));

  const before = await read();
  const beforeText = await editor.evaluate((el) => el.textContent ?? "");
  r.note(`before: ${JSON.stringify(before)}`);

  // Stamp every top-level block so we can tell a surgical text patch (blocks
  // survive) from a full re-render of the document (blocks replaced — which is
  // what resets a scroll container to the top).
  const blocksBefore = await editor.evaluate((el) => {
    [...el.children].forEach((c, i) => c.setAttribute("data-probe", String(i)));
    return el.children.length;
  });

  if (flag("panel")) {
    await page
      .locator("[data-ui-owner^='TemplateChipBar@'] .group\\/fa")
      .first()
      .hover();
    await page.waitForTimeout(700);
    await snap(page, arg("out") ?? "/tmp/insert-keeps-scroll", "panel");
  }

  // The ButtonGroup's send sibling and the overflow-clipped strip sit on top of
  // parts of the chips, so click the first one whose hit-point resolves to it.
  const target = await page.evaluate(() => {
    const buttons = [
      ...document.querySelectorAll<HTMLElement>(
        'button[data-ui-owner^="TemplateChip@"]',
      ),
    ].filter((b) => b.textContent?.trim());
    for (const b of buttons) {
      const box = b.getBoundingClientRect();
      const x = box.left + 8;
      const y = box.top + box.height / 2;
      if (b.contains(document.elementFromPoint(x, y))) {
        return { x, y, label: b.textContent?.trim() ?? "" };
      }
    }
    return null;
  });
  if (target === null) {
    r.fail("no clickable template chip found");
    await r.finish();
    return;
  }
  r.note(`clicked chip: ${target.label}`);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(1000);

  const after = await read();
  r.note(`after:  ${JSON.stringify(after)}`);

  // Where did the text actually land — at the caret the user left, or at the top?
  const afterText = await editor.evaluate((el) => el.textContent ?? "");
  let i = 0;
  while (i < beforeText.length && beforeText[i] === afterText[i]) i++;
  r.note(
    `inserted at char ${i}/${beforeText.length}: ${JSON.stringify(afterText.slice(i, i + 40))}`,
  );

  const survivors = await editor.evaluate(
    (el) => [...el.children].filter((c) => c.hasAttribute("data-probe")).length,
  );
  r.note(`blocks: ${blocksBefore} before, ${survivors} survived the insert`);

  r.ok(
    "template text was inserted",
    after.len > before.len,
    `${before.len} → ${after.len}`,
  );
  r.ok("editor keeps focus", after.focused, `focused=${after.focused}`);
  // The bug: the snippet landed at char 0 of a restored draft (the caret Lexical
  // parked there after re-applying `value`), not where the user was.
  r.ok(
    "text lands where the user was, not at the top",
    i > 0,
    `inserted at char ${i} of ${beforeText.length}`,
  );
  // …and the viewport followed it up there. The view may move FORWARD to keep
  // the caret visible — that is the caret staying in view — but it must never
  // travel backwards to the top of the field.
  r.ok(
    "the view never jumps backwards",
    after.scrollTop >= before.scrollTop - 40,
    `scrollTop ${before.scrollTop} → ${after.scrollTop} (max ${after.maxScroll})`,
  );
  await r.finish();
});
