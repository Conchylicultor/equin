import type { Page } from "playwright";

/**
 * A contextual tip's card as the stage draws it (`web/components/stage.tsx`:
 * the card with `data-variant="tip"`, shown while `data-on`), and its one
 * button — Got it (or the hint's own `gotIt` label).
 */
const SHOWN_TIP_BUTTON =
  '.hint-card[data-variant="tip"][data-on="true"] button';

/** The pages already answering their tips. */
const answering = new WeakSet<Page>();

/**
 * Answers every contextual tip that shows on `page` from now on, the moment it
 * would be in the way (Playwright's locator handler: checked before each
 * action; the tip's own Got it pressed without moving the pointer). For a
 * script that drives an app on a fresh seen state — the demo's, where every
 * tip is new — and is not about the tips: a tip's card sits over the page and
 * would take the click meant for what is under it. Tours are not touched (a
 * script that meets one drives it).
 */
export async function answerTipsAsTheyShow(page: Page): Promise<void> {
  // Once per page: a script may reach it from several steps (boot, then a
  // reload's re-entry), and a second handler would answer the same card twice.
  if (answering.has(page)) return;
  answering.add(page);
  await page.addLocatorHandler(
    page.locator(SHOWN_TIP_BUTTON),
    // A click dispatched on the button, never a pointer move: the script may
    // be holding the pointer somewhere (hovering the launcher to open its
    // grid), and moving it off would undo what it was doing.
    // Clicked in the page, never waited for: a tip is the demo's shared
    // data, so another tab answering it takes the card off this one too —
    // a button gone by now is answered already.
    async () => {
      await page.evaluate((selector) => {
        for (const button of document.querySelectorAll<HTMLElement>(selector))
          button.click();
      }, SHOWN_TIP_BUTTON);
    },
  );
}
