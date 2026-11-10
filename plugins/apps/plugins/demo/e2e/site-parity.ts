/**
 * The demo looks the same wherever it runs: on main's `/demo` (a page that
 * bundles every plugin) and in the standalone website's live demo (a page that
 * holds the demo's plugins only on demand). A `<PluginScope>` is served by its
 * own root hosts (`RootScope` "each", web-sdk), so nothing the page around it
 * bundles or paints reaches inside — this script holds the screens that used
 * to differ:
 *
 *  1. Sonata's library: the "Switch apps" first-time tip shows (the demo has
 *     met none), and Got it answers it;
 *  2. the chord colours are Sonata's (`--chord-1` resolves inside the embed),
 *     and every glyph of an app's own icon family the embed draws resolves to
 *     a symbol in the document (none blank);
 *  3. the page's theme stays out: the embed's tokens are the demo's own, the
 *     same on both pages (printed, and written to `tokens.json` under `--out`
 *     for a side-by-side) — never the website's;
 *  4. a song, Places and Files, as screenshots;
 *  5. the apps list in one order: the Home gallery's tiles are the launcher's,
 *     in the app rail's authored order (`useListedApps`) — never the raw
 *     registration order, which put Settings first on the website (printed, and
 *     written to `apps.json` under `--out`);
 *  6. Settings opens on Config, which lists the demo's configs grouped by
 *     plugin; Keyboard Party's opens, its Scene set to Paper is kept across a
 *     reload, and the party's stage paints it — every write answered by the
 *     demo's worker, never an `/api/config…` request to the page's server.
 *
 * Run it on both builds and compare the shots and `tokens.json`:
 *   ./equin run plugins/apps/plugins/demo/e2e/site-parity.ts --out /tmp/parity-main
 *   ./equin run plugins/apps/plugins/demo/e2e/site-parity.ts --site --composition website --out /tmp/parity-site
 *
 * Manual only — nothing runs this automatically.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, Request } from "playwright";
import {
  arg,
  flag,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Settled,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  launcherTiles,
  openLauncherGrid,
  closeLauncherGrid,
} from "@plugins/apps-core/plugins/app-launcher/e2e";
import { ENTER_DEMO, RENDER_TIMEOUT_MS, demoPath } from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-site-parity";
/** Drive the standalone website's live demo instead of `/demo`. */
const SITE = flag("site");

const SHOWN_TIP = '.hint-card[data-variant="tip"][data-on="true"]';
/** The tokens compared across the two pages, read inside the embed. */
const TOKENS = [
  "--background",
  "--foreground",
  "--primary",
  "--font-sans",
  "--radius",
  "--chord-1",
  "--place-food",
  "--file-ts",
] as const;

/** The demo at `location` (an app-rooted route), on this run's page. */
function demoUrl(location: string): string {
  return SITE
    ? pathUrl(`/website;view.website.demo=${encodeURIComponent(location)}`)
    : pathUrl(demoPath(location));
}

/** Open the demo at `location` and wait for the embed to render `app`. */
async function open(page: Page, location: string, app: string): Promise<void> {
  await page.goto(demoUrl(location), { waitUntil: "domcontentloaded" });
  const gate = page.locator(ENTER_DEMO).first();
  await gate.waitFor({ timeout: RENDER_TIMEOUT_MS });
  await gate.scrollIntoViewIfNeeded();
  await gate.click();
  await page
    .locator(`[data-app-embed="${app}"]`)
    .first()
    .waitFor({ timeout: RENDER_TIMEOUT_MS * 2 });
}

/** The listed tokens' computed values on the embed's first pane. */
function embedTokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate(
    (names) => {
      const embed = document.querySelector("[data-app-embed]");
      const probe =
        embed?.querySelector("[data-theme-scope]") ?? embed ?? document.body;
      const style = getComputedStyle(probe);
      return Object.fromEntries(
        names.map((n) => [n, style.getPropertyValue(n).trim()]),
      );
    },
    TOKENS as unknown as string[],
  );
}

/** The row keys (app ids) of `tiles`, in the order they are drawn. */
function rowKeys(tiles: Locator): Promise<string[]> {
  return tiles.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-row-key") ?? ""),
  );
}

/** The app-family glyphs (`#fam-…`) the embed draws that no symbol answers. */
function blankFamilyGlyphs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const embed = document.querySelector("[data-app-embed]");
    const hrefs = [...(embed?.querySelectorAll("use") ?? [])]
      .map((u) => u.getAttribute("href") ?? "")
      .filter((h) => h.startsWith("#fam"));
    return [...new Set(hrefs)].filter(
      (h) => document.getElementById(h.slice(1)) === null,
    );
  });
}

