// Reload drill: Sonata gives back where the user was in a song.
//
// Opens a song in the player, seeks the playhead (a click on the progress rail,
// then → a few bars) and speeds the tempo up (↑), then runs the reload drill
// (`e2e-harness` reload-drill.ts). The playhead and the tempo are kept view
// state (`sonata/session` kept-transport.ts), so the reload must give them
// back — paused. Both are sliders (the progress rail's "Song position", the
// "Playback speed" wheel), whose aria-valuenow the drill records and compares;
// the script also checks the drill really saw them moved off their defaults.
//
// Only reads: the song is picked from the deploy's database (any MIDI song with
// notes) unless --song names one.
//
// Usage: ./equin run plugins/apps/plugins/sonata/e2e/reload-drill.ts [--song <songId>] [--no-record] [--headed]
import type { Page } from "playwright";
import {
  arg,
  openDeployDb,
  pathUrl,
  reloadDrill,
  reloadDrillText,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/sonata-reload-drill";

async function pickSong(): Promise<string> {
  const given = arg("song");
  if (given) return given;
  const db = openDeployDb();
  try {
    const rows = await db.query<{ id: string }>(
      `SELECT s.id FROM sonata_songs s
         JOIN sonata_songs_ext_midi m ON m.parent_id = s.id
        WHERE NOT m.source_missing AND s.end_beat > 64
        ORDER BY s.created_at LIMIT 1`,
    );
    const id = rows[0]?.id;
    if (!id)
      throw new Error(
        "no MIDI song in this deploy's database — pass --song <id>",
      );
    return id;
  } finally {
    await db.close();
  }
}

const position = (page: Page) =>
  page.getByRole("slider", { name: "Song position" }).first();
const speed = (page: Page) =>
  page.getByRole("slider", { name: "Playback speed" }).first();

/** The player is up: the progress rail knows the song's length. */
async function waitPlayer(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = document.querySelector(
        '[role="slider"][aria-label="Song position"]',
      );
      return s !== null && Number(s.getAttribute("aria-valuemax")) > 0;
    },
    undefined,
    { timeout: 90_000 },
  );
}

const songId = await pickSong();

await withBrowser(async (h) => {
  const { page } = await h.session();
  const r = report("sonata: the playhead and tempo survive a reload");
  r.note(`song ${songId}`);
  await page.goto(pathUrl(`/sonata/song/${songId}`), {
    waitUntil: "domcontentloaded",
  });
  await waitPlayer(page);

  let speedBefore: string | null = null;
  let positionBefore: string | null = null;
  const drill = await reloadDrill(page, {
    step: async (p) => {
      const box = (await position(p).boundingBox())!;
      await p.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
      for (let i = 0; i < 3; i++) await p.keyboard.press("ArrowRight");
      for (let i = 0; i < 2; i++) await p.keyboard.press("ArrowUp");
      speedBefore = await speed(p).getAttribute("aria-valuenow");
      positionBefore = await position(p).getAttribute("aria-valuenow");
    },
    restore: waitPlayer,
    settleMs: 1000,
  });
  console.log(reloadDrillText(drill));
  await snap(page, OUT, "after-reload");

  const sliders = drill.before.items.filter((i) => i.kind === "value");
  r.ok(
    "the drill compared the playhead, moved off the start",
    positionBefore !== null &&
      Number(positionBefore) > 0 &&
      sliders.some((i) => i.value === positionBefore),
    `position ${positionBefore}; sliders ${JSON.stringify(sliders)}`,
  );
  r.ok(
    "the drill compared the tempo, moved off the default",
    speedBefore !== null &&
      Number(speedBefore) !== 1 &&
      Number(speedBefore) !== 100 &&
      sliders.some((i) => i.value === speedBefore),
    `speed ${speedBefore}`,
  );
  r.ok(
    "the reload gave everything back",
    drill.differences.length === 0 && drill.compared > 0,
    reloadDrillText(drill),
  );
  await r.finish();
});
