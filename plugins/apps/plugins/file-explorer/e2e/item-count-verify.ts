// Folder item counts in the file explorer's Size column, end to end on a
// deployed build.
//
// A throwaway folder is made on the host (the deploy reads the same disk):
//   fx-items-<random>/
//     a-three/      → x, y and .dot (a dotfile behind Show hidden files)
//     a-empty/      → nothing: a real 0
//     a-locked/     → chmod 000: "No access", never 0
//     z-zip/archive.zip → photos/note.txt
//     d-000 … d-299 → 300 folders of one file each, far more than a screen
//
//  1. Every folder on screen shows its count in Size without being expanded:
//     a-three 2 items, a-empty 0 items, a-locked No access.
//  2. Only folders on screen are read: the paths peeked stay far below the
//     300 folders listed (the tree windows its rows).
//  3. Jumping to the bottom counts the folders there, and none it skipped.
//  4. Show hidden files counts the dotfile.
//  5. An expanded folder still reads its count; a folder inside the zip is
//     counted, and the zip row keeps its byte size.
//
// Usage:
//   ./singularity run plugins/apps/plugins/file-explorer/e2e/item-count-verify.ts \
//     [--out /tmp/items] [--headed]

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out") ?? join(tmpdir(), "item-count-verify");

const MANY = 300;
const fixture = mkdtempSync(join(tmpdir(), "fx-items-"));
mkdirSync(join(fixture, "a-three"));
for (const name of ["x", "y", ".dot"]) {
  writeFileSync(join(fixture, "a-three", name), name);
}
mkdirSync(join(fixture, "a-empty"));
mkdirSync(join(fixture, "a-locked"));
chmodSync(join(fixture, "a-locked"), 0o000);
for (let i = 0; i < MANY; i++) {
  const dir = join(fixture, `d-${String(i).padStart(3, "0")}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "f"), "f");
}
mkdirSync(join(fixture, "z-zip"));
const zipSrc = mkdtempSync(join(tmpdir(), "fx-items-zip-"));
mkdirSync(join(zipSrc, "photos"));
writeFileSync(join(zipSrc, "photos", "note.txt"), "A zipped note\n");
await spawnExpectOk(
  ["zip", "-q", "-r", join(fixture, "z-zip", "archive.zip"), "photos"],
  { cwd: zipSrc, timeoutMs: 20_000 },
);
rmSync(zipSrc, { recursive: true, force: true });

/** A tree row by its entry name (its id is its path, so the last segment). */
function row(page: Page, name: string): Locator {
  return page.locator(`[data-tree-row][data-tree-id$="/${name}"]`).first();
}

function sizeOf(page: Page, name: string): Locator {
  return row(page, name).locator("[data-aligned-cell=size]");
}

/** Wait until `name`'s Size cell reads `text`; what it last read otherwise. */
async function sizeReads(
  page: Page,
  name: string,
  text: string,
): Promise<{ ok: boolean; got: string }> {
  const cell = sizeOf(page, name);
  const deadline = Date.now() + 10_000;
  let got = "";
  while (Date.now() < deadline) {
    got =
      (await cell.count()) > 0 ? ((await cell.textContent()) ?? "").trim() : "";
    if (got === text) return { ok: true, got };
    await page.waitForTimeout(200);
  }
  return { ok: false, got };
}

/** Expand a folder row by its chevron (revealed on hover). */
async function expand(page: Page, name: string): Promise<void> {
  await row(page, name).hover();
  await row(page, name).locator("button[aria-label='Expand']").click();
}

/** Every folder path a `host-fs.peek` subscription has asked for, deduplicated. */
const peeked = new Set<string>();

/** The `host-fs.peek` paths one client socket frame subscribes (a sub or a replay). */
function peekPaths(payload: string | Buffer): string[] {
  if (typeof payload !== "string") return [];
  const frame = JSON.parse(payload) as {
    op?: string;
    key?: string;
    params?: { path?: string };
    entries?: { key: string; params: { path?: string } }[];
  };
  const subs =
    frame.op === "sub"
      ? [{ key: frame.key, params: frame.params }]
      : frame.op === "sub-batch"
        ? (frame.entries ?? [])
        : [];
  return subs.flatMap((sub) =>
    sub.key === "host-fs.peek" && sub.params?.path !== undefined
      ? [sub.params.path]
      : [],
  );
}
const r = report("file explorer folder counts");

try {
  await withBrowser(async (h) => {
    const { page } = await h.session({
      viewport: { width: 1600, height: 960 },
    });
    page.on("websocket", (ws) => {
      ws.on("framesent", ({ payload }) => {
        for (const p of peekPaths(payload)) peeked.add(p);
      });
    });

    // 1. Counts without expanding.
    await boot(page, pathUrl(`/files/at/${encodeURIComponent(fixture)}`), {
      marker: "[data-tree-row]",
    });
    for (const [name, text] of [
      ["a-three", "2 items"],
      ["a-empty", "0 items"],
      ["a-locked", "No access"],
      ["d-000", "1 item"],
    ] as const) {
      const got = await sizeReads(page, name, text);
      r.ok(`${name} reads ${text}`, got.ok, got.got);
    }
    await snap(page, out, "1-counts");

    // 2. Bounded to the screen.
    await page.waitForTimeout(1000);
    const onScreen = peeked.size;
    r.ok(
      `only folders on screen are read (of ${MANY + 4} folders)`,
      onScreen > 0 && onScreen < 100,
      `${onScreen} peeked`,
    );

    // 3. Jumping to the bottom counts what comes into view, and nothing it
    //    skipped (rows the window never rendered are never read).
    await row(page, "d-000").evaluate((el) => {
      let s: HTMLElement | null = el.parentElement;
      while (s !== null && s.scrollHeight <= s.clientHeight) {
        s = s.parentElement;
      }
      if (s === null) throw new Error("no scroll container");
      s.scrollTop = s.scrollHeight;
    });
    const last = `d-${MANY - 1}`;
    await row(page, last).waitFor({ state: "visible", timeout: 10_000 });
    const bottom = await sizeReads(page, last, "1 item");
    r.ok("a folder scrolled into view is counted", bottom.ok, bottom.got);
    r.ok(
      "and only then",
      peeked.size > onScreen && peeked.size < MANY,
      `${onScreen} → ${peeked.size} peeked`,
    );
    await row(page, last).evaluate((el) => {
      let s: HTMLElement | null = el.parentElement;
      while (s !== null && s.scrollHeight <= s.clientHeight) {
        s = s.parentElement;
      }
      if (s === null) throw new Error("no scroll container");
      s.scrollTop = 0;
    });
    await row(page, "a-three").waitFor({ state: "visible", timeout: 10_000 });

    // 4. Show hidden files counts the dotfile.
    await page.getByRole("button", { name: "Show hidden files" }).click();
    const withHidden = await sizeReads(page, "a-three", "3 items");
    r.ok("Show hidden files counts the dotfile", withHidden.ok, withHidden.got);
    await page.getByRole("button", { name: "Hide hidden files" }).click();
    const hiddenAgain = await sizeReads(page, "a-three", "2 items");
    r.ok("hiding it again drops it", hiddenAgain.ok, hiddenAgain.got);

    // 5. Expanded folders and archives.
    await expand(page, "a-three");
    await row(page, "x").waitFor({ state: "visible", timeout: 10_000 });
    const expanded = await sizeReads(page, "a-three", "2 items");
    r.ok("an expanded folder keeps its count", expanded.ok, expanded.got);
    // The zip sits in its own folder (here it would sort after the 300).
    await page.goto(
      pathUrl(`/files/at/${encodeURIComponent(join(fixture, "z-zip"))}`),
    );
    await row(page, "archive.zip").waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await expand(page, "archive.zip");
    await row(page, "photos").waitFor({ state: "visible", timeout: 10_000 });
    const zipped = await sizeReads(page, "photos", "1 item");
    r.ok("a folder inside a zip is counted", zipped.ok, zipped.got);
    const zipSize = (
      (await sizeOf(page, "archive.zip").textContent()) ?? ""
    ).trim();
    r.ok("the zip row keeps its byte size", zipSize.endsWith(" B"), zipSize);
    await snap(page, out, "5-expanded");
  });
} finally {
  chmodSync(join(fixture, "a-locked"), 0o755);
  rmSync(fixture, { recursive: true, force: true });
}

await r.finish();
