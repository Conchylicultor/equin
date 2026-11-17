// Draws the installer window's page over a recorded event stream, in a
// headless Chromium at the window's size, and photographs it — the page as the
// native window would show it at one instant, with no window and no install.
// Optionally photographs the approved mockup's window beside it and diffs them.
//
//   ./equin run plugins/installer/plugins/window/e2e/replay.ts --url http://equin.localhost:<port> \
//     --events <events.jsonl> --out "$EQUIN_SCRATCH/replay" [--now <iso>] [--scale 1] \
//     [--mockup "<prototype url>?view=window&state=running"] [--threshold 0.1] [--mockup-own-font] \
//     [--mockup-claude app|cli]
//
// `--url` names no deploy this script uses (it loads the bundled page itself);
// it is the harness's way to say "not this checkout's build". `--events` is
// any recorded stream (`~/.equin/install/<run>/events.jsonl`, or
// `moment.ts`'s fixtures). `--now` is the instant to draw it at
// (default: the last event's); the page's clock is pinned to it.
//
// Writes `<out>.png`. With `--mockup`: `<out>-mockup.png` (the mockup's `.iw`
// box, its fake traffic lights, rounded corners and shadow hidden — the native
// window draws those — and its font set to the page's, so text compares as
// layout, not as typeface), `<out>-diff.png`, `<out>-side-by-side.png`, and
// the differing-pixel ratio.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  arg,
  diffImages,
  flag,
  heatmapText,
  numArg,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { bundlePage } from "../deps";

const USAGE =
  "replay.ts --url http://equin.localhost:<port> --events <events.jsonl> --out <prefix> [--now <iso>] [--scale 1] [--mockup <url>] [--threshold 0.1] [--mockup-own-font]";
const eventsPath = requireArg("events", USAGE);
const out = requireArg("out", USAGE);
const mockup = arg("mockup");
const scale = numArg("scale", 1);
const threshold = numArg("threshold", 0.1);
/** Leave the mockup in its own font (Inter where it loads) to measure the typeface residue. */
const ownFont = flag("mockup-own-font");
/** Where the mockup's Fix with Claude remembers opening (its localStorage), to match the stream's. */
const mockupClaude = arg("mockup-claude");

/** The window's fixed size, in points. */
const WINDOW = { width: 760, height: 640 };
/** The page's own font stack (standalone-page/index.html), forced on the mockup. */
const PAGE_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Ubuntu, Cantarell, sans-serif';

const lines = readFileSync(eventsPath, "utf8")
  .split("\n")
  .filter((l) => l !== "");
if (lines.length === 0) throw new Error(`${eventsPath} holds no events`);
const lastT = (JSON.parse(lines.at(-1)!) as { t?: unknown }).t;
const nowIso = arg("now") ?? (typeof lastT === "string" ? lastT : undefined);
if (nowIso === undefined || Number.isNaN(Date.parse(nowIso)))
  throw new Error(
    `no instant to draw at: pass --now <iso> (got ${String(nowIso)})`,
  );

const root = join(import.meta.dir, "../../../../..");
const html = await bundlePage(root);

const r = report("installer page replay");
await withBrowser(async (h) => {
  const { page, captured } = await h.session({
    viewport: WINDOW,
    deviceScaleFactor: scale,
    colorScheme: "dark",
  });
  // The window's bridge: commands are recorded, not sent anywhere.
  await page.addInitScript(() => {
    const sent: string[] = [];
    (window as unknown as { ipc: unknown; ipcSent: string[] }).ipc = {
      postMessage: (m: string) => sent.push(m),
    };
    (window as unknown as { ipcSent: string[] }).ipcSent = sent;
  });
  await page.clock.setFixedTime(new Date(nowIso));
  // Served from a stand-in origin (the window's is installer://app/): an init
  // script runs on a navigation, not on setContent.
  const PAGE_URL = "http://installer.invalid/";
  await page.route(PAGE_URL, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(PAGE_URL);
  await page.evaluate((ls) => {
    (
      window as unknown as { installer: { push(l: string[]): void } }
    ).installer.push(ls);
  }, lines);
  const sent = await page.evaluate(
    () => (window as unknown as { ipcSent: string[] }).ipcSent,
  );
  r.eq("the page said ready", sent, ['{"cmd":"ready"}']);
  r.eq(
    "no page errors",
    [...captured.pageErrors, ...captured.consoleErrors],
    [],
  );
  const shot = await page.screenshot({ animations: "disabled" });
  writeFileSync(`${out}.png`, shot);
  r.note(`page: ${out}.png`);
  // What the screen says (every state has its body; the running one a status and a caption).
  r.note(
    `body: ${(await page.locator("#body").innerText()).replace(/\n+/g, " | ")}`,
  );

  if (mockup === undefined) return;
  const m = await h.session({
    viewport: { width: 1000, height: 800 },
    deviceScaleFactor: scale,
    colorScheme: "dark",
  });
  // Freeze the mockup's simulation at its first frame (it advances on an interval).
  await m.page.addInitScript((target) => {
    window.setInterval = (() => 0) as unknown as typeof window.setInterval;
    if (target !== null) localStorage.setItem("installer.claude", target);
  }, mockupClaude ?? null);
  await m.page.goto(mockup);
  await m.page.locator(".iw").waitFor();
  await m.page.evaluate(() => document.fonts.ready);
  await m.page.addStyleTag({
    content: `.iw-chrome { visibility: hidden } .iw { border-radius: 0 !important; box-shadow: none !important; ${ownFont ? "" : `font-family: ${PAGE_FONT} !important`} }`,
  });
  // Pin the log to its end, as the page's own log follows it.
  await m.page.evaluate(() => {
    const log = document.querySelector(".iw-log");
    if (log !== null) log.scrollTop = log.scrollHeight;
  });
  const mock = await m.page
    .locator(".iw")
    .screenshot({ animations: "disabled" });
  writeFileSync(`${out}-mockup.png`, mock);
  const diff = await diffImages(page, mock, shot, {
    labels: ["mockup", "page"],
    threshold,
  });
  writeFileSync(`${out}-diff.png`, diff.diffPng);
  writeFileSync(`${out}-side-by-side.png`, diff.sideBySidePng);
  r.ok(
    "same size as the mockup's window",
    diff.sameSize,
    `${JSON.stringify(diff.a)} vs ${JSON.stringify(diff.b)}`,
  );
  r.note(
    `differing pixels: ${(diff.ratio * 100).toFixed(3)}% (${diff.differing} of ${diff.total})`,
  );
  r.note(heatmapText(diff.grid));
  r.note(
    `mockup: ${out}-mockup.png · diff: ${out}-diff.png · side by side: ${out}-side-by-side.png`,
  );
});
await r.finish();
