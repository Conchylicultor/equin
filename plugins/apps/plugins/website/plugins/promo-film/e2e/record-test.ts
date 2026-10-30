// A test of the session recorder (media/film's `record`): the real app,
// driven by real clicks on a virtual clock, rendered through the film engine
// with the cursor drawn on top — no invented transition anywhere.
//
// The session:
// 1. Integrated — the "Track: build and push speed" wiki page, scrolled to
//    its "Type-check stores cost O(store)…" chip (an ordinary conversation:
//    in progress, the regular composer) → the pointer clicks it → the
//    conversation opens beside the page with the app's own column transition
//    → the pane's real Expand ("Open in Agent Manager") → the app's own
//    pane → app morph (a View Transition).
// 2. Evolving — the action bar's "Pick UI element" → the conversation's
//    title is picked → the Wish popover opens with the element chip → a
//    prompt typed character by character → the "Auto-push and exit"
//    preprompt → Create task. Main refuses agent writes, so the film ends on
//    the submit click (what follows on main is a "Couldn't add task" toast).
//
// The camera is static except a push-in on the Pick UI element button and on
// the Wish prompt field while it is typed.
//
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/record-test.ts \
//     --url http://equin.localhost:9000 [--reuse] [--preview] [--stills 2,4]
//
// --reuse renders the last recording again (no browser on the app). Frames and
// their input log go to /tmp/equin-film/record-test/; the film to
// ~/Downloads/showcase/test-recorder-3.mp4.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withBrowser } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  frameOn,
  installRecorderClock,
  record,
  recordedCursor,
  recordedSfx,
  runFilm,
  sequence,
  type Composition,
  type Key,
  type Rect,
  type Sequence,
  type Vec2,
} from "@plugins/media/plugins/film/e2e";
import {
  DPR,
  H,
  hideBarStatus,
  markBar,
  newManifest,
  open,
  W,
} from "./internal/capture-kit";

const DIR = "/tmp/equin-film/record-test";
const NAME = "session";
const PAGE = "block-e5afc5b1-15f2-4614-a49a-c7b4e6fe1851"; // "Track: build and push speed"
/** An ordinary conversation's chip on that page (in progress, no note, the regular composer). */
const CHIP = 'button[data-tooltip^="Type-check stores cost O(store)"]';
const EXPAND =
  '[data-pane-id="conversation"] button[aria-label="Open in Agent Manager"]';
const PROMPT = "Show the agent's push status next to this title";

async function recordSession(): Promise<Sequence> {
  rmSync(DIR, { recursive: true, force: true });
  return withBrowser(
    async (h) => {
      const { page, context } = await h.session({
        viewport: { width: W, height: H },
        deviceScaleFactor: DPR,
        colorScheme: "dark",
        capture: false,
      });
      await installRecorderClock(context);
      // Boot in real time: the page loads, fetches and renders as it would.
      await open(page, `/pages/page/${PAGE}`);
      const chip = page.locator(CHIP).first();
      await chip.waitFor({ state: "attached", timeout: 30_000 });
      const bringChipIntoView = async (): Promise<void> => {
        await chip.evaluate((e) => e.scrollIntoView({ block: "center" }));
        await chip.waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForTimeout(1500);
      };
      await bringChipIntoView();
      // Rehearsal, off camera: open the conversation once so its transcript is
      // in the app's live cache (as for a user who has been here before), then
      // close it with the pane's own Close button. Not the Expand: opening the
      // Agent Manager leaves a tab that later chip clicks would go to instead.
      await chip.click();
      const pane = page.locator('[data-pane-id="conversation"]').first();
      await page
        .locator(EXPAND)
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForTimeout(3000);
      await pane.locator('button[aria-label="Close"]').first().click();
      await page.waitForURL(new RegExp(`/pages/page/${PAGE}$`), {
        timeout: 30_000,
      });
      await bringChipIntoView();
      // The bar's machine status (health, notifications) is not the film's.
      await markBar(page);
      await hideBarStatus(page);

      const seq = await record(
        page,
        { dir: DIR, name: NAME, cursor: { x: 960, y: 600 } },
        async (rec) => {
          // 1. Integrated.
          await rec.hold(0.8);
          await rec.mark("chip", chip);
          await rec.click(chip, { duration: 0.9 });
          await rec.mark("opened");
          await rec.hold(2.2);
          const expand = page.locator(EXPAND).first();
          await rec.mark("expand", expand);
          await rec.click(expand, { duration: 0.8 });
          await rec.mark("expanded");
          await rec.hold(2.0);

          // 2. Evolving. Hovering the collapsed action bar opens it.
          const pick = page
            .locator('button[aria-label="Pick UI element"]')
            .first();
          await rec.mark("bar");
          await rec.move({ x: 1236, y: 22 }, { duration: 0.8 });
          await rec.hold(0.5);
          await rec.mark("pick", pick);
          await rec.click(pick, { duration: 0.35 });
          await rec.hold(0.3);
          const title = page
            .locator('[data-pane-id="conversation"] [data-part="pane.title"]')
            .last();
          await rec.move(title, { duration: 0.9 });
          await rec.hold(0.5);
          await rec.mark("picked", title);
          await rec.click(title, { duration: 0.1, dwell: 0.05 });
          await rec.hold(0.6);
          const editor = page.locator('[contenteditable="true"]').last();
          await rec.click({ element: editor, at: { x: 0.85, y: 0.3 } });
          await rec.press("End");
          // The prompt goes on its own line under the element chip (the
          // composer takes Shift+Enter as a line break; Enter would submit).
          await rec.press("Shift+Enter");
          await rec.mark("typing", editor);
          await rec.type(PROMPT, { cps: 16 });
          await rec.mark("typed");
          await rec.hold(0.4);
          await rec.click(
            page.locator('button[aria-label="Preprompt"]').first(),
          );
          await rec.hold(0.5);
          await rec.click(
            page.getByText("Auto-push and exit", { exact: true }).last(),
          );
          await rec.hold(0.6);
          const create = page.getByRole("button", { name: /Create task/ });
          await rec.mark("create", create);
          await rec.click(create);
          await rec.mark("submitted");
          await rec.hold(0.3);
        },
      );
      return seq;
      // The GPU: without hardware WebGL a page can draw differently than for the
      // user (Google's vector map falls back to raster with a banner).
    },
    { gpu: true },
  );
}

