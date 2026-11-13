import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { PLUGIN_MOVES_FILE } from "@plugins/plugin-meta/plugins/relocate/core";
import {
  describeMoveLeftovers,
  findMovedPluginLeftovers,
} from "./moved-plugin-leftovers";

/** A path under the fixture repo's `plugins/` (built, so no literal reads as a real plugin path). */
const P = (rest: string): string => ["plugins", rest].join("/");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function git(root: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A repo where `old` moved to `new.home` (its nested .gitignore with it) and `kept` moved but lives there again. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "move-leftovers-"));
  dirs.push(root);
  git(root, "init", "-q");
  write(
    root,
    PLUGIN_MOVES_FILE,
    JSON.stringify([
      { at: "2026-11-13T00:00:00.000Z", from: "old", to: "new.home" },
      { at: "2026-11-13T00:00:01.000Z", from: "kept", to: "elsewhere" },
    ]),
  );
  write(root, P("new/plugins/home/rust/.gitignore"), "/gen/\n");
  write(root, P("new/plugins/home/rust/gen/a.json"), "{}");
  write(root, P("kept/core/index.ts"), "export {};\n");
  // The stranded output: no .gitignore covers it at the old address any more.
  write(root, P("old/rust/gen/a.json"), "{}");
  // An untracked file beside tracked ones at a reused address: not a leftover.
  write(root, P("kept/core/new.ts"), "export {};\n");
  git(root, "add", PLUGIN_MOVES_FILE, P("new"), P("kept/core/index.ts"));
  return root;
}

describe("findMovedPluginLeftovers", () => {
  test("names the untracked files at an address git tracks nothing under, with its move", async () => {
    const leftovers = await findMovedPluginLeftovers(asAppPath(repo()));
    expect(leftovers.map((l) => [l.dir, l.move.to, l.files])).toEqual([
      [P("old"), "new.home", [P("old/rust/gen/a.json")]],
    ]);
    const message = describeMoveLeftovers(leftovers);
    expect(message).toContain(P("old/ — old moved to new.home"));
    expect(message).toContain("Nothing was built and nothing was deleted.");
  });

  test("an old address still ignored, or gone, is not a leftover", async () => {
    const root = repo();
    rmSync(join(root, P("old")), { recursive: true });
    expect(await findMovedPluginLeftovers(asAppPath(root))).toEqual([]);
  });
});
