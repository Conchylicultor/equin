// Renders the demo's before / after PNGs (`data/before-after/`, story's
// `BEFORE_AFTERS`) — a browser host renders nothing, so they are committed —
// and palette-quantizes them with pngquant (`brew install pngquant`) to keep
// the snapshot small:
//
// - recipes: the featured prototype's last version, opened from a temp copy
//   of its files, with the photo cards and with the overlay cards (the page's
//   `cards` option, set on <html> as the served document does);
// - practice-timer: Sonata's library in the demo (`/about/demo/at/sonata`,
//   this checkout's build), Recent view — as it is, then with the agent's
//   This week column STAGED into the table (the feature lives only in the
//   story): 1 min on the ii–V–I warm-up, which the agent's check also played
//   once.
//
// Usage (after `./equin build`):
//   ./equin run plugins/apps/plugins/website/plugins/demos/plugins/workspace/e2e/render-before-afters.ts

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  readdirSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  boot,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  parsePrototypeTree,
  prototypeFixtureDataOf,
} from "@plugins/apps/plugins/prototypes/plugins/fixtures/core";
import {
  DEMO_PRACTICE_TIMER_BEFORE_AFTER,
  DEMO_RECIPES_BEFORE_AFTER,
} from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/plugins/story/core";

const DATA = join(import.meta.dir, "..", "data");
const OUT = join(DATA, "before-after");
const raw = mkdtempSync(join(tmpdir(), "demo-before-after-"));

/** The recipes prototype's last version, laid out in a temp folder. */
function recipesPage(): string {
  const files: Record<string, Uint8Array> = {};
  for (const rel of readdirSync(join(DATA, "prototypes"), {
    recursive: true,
  }) as string[])
    if (statSync(join(DATA, "prototypes", rel)).isFile())
      files[`prototypes/${rel.split(sep).join("/")}`] = new Uint8Array(
        readFileSync(join(DATA, "prototypes", rel)),
      );
  const { prototypes } = parsePrototypeTree(prototypeFixtureDataOf(files).tree);
  const proto = prototypes.find(
    (p) => p.id === DEMO_RECIPES_BEFORE_AFTER.prototype,
  );
  const last = proto?.versions.at(-1);
  if (last === undefined)
    throw new Error(`no ${DEMO_RECIPES_BEFORE_AFTER.prototype} in data/`);
  const dir = mkdtempSync(join(tmpdir(), "demo-recipes-"));
  for (const [name, text] of Object.entries(last.files))
    writeFileSync(join(dir, name), text);
  return join(dir, "index.html");
}

/** Copy `from` to `to`, palette-quantized — loud when pngquant is missing or fails. */
function quantize(from: string, to: string): void {
  const run = Bun.spawnSync(
    [
      "pngquant",
      "--quality=70-90",
      "--speed",
      "1",
      "--strip",
      "--force",
      "--output",
      to,
      from,
    ],
    { stderr: "pipe" },
  );
  if (run.exitCode !== 0)
    throw new Error(
      `pngquant ${from} failed (exit ${run.exitCode}; install it with \`brew install pngquant\`): ${run.stderr.toString()}`,
    );
  console.log(`wrote ${to}`);
}

await withBrowser(async (h) => {
  // Recipes: two values of the page's cards option.
  {
    const pair = DEMO_RECIPES_BEFORE_AFTER;
    const { page } = await h.session({
      viewport: pair.viewport,
      colorScheme: "light",
    });
    const url = `file://${recipesPage()}`;
    for (const side of [pair.before, pair.after]) {
      await boot(page, url);
      await page.evaluate((c) => {
        document.documentElement.dataset.cards = c;
      }, side.picks.cards);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(raw, side.file) });
      quantize(join(raw, side.file), join(OUT, side.file));
    }
  }

  // Practice timer: the library's Recent view, then with This week staged in.
  {
    const pair = DEMO_PRACTICE_TIMER_BEFORE_AFTER;
    const { page } = await h.session({
      viewport: pair.viewport,
      colorScheme: "dark",
    });
    await page.goto(pathUrl("/about/demo/at/sonata"), {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("button[aria-label=Recent]")
      .first()
      .waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    // The first-visit hint and the cookie prompt sit over the page; the build's
    // own frame (html::after) is not the app.
    await page.evaluate(async () => {
      for (const t of ["Got it", "Reject"])
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent!.trim().startsWith(t))
          ?.click();
      await new Promise((r) => setTimeout(r, 500));
      (
        document.querySelector("button[aria-label=Recent]") as HTMLElement
      ).click();
    });
    await page
      .getByText(/^last played$/i)
      .last()
      .waitFor();
    await page.addStyleTag({
      content: "html::after { display: none !important; }",
    });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(raw, pair.before.file) });
    await page.evaluate(() => {
      const header = [...document.querySelectorAll("body *")]
        .filter((e) => /^\s*last played\s*$/i.test(e.textContent ?? ""))
        .at(-1)!.parentElement!.parentElement!;
      const grid = header.parentElement as HTMLElement;
      const col = (name: RegExp) =>
        [...header.children].findIndex((c) => name.test(c.textContent ?? ""));
      const last = col(/last played/i);
      const plays = col(/^\s*plays\s*$/i);
      // One more track after Last played, split at top-level spaces.
      const parts: string[] = [];
      let depth = 0;
      let cur = "";
      for (const ch of grid.style.gridTemplateColumns) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === " " && depth === 0) {
          parts.push(cur);
          cur = "";
        } else cur += ch;
      }
      parts.push(cur);
      parts.splice(last + 1, 0, "5.75rem");
      grid.style.gridTemplateColumns = parts.join(" ");
      const setText = (el: Node, text: string) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let first = true;
        for (let n = w.nextNode(); n; n = w.nextNode())
          if (n.textContent!.trim()) {
            n.textContent = first ? text : "";
            first = false;
          }
      };
      const headCell = header.children[last]!.cloneNode(true);
      setText(headCell, "This week");
      header.children[last]!.after(headCell);
      for (const row of [...grid.children].filter((r) => r !== header)) {
        const warmUp = /ii–V–I warm-up/.test(row.textContent ?? "");
        if (warmUp) {
          const w = document.createTreeWalker(
            row.children[plays]!,
            NodeFilter.SHOW_TEXT,
          );
          for (let n = w.nextNode(); n; n = w.nextNode())
            if (n.textContent!.trim() === "0") n.textContent = "1";
          setText(row.children[last]!, "1m ago");
        }
        const cell = row.children[last]!.cloneNode(true);
        setText(cell, warmUp ? "1 min" : "—");
        row.children[last]!.after(cell);
      }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(raw, pair.after.file) });
    for (const side of [pair.before, pair.after])
      quantize(join(raw, side.file), join(OUT, side.file));
  }
});