await runFilm({
  name: "record-test",
  out: "~/Downloads/showcase/test-recorder-3.mp4",
  flags: { reuse: "render the last recording again, without recording" },
  async build(ctx): Promise<Composition> {
    const logFile = join(DIR, `${NAME}.json`);
    const seq: Sequence =
      ctx.flag("reuse") && existsSync(logFile)
        ? (JSON.parse(readFileSync(logFile, "utf8")) as Sequence)
        : await recordSession();
    const manifest = newManifest();
    manifest.sequences[NAME] = seq;
    const input = seq.input;
    if (!input) throw new Error("record-test: the recording has no input log");
    const mark = (n: string) => {
      const m = input.marks[n];
      if (!m) throw new Error(`record-test: no mark "${n}"`);
      return m;
    };
    const rectOf = (n: string): Rect => {
      const r = mark(n).rect;
      if (!r) throw new Error(`record-test: mark "${n}" has no rect`);
      return r;
    };
    const duration = seq.frames.length / (seq.fps ?? 60);
    const centre: Vec2 = [W / 2, H / 2];
    // Static, except two push-ins: the Pick UI element button, and the prompt
    // field while it is typed.
    // Each push-in frames its element whole (plus a margin), never past the
    // recording's edges.
    const stage = { width: W, height: H };
    const onPick = frameOn(rectOf("pick"), { stage, margin: 24, maxZoom: 1.7 });
    const onType = frameOn(rectOf("typing"), {
      stage,
      margin: 24,
      maxZoom: 1.45,
    });
    const ZP = onPick.zoom;
    const ZT = onType.zoom;
    const pickAt = onPick.focus;
    const typeAt = onType.focus;
    const zoom: Key[] = [
      [mark("bar").t, 1],
      [mark("pick").t + 0.1, ZP, "inOutSine"],
      [mark("pick").t + 0.9, ZP],
      [mark("picked").t - 0.6, 1, "inOutSine"],
      [mark("typing").t - 0.5, 1],
      [mark("typing").t + 0.2, ZT, "inOutSine"],
      [mark("typed").t + 0.1, ZT],
      [mark("typed").t + 0.8, 1, "inOutSine"],
    ];
    const focus: Key<Vec2>[] = [
      [mark("bar").t, centre],
      [mark("pick").t + 0.1, pickAt, "inOutSine"],
      [mark("pick").t + 0.9, pickAt],
      [mark("picked").t - 0.6, centre, "inOutSine"],
      [mark("typing").t - 0.5, centre],
      [mark("typing").t + 0.2, typeAt, "inOutSine"],
      [mark("typed").t + 0.1, typeAt],
      [mark("typed").t + 0.8, centre, "inOutSine"],
    ];
    return {
      width: W,
      height: H,
      duration,
      background: "#000",
      assets: { dir: DIR, manifest },
      camera: {
        focus,
        zoom,
        bounds: [0, 0, W, H],
        motionBlur: { cap: 2, gain: 0.03 },
      },
      layers: [
        sequence(NAME, { playFrom: 0 }),
        recordedCursor(manifest, NAME, { size: 22 }),
      ],
      audio: { sfx: recordedSfx(manifest, NAME) },
    };
  },
});
