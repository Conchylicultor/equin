// Photographs the piano with a chord actually LIT, which is the one thing
// `trainer/e2e/trainer-verify.ts` cannot tell you: it checks that the right
// keys light, not that a lit key, its doubled bass and the keys beside them
// read against each other.
//
// The keyboard lights nothing until the round is checked (that is what stops it
// giving the answer away), so this fills the round first, then clicks a chord.
// It also presses a key, so the shot carries a held key beside the lit chord.
//
// Usage:
//   ./equin run plugins/apps/plugins/chord/plugins/piano/e2e/piano-shot.ts [--out /tmp/piano] [--headed]
//
// Mutates server state: records one checked round, like any trainer run.

import {
  agentFetch,
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { chordKeyPlan } from "@plugins/apps/plugins/chord/plugins/vocabulary/core";
import {
  SelectionSchema,
  practisedChords,
} from "@plugins/apps/plugins/chord/plugins/curriculum/core";
import { ensureReady } from "@plugins/apps/plugins/chord/plugins/song-index/e2e";
import { z } from "zod";

const r = report("chord piano — a lit chord");
const out = arg("out") ?? "/tmp/chord-piano";

/** An answer box, asked or given. */
const BOX = 'button[aria-label^="Chord "][aria-label*=" beat"]';
const ASKED_BOX = `${BOX}:not([aria-label*=", given"])`;

const res = await agentFetch("/api/resources/chord.curriculum");
if (!res.ok) throw new Error(`chord.curriculum → HTTP ${res.status}`);
const { value } = z.object({ value: z.unknown() }).parse(await res.json());
const curriculum = SelectionSchema.parse(value);

// The digits that answer on their own: one press is one chord, and the chord
// behind the press is not in doubt.
const solo = chordKeyPlan(practisedChords(curriculum)).filter(
  (group) => group.tokens.length === 1,
);
const first = solo[0];
if (first === undefined) {
  throw new Error("No chord answers on a digit of its own — nothing to click");
}

await ensureReady(r, 10 * 60_000);

await withBrowser(async ({ session }) => {
  const { page, captured } = await session({
    viewport: { width: 1320, height: 1000 },
  });
  await boot(page, pathUrl("/chord"), { marker: BOX, timeoutMs: 120_000 });

  // Fill every asked box, which checks the round.
  const asked = await page.locator(ASKED_BOX).count();
  for (let i = 0; i < asked; i++) {
    await page.keyboard.press(first.digit);
  }
  await page
    .locator(`${BOX}[aria-label$=", right"], ${BOX}[aria-label$=", wrong"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });

  // A chord button after the check plays that chord and lights its notes.
  await page.locator(`button[aria-keyshortcuts="${first.digit}"]`).click();
  const lit = page.locator("[data-pitch]:has(.chord-key-label)");
  await lit.first().waitFor({ state: "visible", timeout: 10_000 });
  const bass = await page.locator(".chord-key-label[data-bass]").count();
  r.note(`lit ${String(await lit.count())} keys, ${String(bass)} of them bass`);
  r.ok("the doubled bass is drawn as the bass", bass === 1, String(bass));

  const shot = await snap(page, out, "lit");
  r.ok("the chord shot was taken", shot.ok, shot.path);

  // A key held down: pressing it sounds it on the piano and lights it, which is
  // what makes the keyboard an instrument rather than a picture. The pointer is
  // left down for the shot, then released.
  const key = page.locator('[data-pitch="72"]');
  const box = await key.boundingBox();
  if (box === null) {
    r.fail("C5 is on the keyboard", "no box for [data-pitch='72']");
  } else {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 6);
    await page.mouse.down();
    const held = await snap(page, out, "held");
    r.ok("the held-key shot was taken", held.ok, held.path);
    await page.mouse.up();
  }

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join("\n"),
  );
});

await r.finish();
