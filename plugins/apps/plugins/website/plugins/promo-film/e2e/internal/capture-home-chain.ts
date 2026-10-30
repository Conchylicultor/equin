// Shots 1 and 2: the Home gallery (every tile as its own layer) and the
// integrated chain — a Pages wiki page, the conversation beside it, the
// conversation full, the file explorer, the .mid preview, Sonata playing.

import {
  type Ctx,
  byText,
  hideBar,
  open,
  panes,
  park,
  rect,
  shot,
  sweepNoise,
} from "./capture-kit";

const PAGE = "block-e5afc5b1-15f2-4614-a49a-c7b4e6fe1851"; // "Track: build and push speed"
export const CONV = "conv-1793181451-ym0h6f";
export const MIDI_DIR = "/files/at/~%2F__A__%2Fmidi";
export const MIDI_FILE = `${MIDI_DIR}/Fantaisie_Impromptu_Jazz_Version.mid`;
export const SONG = "song-e40a417e-0f4b-4641-8734-cb8396ba47df"; // the library song of that file
const CONV_TITLE = "Resource route drift";

export async function homeShot(c: Ctx): Promise<void> {
  const p = c.page;
  await open(p, "/home");
  await hideBar(p);
  await park(p);
  await shot(c, "home");
  const tiles = await p.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="button"][data-row-key]'),
    ).map((t) => {
      const r = t.getBoundingClientRect();
      const icon = t.firstElementChild!.getBoundingClientRect();
      return {
        key: t.getAttribute("data-row-key")!,
        r: { x: r.x, y: r.y, width: r.width, height: r.height },
        icon: { x: icon.x, y: icon.y, width: icon.width, height: icon.height },
      };
    }),
  );
  if (tiles.length < 10)
    throw new Error(`home: only ${tiles.length} tiles found`);
  for (const t of tiles) {
    const id = t.key.replace(/[^a-z0-9-]/gi, "-");
    c.manifest.rects[`tile-${id}`] = t.r;
    c.manifest.rects[`tile-${id}-icon`] = t.icon;
    await shot(c, `tile-${id}`, t.r);
    await shot(c, `tile-${id}-icon`, t.icon);
  }
  await p.evaluate(() => {
    for (const t of Array.from(
      document.querySelectorAll<HTMLElement>('[role="button"][data-row-key]'),
    ))
      t.style.visibility = "hidden";
  });
  await shot(c, "home-empty");
  console.log(
    `  home: ${tiles.length} tiles: ${tiles.map((t) => t.key).join(", ")}`,
  );
}

/** Replace the "Agents waiting…" page-link chip of the page's first paragraph with a native-looking conversation chip. */
async function injectConvChip(p: import("playwright").Page): Promise<void> {
  await p
    .getByText("Agents waiting 2 hours to push", { exact: true })
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
  await p.evaluate((title) => {
    const t = Array.from(document.querySelectorAll("span")).find(
      (e) =>
        e.children.length === 0 &&
        e.textContent === "Agents waiting 2 hours to push",
    );
    if (!t) throw new Error("pages: the first page-link chip was not found");
    t.textContent = title;
    const chip = t.closest("button");
    if (!chip) throw new Error("pages: the chip has no button");
    chip.setAttribute("data-film", "conv-chip");
  }, CONV_TITLE);
}

export async function chainShots(c: Ctx): Promise<void> {
  const p = c.page;
  // 1. The wiki page with its conversation link.
  await open(p, `/pages/page/${PAGE}`);
  await injectConvChip(p);
  await hideBar(p);
  await park(p);
  await shot(c, "chain-page");
  await rect(c, "chain-page-link", '[data-film="conv-chip"]');
  const pp = await panes(p);
  const page1 = pp.find((x) => x.id === "page-detail");
  if (page1) c.manifest.rects["chain-page-pane"] = page1.rect;

  // 2. The same page with the conversation as a side pane (a real Miller chain).
  await open(p, `/pages/page/${PAGE}/c/${CONV}`);
  await injectConvChip(p);
  await hideBar(p);
  await park(p);
  await shot(c, "chain-page-conv");
  await rect(c, "chain-page-conv-link", '[data-film="conv-chip"]');
  await recordPanes(c, "chain-page-conv");

  // 3. The conversation focused (agent manager, full).
  await open(p, `/agents/c/${CONV}`);
  await hideBar(p);
  await park(p);
  await shot(c, "chain-conv");
  await recordPanes(c, "chain-conv");

  // 4. The conversation with the file pane opened beside it.
  await open(p, `/agents/c/${CONV}/files`);
  await hideBar(p);
  await park(p);
  await shot(c, "chain-conv-files");
  await recordPanes(c, "chain-conv-files");

  // 5. The file explorer, full, on the midi folder.
  await open(p, MIDI_DIR);
  await hideBar(p);
  await park(p);
  await shot(c, "chain-files");
  await rect(
    c,
    "chain-files-mid-row",
    byText("Fantaisie_Impromptu_Jazz_Version.mid", { minH: 24, minW: 300 }),
  );

  // 6. The .mid selected: Sonata's own player as the preview pane beside the explorer.
  await open(p, MIDI_FILE, { settleMs: 3000 });
  await p
    .getByRole("button", { name: /Open in Sonata/ })
    .waitFor({ state: "visible", timeout: 45_000 });
  await p.waitForTimeout(2500);
  await hideBar(p);
  await park(p);
  await shot(c, "chain-files-mid");
  await recordPanes(c, "chain-files-mid");
  await rect(
    c,
    "chain-files-mid-open-sonata",
    () =>
      Array.from(document.querySelectorAll("button")).find((b) =>
        /Open in Sonata/.test(b.textContent ?? ""),
      ) ?? null,
  );
  await sweepNoise(p);
}

/** Rects of each pane column of the current chain as `<prefix>-pane-<n>-<id>`. */
async function recordPanes(c: Ctx, prefix: string): Promise<void> {
  const pp = await panes(c.page);
  if (pp.length === 0) throw new Error(`${prefix}: no pane columns found`);
  pp.forEach(
    (x, i) => (c.manifest.rects[`${prefix}-pane-${i}-${x.id}`] = x.rect),
  );
  for (const x of pp) c.manifest.rects[`${prefix}-pane-${x.id}`] = x.rect;
}
