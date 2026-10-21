// Verifies the canvas's frame management on a prototype that declares options:
// `+ Frame` adds a copy of the LAST prototype frame; frame B's option picks are
// its own (picking one leaves A alone); a linked option follows in every frame;
// spreading an option lays out one frame per value and gathers back; Keep only
// closes the others and Undo puts them back; Close removes one frame, and the
// last frame left has no Close.
// Manual only — nothing runs this automatically. Frame A's picks are the
// prototype's shared record; the harness reverts what this run wrote to it.
//
// Usage:
//   ./singularity run plugins/apps/plugins/prototypes/plugins/canvas/e2e/canvas-frames.ts \
//     [--name <prototype id>] [--out <prefix>] [--headed]

import {
  arg,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { humanizeToken } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  card,
  dismiss,
  frameAction,
  frameDoc,
  frameValue,
  hoverCard,
  letters,
  openCanvas,
  openOptions,
  optionRow,
  pickPrototype,
  spreadableOption,
  addFrame,
} from "./driver";

const out = arg("out", "/tmp/canvas-frames");
const meta = await pickPrototype();
const option = spreadableOption(meta);
const label = humanizeToken(option.name);

await withBrowser(async (h) => {
  const r = report(
    `canvas frames — ${meta.title} (${meta.name}), option ${option.name}`,
  );
  const { page, captured } = await h.session({
    viewport: { width: 1600, height: 1000 },
  });
  await openCanvas(page, meta.name);
  const waitLetters = (want: string) =>
    waitFor(
      () => letters(page),
      (v) => v === want,
      { timeoutMs: 10_000 },
    );
  const waitValue = (letter: string, want: string) =>
    waitFor(
      () => frameValue(page, meta, letter, option.name),
      (v) => v === want,
      { timeoutMs: 10_000 },
    );

  r.eq("the bare URL opens frame A alone", await letters(page), "A");
  const a0 = await frameDoc(page, meta, "A");
  if (!a0) throw new Error("frame A has no document");
  const aValue = a0.values[option.name]!;

  // + Frame: a copy of the last prototype frame (here, A).
  await addFrame(page);
  const two = await waitLetters("AB");
  r.ok("+ Frame adds frame B", two.ok, two.value);
  const b0 = await waitFor(
    () => frameDoc(page, meta, "B"),
    (d) => d !== null,
    { timeoutMs: 10_000 },
  );
  r.eq("B opens on A's picks", b0.value?.values, a0.values);
  r.eq("B opens on A's version", b0.value?.sha, a0.sha);

  // B picks a value of its own; A does not follow.
  const bValue = option.values.find((v) => v !== aValue)!;
  let popover = await openOptions(page, "B");
  await popover
    .getByRole("radiogroup", { name: label })
    .getByRole("radio", { name: new RegExp(`^${humanizeToken(bValue)}`) })
    .click();
  const bPicked = await waitValue("B", bValue);
  r.ok(`B shows ${option.name}=${bValue}`, bPicked.ok, String(bPicked.value));
  r.eq(
    "A keeps its own value",
    await frameValue(page, meta, "A", option.name),
    aValue,
  );
  await snap(page, out, "b-picked");

  // Link from B: A takes B's value; a later pick in B reaches A too.
  await optionRow(popover, label)
    .getByRole("button", { name: "Keep the same in every frame" })
    .click();
  const linked = await waitValue("A", bValue);
  r.ok("linking from B gives A B's value", linked.ok, String(linked.value));
  const third = option.values.find((v) => v !== aValue && v !== bValue)!;
  await popover
    .getByRole("radiogroup", { name: label })
    .getByRole("radio", { name: new RegExp(`^${humanizeToken(third)}`) })
    .click();
  const followA = await waitValue("A", third);
  const followB = await waitValue("B", third);
  r.ok(
    "a linked pick reaches every frame",
    followA.ok && followB.ok,
    `A=${String(followA.value)} B=${String(followB.value)}`,
  );
  await optionRow(popover, label)
    .getByRole("button", { name: /click to unlink/ })
    .click();
  await popover
    .getByRole("radiogroup", { name: label })
    .getByRole("radio", { name: new RegExp(`^${humanizeToken(bValue)}`) })
    .click();
  await waitValue("B", bValue);
  r.eq(
    "unlinked, A no longer follows B",
    await frameValue(page, meta, "A", option.name),
    third,
  );
  await dismiss(page);

  // + Frame copies the LAST frame (B), not A.
  await addFrame(page);
  const three = await waitLetters("ABC");
  r.ok("+ Frame adds frame C", three.ok, three.value);
  const cCopy = await waitValue("C", bValue);
  r.ok("C is a copy of the last frame (B)", cCopy.ok, String(cCopy.value));

  // Keep only B, then Undo.
  await frameAction(page, "B", /Keep only this frame/);
  const kept = await waitLetters("A");
  r.ok("Keep only leaves one frame", kept.ok, kept.value);
  r.eq(
    "the kept frame is B's (now A)",
    (await waitValue("A", bValue)).value,
    bValue,
  );
  await page.getByRole("button", { name: "Undo" }).click();
  const undone = await waitLetters("ABC");
  r.ok("Undo puts the closed frames back", undone.ok, undone.value);
  const aBack = await waitValue("A", third);
  r.ok("…with A's picks as they were", aBack.ok, String(aBack.value));

  // Spread over the option from A: one frame per value, then gather back.
  popover = await openOptions(page, "A");
  await optionRow(popover, label)
    .getByRole("button", { name: `One frame per ${label.toLowerCase()}` })
    .click();
  const spreadLetters = "ABCDEFGHIJ".slice(0, option.values.length);
  const spread = await waitLetters(spreadLetters);
  r.ok(
    `spreading lays out one frame per value (${option.values.length})`,
    spread.ok,
    spread.value,
  );
  const shown = await waitFor(
    async () =>
      Promise.all(
        [...spreadLetters].map((l) => frameValue(page, meta, l, option.name)),
      ),
    (vs) => vs.every((v) => v !== null),
    { timeoutMs: 20_000 },
  );
  r.eq(
    "each spread frame shows one value, in declared order",
    shown.value,
    option.values,
  );
  await page.mouse.move(2, 2);
  await snap(page, out, "spread");
  popover = await openOptions(page, "A");
  await optionRow(popover, label)
    .getByRole("button", { name: "Gather back into one frame" })
    .click();
  const gathered = await waitLetters("A");
  r.ok("gathering back leaves one frame", gathered.ok, gathered.value);

  // Close: add two, close the middle one, then close down to one.
  await addFrame(page);
  await addFrame(page);
  await waitLetters("ABC");
  await frameAction(page, "B", "Remove from canvas");
  const closedB = await waitLetters("AB");
  r.ok("Close removes that frame", closedB.ok, closedB.value);
  await frameAction(page, "B", "Remove from canvas");
  await waitLetters("A");
  await hoverCard(page, "A");
  r.eq(
    "the last frame has no Close",
    await card(page, "A")
      .getByRole("button", { name: "Remove from canvas" })
      .count(),
    0,
  );

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
