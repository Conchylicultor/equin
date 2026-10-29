/**
 * The pane → app morph, driven for real: open a pane hosted by the Agent
 * Manager, press its "Open in <App>" button, and check the view transition ran
 * — not skipped — with the pane named on BOTH sides (the expanded box, and the
 * leaf pane of the app that replaced it), then land in that app. Photographs
 * the morph mid-flight (every animation paused) and at its end.
 *
 * Manual only. After `./equin build`:
 *
 *   ./equin run plugins/apps-core/plugins/pane-morph/e2e/morph.ts \
 *     [--path /agents/c/<conv>/page/<block>] [--out /tmp/pane-morph]
 *
 * With no `--path`, runs the two expand sites the morph was designed on: a page
 * pane (→ Pages, an app with its own sidebar) and a peeked file (→ Files, which
 * lands on a different pane than the one expanded).
 */
import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const DEFAULT_PATHS = [
  "/agents/c/conv-1793274029-fjjq2u/page/block-361815ed-5750-413a-b5ab-31c5dc855144",
  "/agents/c/conv-1793190568-77j5x4/file/att-1792947727-5k4w8f/~/Downloads/showcase/test-recorder.mp4",
];
const paths = arg("path") === undefined ? DEFAULT_PATHS : [arg("path")!];
const out = arg("out", "/tmp/pane-morph");
const VIEWPORT = { width: 1400, height: 900 };
const EXPAND = 'button[aria-label^="Open in "]';

const r = report("pane-morph");

interface Probe {
  started: boolean;
  before: string[];
  after: string[];
  ready: "pending" | "resolved" | string;
  finished: boolean;
}

/** Wraps `startViewTransition` to record what each side named and how it ended. */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const named = () =>
      [...document.querySelectorAll<HTMLElement>("*")]
        .map((el) => el.style.viewTransitionName)
        .filter((n) => n !== "")
        .sort();
    const probe = {
      started: false,
      before: [] as string[],
      after: [] as string[],
      ready: "pending",
      finished: false,
    };
    (window as unknown as { __morph: typeof probe }).__morph = probe;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((update: () => void) => {
      probe.started = true;
      probe.before = named();
      const t = start(() => {
        update();
        probe.after = named();
      });
      t.ready.then(
        () => (probe.ready = "resolved"),
        (err: unknown) => (probe.ready = String(err)),
      );
      void t.finished.finally(() => (probe.finished = true));
      return t;
    }) as typeof document.startViewTransition;
  });
}

const readProbe = (page: Page): Promise<Probe> =>
  page.evaluate(() => (window as unknown as { __morph: Probe }).__morph);

await withBrowser(async (h) => {
  for (const [i, path] of paths.entries()) {
    const tag = `#${i + 1}`;
    const { page } = await h.session({ viewport: VIEWPORT });
    await page.goto(pathUrl(path));
    const button = page.locator(EXPAND).last();
    await button.waitFor({ state: "visible", timeout: 30_000 });
    const label = await button.getAttribute("aria-label");
    console.log(`${tag} ${path} — pressing "${label}"`);
    await page.waitForTimeout(1500); // let the pane settle before it is captured
    await installProbe(page);

    await button.click();
    await page.waitForTimeout(140);
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.pause();
    });
    const pseudo = await page.evaluate(() =>
      document
        .getAnimations()
        .map((a) => (a.effect as KeyframeEffect | null)?.pseudoElement)
        .filter((p): p is string => typeof p === "string"),
    );
    await page.screenshot({ path: `${out}-${i + 1}-mid.png` });
    console.log(`wrote ${out}-${i + 1}-mid.png`);
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.play();
    });
    await page.waitForFunction(
      () => (window as unknown as { __morph: Probe }).__morph.finished,
      undefined,
      { timeout: 5000 },
    );
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}-${i + 1}-end.png` });
    console.log(`wrote ${out}-${i + 1}-end.png`);

    const probe = await readProbe(page);
    console.log(`${tag} before: ${probe.before.join(", ")}`);
    console.log(`${tag} after:  ${probe.after.join(", ")}`);
    r.ok(`${tag} a view transition started`, probe.started);
    r.eq(`${tag} it was not skipped`, probe.ready, "resolved");
    r.ok(
      `${tag} the expanded pane is named`,
      probe.before.includes("pane-morph"),
    );
    r.ok(
      `${tag} the new app's leaf pane is named`,
      probe.after.includes("pane-morph"),
      probe.after.join(", "),
    );
    r.ok(
      `${tag} the pane morphs as its own group`,
      pseudo.includes("::view-transition-group(pane-morph)"),
    );
    const landed = await page.evaluate(() => location.pathname);
    r.ok(
      `${tag} left the Agent Manager`,
      !landed.startsWith("/agents"),
      landed,
    );
    r.eq(
      `${tag} every name is cleared afterwards`,
      await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>("*")].filter(
            (el) => el.style.viewTransitionName !== "",
          ).length,
      ),
      0,
    );
    await page.context().close();
  }
});

await r.finish();