await withBrowser(async (h) => {
  const r = report(
    `demo parity: ${SITE ? "the website's live demo" : "main's /demo"}`,
  );
  const { page } = await h.session();
  mkdirSync(OUT, { recursive: true });

  // ── 1. Sonata's library, met fresh: the "Switch apps" tip ───────────
  await open(page, "/sonata", "sonata");
  const tip = page.locator(SHOWN_TIP).filter({ hasText: "Switch apps" });
  const shown = await waitFor(
    () => tip.count(),
    (n) => n > 0,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok("the Switch apps tip shows in the demo", shown.ok);
  await snap(page, OUT, "1-sonata-library");
  if (shown.ok) await tip.getByRole("button", { name: "Got it" }).click();

  // ── 2. Sonata's own colours and icons ────────────────────────────────
  const tokens = await embedTokens(page);
  r.ok(
    "the chord colours are painted inside the demo",
    tokens["--chord-1"] !== "",
    tokens["--chord-1"],
  );
  const blank = await waitFor(
    () => blankFamilyGlyphs(page),
    (b) => b.length === 0,
    { timeoutMs: 5_000 },
  );
  r.ok(
    "every app-family glyph the demo draws resolves",
    blank.ok,
    blank.value.join(", "),
  );

  // ── 3. the demo's tokens, for the side-by-side ──────────────────────
  writeFileSync(join(OUT, "tokens.json"), JSON.stringify(tokens, null, 2));
  console.log(`tokens inside the demo: ${JSON.stringify(tokens)}`);

  // ── 4. a song, Places, Files ────────────────────────────────────────
  await page.getByText("Rain on the window").first().click();
  await page.waitForTimeout(2_000);
  await snap(page, OUT, "2-sonata-song");
  for (const [location, app] of [
    ["/places", "places"],
    ["/files", "file-explorer"],
  ] as const) {
    await open(page, location, app);
    await page.waitForTimeout(2_000);
    await snap(page, OUT, `3-${app}`);
  }

  // ── 5. one app order: Home's gallery is the launcher's ──────────────
  await open(page, "/home", "home");
  const embed = page.locator("[data-app-embed]").first();
  const gallery = launcherTiles(embed);
  await gallery.first().waitFor({ timeout: RENDER_TIMEOUT_MS });
  const galleryApps = await rowKeys(gallery);
  await snap(page, OUT, "4-home");
  await open(page, "/pages", "pages");
  const grid = await openLauncherGrid(page.locator("[data-app-embed]").first());
  const launcherApps = await rowKeys(launcherTiles(grid));
  await closeLauncherGrid(grid);
  writeFileSync(
    join(OUT, "apps.json"),
    JSON.stringify({ gallery: galleryApps, launcher: launcherApps }, null, 2),
  );
  console.log(`Home gallery: ${galleryApps.join(", ")}`);
  r.ok(
    "the Home gallery lists the apps in the launcher's order",
    galleryApps.join() === launcherApps.join(),
    `launcher: ${launcherApps.join(", ")}`,
  );

  // ── 6. Settings → Config: the demo's configs, edited in the demo ────
  // Watched on the context, so a request from the demo's worker counts too.
  const pageOrigin = new URL(demoUrl("/settings")).origin;
  const configLeaks: string[] = [];
  const onConfigRequest = (req: Request): void => {
    const url = new URL(req.url());
    if (url.origin !== pageOrigin) return;
    if (/^\/api\/config/.test(url.pathname))
      configLeaks.push(`${req.method()} ${url.pathname}`);
  };
  page.context().on("request", onConfigRequest);
  const settingsEmbed = page.locator('[data-app-embed="settings"]').first();
  /** The Config nav's rows drawn now (it is virtualized), by their text. */
  const navRows = (): Promise<string[]> =>
    settingsEmbed
      .getByRole("row")
      .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
  /** Settings at its index, narrowed to Keyboard Party's config. */
  const findPartyConfig = async (): Promise<Settled<string[]>> => {
    await open(page, "/settings", "settings");
    await settingsEmbed
      .getByRole("row")
      .first()
      .waitFor({ timeout: RENDER_TIMEOUT_MS });
    await settingsEmbed.locator('input[placeholder^="Search"]').fill("party");
    return waitFor(
      navRows,
      (rows) =>
        rows.some((t) => t.startsWith("keyboard-party")) &&
        rows.some((t) => /^party/.test(t)),
      { timeoutMs: RENDER_TIMEOUT_MS },
    );
  };
  /** Keyboard Party's config opened from the nav: its Paper scene option. */
  const openPartyConfig = async (): Promise<Locator> => {
    await findPartyConfig();
    await settingsEmbed
      .getByRole("row")
      .filter({ hasText: /^\s*party/ })
      .first()
      .click();
    const paper = settingsEmbed.getByRole("radio", { name: "Paper" });
    await paper.waitFor({ timeout: RENDER_TIMEOUT_MS });
    return paper;
  };
  await open(page, "/settings", "settings");
  await settingsEmbed
    .getByRole("row")
    .first()
    .waitFor({ timeout: RENDER_TIMEOUT_MS });
  const top = await navRows();
  await snap(page, OUT, "5-settings");
  const party = await findPartyConfig();
  r.ok(
    "Settings opens on Config, the demo's configs grouped by plugin",
    top.some((t) => t.startsWith("apps")) && party.ok,
    `top: ${top.slice(0, 6).join(", ")}; "party": ${party.value.join(" › ")}`,
  );
  const paper = await openPartyConfig();
  await paper.click();
  const picked = await waitFor(
    () => paper.getAttribute("aria-checked"),
    (v) => v === "true",
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok("a config opens and its Scene is set to Paper", picked.ok);
  await snap(page, OUT, "5-settings-party-paper");
  const reopened = await openPartyConfig();
  const kept = await waitFor(
    () => reopened.getAttribute("aria-checked"),
    (v) => v === "true",
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok("reload: the Scene is still Paper (the demo's storage)", kept.ok);
  await open(page, "/keyboard-party", "keyboard-party");
  const scene = await waitFor(
    () =>
      page
        .locator('[data-app-embed="keyboard-party"] .kp-root')
        .first()
        .getAttribute("data-scene"),
    (v) => v === "paper",
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  r.ok("the party's stage paints the scene Settings picked", scene.ok);
  page.context().off("request", onConfigRequest);
  r.eq("no config request reached the page's own server", configLeaks, []);
  await r.finish();
});
