import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_MOVES_FILE } from "./ledger";
import { restampMovedOverrides, snapshotConfigOrigins } from "./restamp-moved";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "restamp-moved-"));
  roots.push(root);
  const all = {
    [PLUGIN_MOVES_FILE]: JSON.stringify([
      { at: "2026-10-26T00:00:00.000Z", from: "old", to: "zed" },
    ]),
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const read = (root: string, rel: string) =>
  readFileSync(join(root, "config", rel), "utf8");

/** Snapshot, "regenerate" `origin` to `next`, re-stamp. */
function run(root: string, next: string): string[] {
  const prior = snapshotConfigOrigins(join(root, "config"));
  writeFileSync(join(root, "config", "s/item.origin.jsonc"), next);
  return restampMovedOverrides({ root, prior });
}

const OLD_ORIGIN = `// @hash aaa\n{ "items": ["b:x", "old:y"] }`;
// The regenerated origin: the renamed key re-sorts to the end.
const NEW_ORIGIN = `// @hash bbb\n{ "items": ["b:x", "zed:y"] }`;
// The override, its keys already re-rooted by the mover.
const OVERRIDE = `// @hash aaa\n// note\n{ "items": ["zed:y", "b:x"] }`;

describe("restampMovedOverrides", () => {
  test("a pure move re-stamps the base override and every app scope", () => {
    const root = checkout({
      "config/s/item.origin.jsonc": OLD_ORIGIN,
      "config/s/item.jsonc": OVERRIDE,
      "config/s/@app/home/item.jsonc": OVERRIDE,
    });
    expect(run(root, NEW_ORIGIN)).toEqual([
      "s/@app/home/item.jsonc",
      "s/item.jsonc",
    ]);
    expect(read(root, "s/item.jsonc")).toBe(
      `// @hash bbb\n// note\n{ "items": ["zed:y", "b:x"] }`,
    );
  });

  test("a move plus a real catalog change is left to the staleness gates", () => {
    const root = checkout({
      "config/s/item.origin.jsonc": OLD_ORIGIN,
      "config/s/item.jsonc": OVERRIDE,
    });
    const next = `// @hash ccc\n{ "items": ["b:x", "new:z", "zed:y"] }`;
    expect(run(root, next)).toEqual([]);
    expect(read(root, "s/item.jsonc")).toBe(OVERRIDE);
  });

  test("a change no move explains is left alone", () => {
    const root = checkout({
      "config/s/item.origin.jsonc": `// @hash aaa\n{ "items": ["b:x", "c:y"] }`,
      "config/s/item.jsonc": `// @hash aaa\n{ "items": ["c:y", "b:x"] }`,
    });
    // A pure reorder of the default: same multiset, but no key was re-rooted.
    const next = `// @hash ddd\n{ "items": ["c:y", "b:x"] }`;
    expect(run(root, next)).toEqual([]);
  });

  test("an override anchored to another hash is not touched", () => {
    const stale = `// @hash 999\n{ "items": ["zed:y"] }`;
    const root = checkout({
      "config/s/item.origin.jsonc": OLD_ORIGIN,
      "config/s/item.jsonc": stale,
    });
    expect(run(root, NEW_ORIGIN)).toEqual([]);
    expect(read(root, "s/item.jsonc")).toBe(stale);
  });
});
