/**
 * The Sonata library sorts and filters by fields OTHER plugins expose
 * (playback-history's play stats) on the server, and follows their writes
 * live.
 *
 *  1. opens the library's "All" table and applies the "Recently played" sort
 *     preset (`lastPlayedAt desc`, an exposed field);
 *  2. records a play of a song that is NOT at the top — through the API, as a
 *     second tab's player would — and asserts the song moves to the top of the
 *     open table, without a reload, with its Plays cell counting the new play;
 *  3. applies the "Unplayed" filter preset (`playCount = 0`) and asserts it
 *     lists songs, every one of them "Not played yet" (a never-played song has
 *     no playback row: the join reads the extension's default, 0), and not the
 *     song just played.
 *
 * The preset clicks write the "All" view's sort and filter into this deploy's
 * library view config; the harness's agent-write ledger (`withBrowser`) puts
 * the file back when the run ends. The play is real: the song keeps it — so
 * the script refuses main (`singularity`), whose play stats are the user's,
 * and runs against a worktree deploy, whose database is a throwaway fork.
 *
 * It reads the whole library in one window (`limit` = the collection's
 * `maxLimit`, 500) to pick its target and count the never-played songs, and
 * refuses a larger library rather than reason over a partial one. The
 * Unplayed count is compared exactly only while it fits on screen (rows past
 * the viewport, or past the first page, are not rendered).
 *
 * Manual only — nothing runs this automatically.
 *   ./singularity run plugins/apps/plugins/sonata/plugins/library/e2e/library-live-sort.ts [--headed]
 */
