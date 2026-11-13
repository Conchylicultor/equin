import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  findImports,
  lineAt,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { fakeDomInstalls } from "../core/fake-dom";
import { isBunTestPath, isDomTestPath } from "../core/test-layout";

// test-layout:runner-split's per-file rules — (a) a bun:test file importing
// `vitest`, (b) a vitest file importing `bun:test`, (e) a bun:test file
// installing a browser global — as a fold kept along the directory tree:
// each is a function of the file's bytes and path, so a pass after an edit
// reads only the edited test files, never all ~2.8k.

/** One per-file offense, as its report line, under the rule it breaks. */
export interface RunnerOffense {
  rule: "a" | "b" | "e";
  entry: string;
}

/**
 * Every module specifier the file imports, static or dynamic: `findImports`
 * with its `import("…")`s — string-masked, so a specifier inside a comment or
 * a docs snippet cannot match.
 */
function runnerImports(src: string): { specifier: string; index: number }[] {
  return findImports(src, undefined, { dynamic: true }).map((imp) => ({
    specifier: imp.specifier,
    index: imp.index,
  }));
}

export const runnerSplitFold: FileFold<null, RunnerOffense[]> = {
  url: import.meta.url,
  scan(src, rel) {
    const out: RunnerOffense[] = [];
    const dom = isDomTestPath(rel);

    // (e) A bun:test file installing a browser global onto `globalThis`.
    if (isBunTestPath(rel)) {
      for (const install of fakeDomInstalls(src)) {
        out.push({
          rule: "e",
          entry: `${rel}:${lineAt(src, install.index)}  (installs \`${install.name}\`)`,
        });
      }
    }

    // A test file's runner is decided by WHERE it lives, so the banned
    // specifier is whichever runner does not own this location.
    const banned = dom ? "bun:test" : "vitest";
    const lines = src.split("\n");
    for (const ref of runnerImports(src)) {
      if (ref.specifier !== banned && !ref.specifier.startsWith(`${banned}/`))
        continue;
      const line = lineAt(src, ref.index);
      out.push({
        rule: dom ? "b" : "a",
        entry: `${rel}:${line}:${(lines[line - 1] ?? "").trim()}`,
      });
    }
    return out;
  },
  combine: (parts) => parts.flat(),
};
