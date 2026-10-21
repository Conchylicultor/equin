// Verifies the per-frame version stepper: with two frames, stepping B back
// changes only B's document (A stays on its version), the label names the
// version on screen, and the ‹ › arrows never move while stepping — so clicking
// the same spot keeps stepping. (A version declaring other options renames the
// frame, which shifts the stepper after the name; that step is noted, and only
// the arrows' spacing is checked.) Stepping forward again returns B to where it
// started. Needs a prototype with at least three recorded versions.
// Manual only — nothing runs this automatically.
//
// Usage:
//   ./singularity run plugins/apps/plugins/prototypes/plugins/canvas/e2e/canvas-version.ts \
//     [--name <prototype id>] [--out <prefix>] [--headed]

import type { Page } from "playwright";
import {
  arg,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  card,
  frameDoc,
  letters,
  openCanvas,
  pickPrototype,
  addFrame,
} from "./driver";

const out = arg("out", "/tmp/canvas-version");
const meta = await pickPrototype();

/** Frame `letter`'s stepper: its arrows, where they sit, and its label. */
function stepper(page: Page, letter: string) {
  const group = card(page, letter).getByRole("group", { name: "Version" });
  const prev = group.getByRole("button", { name: "Previous version" });
  const next = group.getByRole("button", { name: "Next version" });
  return {
    prev,
    next,
    label: async () => (await group.innerText()).replace(/\s+/g, " ").trim(),
    /** The frame's name, just before the stepper in its header. */
    name: async () =>
      (
        await group.locator("xpath=../preceding-sibling::*[1]").innerText()
      ).trim(),
    arrows: async () => {
      const [p, n] = await Promise.all([
        prev.boundingBox(),
        next.boundingBox(),
      ]);
      return { prev: p?.x ?? -1, next: n?.x ?? -1 };
    },
  };
}

await withBrowser(async (h) => {
  const r = report(`canvas version — ${meta.title} (${meta.name})`);
  const { page, captured } = await h.session({
    viewport: { width: 1600, height: 1000 },
  });
  await openCanvas(page, meta.name);
  await addFrame(page);
  await waitFor(
    () => letters(page),
    (v) => v === "AB",
    { timeoutMs: 10_000 },
  );

  const shaOf = async (letter: string) =>
    (await frameDoc(page, meta, letter))?.sha;
  const a0 = await shaOf("A");
  const b0 = await shaOf("B");
  const s = stepper(page, "B");
  await s.prev.waitFor({ state: "visible", timeout: 10_000 });
  const arrows0 = await s.arrows();
  const label0 = await s.label();
  const name0 = await s.name();

  const seen: (string | null | undefined)[] = [b0];
  for (let i = 1; i <= 2; i++) {
    await s.prev.click();
    const stepped = await waitFor(
      () => shaOf("B"),
      (v) => v !== undefined && !seen.includes(v),
      { timeoutMs: 10_000 },
    );
    r.ok(`‹ steps B back (step ${i})`, stepped.ok, String(stepped.value));
    seen.push(stepped.value);
    r.eq(`…and A stays where it was (step ${i})`, await shaOf("A"), a0);
    const arrows = await s.arrows();
    const still =
      Math.abs(arrows.prev - arrows0.prev) < 0.5 &&
      Math.abs(arrows.next - arrows0.next) < 0.5;
    const name = await s.name();
    if (name === name0) {
      r.ok(
        `…and the arrows did not move (step ${i})`,
        still,
        `${JSON.stringify(arrows0)} → ${JSON.stringify(arrows)}`,
      );
    } else {
      // The stepper sits after the frame's name, and a version declaring
      // other options is named differently — so the whole stepper can shift.
      // The label's own width is what must hold: the arrows stay one span apart.
      r.ok(
        `…and the arrows kept their spacing (step ${i})`,
        Math.abs(arrows.next - arrows.prev - (arrows0.next - arrows0.prev)) <
          0.5,
        `${JSON.stringify(arrows0)} → ${JSON.stringify(arrows)}`,
      );
      r.note(
        `step ${i}: the frame's name changed ("${name0}" → "${name}"), so the stepper shifted ${(arrows.prev - arrows0.prev).toFixed(1)}px`,
      );
    }
  }
  const labelBack = await s.label();
  r.ok(
    "the label names the version on screen",
    labelBack !== label0,
    `${label0} → ${labelBack}`,
  );
  r.ok(
    "A's label is unchanged",
    (await stepper(page, "A").label()) === label0,
    await stepper(page, "A").label(),
  );
  await snap(page, out, "b-back");

  await s.next.click();
  await s.next.click();
  const home = await waitFor(
    () => shaOf("B"),
    (v) => v === b0,
    { timeoutMs: 10_000 },
  );
  r.ok("› twice returns B to where it started", home.ok, String(home.value));
  r.eq("…with its original label", await s.label(), label0);

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