import type { Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  targetNamespace,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

if (String(targetNamespace()) === "singularity") {
  throw new Error(
    "refusing to record a play on main — its play stats are the user's; run this against a worktree deploy",
  );
}

const OUT = arg("out") ?? "/tmp/library-live-sort";
/** The collection's `maxLimit`: the whole library must fit in one window read. */
const WHOLE_LIBRARY = 500;
/** Unplayed rows the default viewport renders for certain — the exact-count bound. */
const ON_SCREEN = 10;
const BOOT_TIMEOUT_MS = 120_000;
const TABS_READY = 'button[title="All"]';

interface SongRow {
  id: string;
  title: string;
  // The playback exposure's slice: `<parent>_ext_<name>` (entity-extensions).
  $columns: {
    sonata_songs_ext_playback: {
      playCount: number;
      lastPlayedAt: string | null;
    };
  };
}

/** Every song, as the library collection serves it (one window, over HTTP). */
async function librarySongs(page: Page): Promise<SongRow[]> {
  const res = await page.request.get(
    pathUrl(`/api/resources/sonata.songs?limit=${WHOLE_LIBRARY}`),
  );
  if (!res.ok()) throw new Error(`sonata.songs read: HTTP ${res.status()}`);
  const body = (await res.json()) as { value: SongRow[] };
  if (body.value.length >= WHOLE_LIBRARY) {
    throw new Error(
      `the library holds ${WHOLE_LIBRARY}+ songs — more than one window reads, so the target pick and the Unplayed count would be over a partial library`,
    );
  }
  return body.value;
}

/** The table's rows, top to bottom: each one's full text. */
async function tableRows(page: Page): Promise<string[]> {
  const rows = await page
    .locator('div[role="button"].col-span-full')
    .evaluateAll((els) =>
      els.map((el) => ({
        text: el.textContent ?? "",
        top: el.getBoundingClientRect().top,
      })),
    );
  return rows.sort((a, b) => a.top - b.top).map((r) => r.text);
}

/** Open a toolbar control and click one of its saved presets. */
async function applyPreset(
  page: Page,
  trigger: string,
  preset: string,
): Promise<void> {
  await page.locator(trigger).first().click();
  await page.getByText(preset, { exact: true }).first().click();
  await page.keyboard.press("Escape");
}

await withBrowser(async (h) => {
  const r = report("sonata library — exposed fields, sorted live");
  const { page } = await h.session();

  await boot(page, pathUrl("/sonata"), {
    marker: TABS_READY,
    timeoutMs: BOOT_TIMEOUT_MS,
    settleMs: 500,
  });
  await page.locator(TABS_READY).first().click();
  await page.keyboard.press("Escape");

  // ---- 1. "Recently played": sorted by an exposed field --------------
  await applyPreset(page, 'button[aria-label^="Sort"]', "Recently played");
  const songs = await librarySongs(page);
  const byRecent = [...songs].sort((a, b) =>
    (b.$columns.sonata_songs_ext_playback.lastPlayedAt ?? "").localeCompare(
      a.$columns.sonata_songs_ext_playback.lastPlayedAt ?? "",
    ),
  );
  // A played song a few rows down, whose title no other song shares (so its
  // row is unambiguous) — it will be the one played again. Already played, so
  // the Unplayed count below does not depend on this play.
  const titleCount = new Map<string, number>();
  for (const s of songs) {
    titleCount.set(s.title, (titleCount.get(s.title) ?? 0) + 1);
  }
  const target = byRecent
    .slice(3)
    .find(
      (s) =>
        titleCount.get(s.title) === 1 &&
        s.title.length > 3 &&
        s.$columns.sonata_songs_ext_playback.lastPlayedAt !== null,
    );
  if (target === undefined) {
    throw new Error(
      "no uniquely-titled, already-played song below the top three to play",
    );
  }
  const top = await waitFor(
    () => tableRows(page),
    (rows) =>
      rows.length > 3 &&
      rows[0]!.includes(byRecent[0]!.title) &&
      !rows[0]!.includes(target.title),
    { timeoutMs: 60_000 },
  );
  r.ok(
    "the table is sorted by last played (an exposed field), the target below the top",
    top.ok,
    `first row: ${top.value[0] ?? "(none)"}`,
  );
  await snap(page, OUT, "recently-played");
  const playsBefore = target.$columns.sonata_songs_ext_playback.playCount;

  await page.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });

  // ---- 2. a play elsewhere moves the song to the top ---------------------
  const played = await page.request.post(
    pathUrl(`/api/sonata/songs/${encodeURIComponent(target.id)}/play`),
  );
  r.ok("the play is recorded", played.ok(), `HTTP ${played.status()}`);
  const moved = await waitFor(
    () => tableRows(page),
    (rows) => (rows[0] ?? "").includes(target.title),
    { timeoutMs: 30_000 },
  );
  r.ok(
    `"${target.title}" moves to the top without a reload`,
    moved.ok,
    `first row after ${moved.waitedMs}ms: ${moved.value[0] ?? "(none)"}`,
  );
  r.note(`the move landed after ${moved.waitedMs}ms`);
  const want = playsBefore + 1;
  r.ok(
    `its Plays cell counts the new play (${want})`,
    (moved.value[0] ?? "").includes(`${want} ${want === 1 ? "play" : "plays"}`),
    moved.value[0],
  );
  r.ok(
    "the page was never reloaded",
    await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload === true,
    ),
  );
  await snap(page, OUT, "after-play");

  // ---- 3. "Unplayed": filtered by a defaulted exposed field --------
  await applyPreset(
    page,
    'button[aria-label^="Filter"], button[aria-label$=" rule"], button[aria-label$=" rules"]',
    "Unplayed",
  );
  const neverPlayed = songs.filter(
    (s) => s.$columns.sonata_songs_ext_playback.playCount === 0,
  );
  r.note(`${neverPlayed.length} song(s) never played`);
  // Exact while every never-played song renders; past that, the rendered rows
  // are a prefix (the viewport, the first page), so only their content counts.
  const exact = neverPlayed.length <= ON_SCREEN;
  const unplayed = await waitFor(
    () => tableRows(page),
    (rows) =>
      (exact ? rows.length === neverPlayed.length : rows.length >= ON_SCREEN) &&
      rows.every((row) => row.includes("Not played yet")),
    { timeoutMs: 30_000 },
  );
  r.ok(
    exact
      ? "Unplayed lists exactly the never-played songs (no playback row reads as 0)"
      : `Unplayed lists only never-played songs (${neverPlayed.length} exist; the rendered prefix is checked)`,
    unplayed.ok && neverPlayed.length > 0,
    `${unplayed.value.length} rows: ${JSON.stringify(unplayed.value.slice(0, 3))}`,
  );
  r.ok(
    "…and not the song just played",
    !unplayed.value.some((row) => row.includes(target.title)),
  );
  await snap(page, OUT, "unplayed");
  await r.finish();
});
