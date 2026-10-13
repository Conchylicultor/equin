// Folders stay on top under a column-header sort ("Keep folders on top").
//
// The listing's default view pins an ascending sort rule on the hidden
// `folders` field, so a header click sorts folders and files each by that
// column without mixing them. The fixture interleaves modification times —
// dir, file, dir, file, oldest to newest — so a plain Modified sort (either
// direction) WOULD mix them: only the pinned rule keeps every folder first.
//
//  1. List the fixture: folders first (no header sort).
//  2. Click Modified (ascending): folders first, each segment by date.
//  3. Click again (descending): folders first, each segment by date.
//  4. Click a third time (the header sort is dropped, restoring the config the
//     run started from): folders first again.
//
// Usage:
//   ./singularity run plugins/apps/plugins/file-explorer/e2e/folders-on-top-verify.ts \
//     [--out /tmp/folders-on-top] [--headed]

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out") ?? join(tmpdir(), "folders-on-top-verify");

// Oldest → newest, alternating kinds.
const ENTRIES = [
  { name: "d-one", dir: true },
  { name: "f-two.txt", dir: false },
  { name: "d-three", dir: true },
  { name: "f-four.txt", dir: false },
] as const;

const fixture = mkdtempSync(join(tmpdir(), "fx-folders-top-"));
const base = Date.now() / 1000 - 10 * 86400;
ENTRIES.forEach((e, i) => {
  const path = join(fixture, e.name);
  if (e.dir) mkdirSync(path);
  else writeFileSync(path, "x\n");
  const t = base + i * 86400;
  utimesSync(path, t, t);
});

/** The fixture's names in the order the tree paints its rows. */
async function order(page: Page): Promise<string[]> {
  const texts = await page
    .locator("[data-tree-row]")
    .evaluateAll((rows) => rows.map((r) => r.textContent ?? ""));
  return texts.flatMap((t) => {
    const hit = ENTRIES.find((e) => t.includes(e.name));
    return hit ? [hit.name] : [];
  });
}

const isDir = (name: string) =>
  ENTRIES.find((e) => e.name === name)?.dir === true;

/** Every folder row precedes every file row. */
function foldersFirst(names: string[]): boolean {
  const firstFile = names.findIndex((n) => !isDir(n));
  return firstFile === -1 || names.slice(firstFile).every((n) => !isDir(n));
}

const r = report("folders on top");

try {
  await withBrowser(async (h) => {
    const { page } = await h.session({
      viewport: { width: 1440, height: 900 },
    });
    await boot(page, pathUrl(`/files/at/${encodeURIComponent(fixture)}`), {
      marker: "[data-tree-row]",
    });
    await page
      .locator("[data-tree-row]", { hasText: "f-four.txt" })
      .first()
      .waitFor({ state: "visible" });

    const initial = await order(page);
    await snap(page, out, "1-default");
    r.ok(
      "no header sort: folders first",
      initial.length === ENTRIES.length && foldersFirst(initial),
      initial.join(", "),
    );

    const header = page.locator("[data-aligned-header='modified']");
    const steps: {
      label: string;
      shot: string;
      expected: string[] | null;
    }[] = [
      {
        label: "Modified ascending",
        shot: "2-asc",
        expected: ["d-one", "d-three", "f-two.txt", "f-four.txt"],
      },
      {
        label: "Modified descending",
        shot: "3-desc",
        expected: ["d-three", "d-one", "f-four.txt", "f-two.txt"],
      },
      // Third click drops the header sort: back to folders-first by name.
      { label: "header sort cleared", shot: "4-cleared", expected: null },
    ];
    for (const step of steps) {
      await header.click();
      await page.waitForTimeout(500);
      const names = await order(page);
      await snap(page, out, step.shot);
      r.ok(
        `${step.label}: folders first`,
        names.length === ENTRIES.length && foldersFirst(names),
        names.join(", "),
      );
      if (step.expected) {
        r.ok(
          `${step.label}: each segment by date`,
          names.join(",") === step.expected.join(","),
          names.join(", "),
        );
      }
    }
  });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

await r.finish();
