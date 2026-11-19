/**
 * Finds HIDDEN COUPLINGS between a plugin's `core/` and a runtime half: a
 * `core/` module holding module-level state (a `let`, a Map/Set/array/object
 * store, a `globalThis` slot) that an exported function WRITES, where the
 * writer is called from a `web/ server/ machine/ central/ shared/` file. A
 * `core/` import of such a module works only once that half has run, which
 * the closure cannot see from the import alone.
 *
 *   ./equin run plugins/plugin-meta/plugins/closure/scripts/find-core-couplings.ts [--json <out>]
 *
 * Heuristic and one-hop: a writer is an exported function/arrow whose own body
 * assigns or mutates a module binding (`x =`, `x.set/add/push/delete/clear(`,
 * `x[k] =`), or any `globalThis` write — or, in a module that has state, any
 * export named like an installer (`set|register|install|provide|attach|
 * declare|mark|configure|init|bind…`, which reaches the state through a
 * helper) — or an exported store mutated in place by another file. Callers are found by name (`W(`) over
 * every shipped non-test file. Each candidate is printed with its writer
 * callers grouped by plugin + folder, own plugin first — the classification
 * (own-half install / cross-plugin registry / cache / test seam) is manual.
 */
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

const argv = process.argv.slice(2);
const jsonOut = (() => {
  const i = argv.indexOf("--json");
  return i >= 0 ? argv[i + 1] : undefined;
})();

const root = await getWorktreeRoot();
const repo = await loadRepoSnapshot(root);

const RUNTIME = new Set(["web", "server", "machine", "central", "shared"]);
const SHIPPED = new Set([...RUNTIME, "core", "data-dirs", "deps"]);
const isTest = (p: string) =>
  /\.test\.tsx?$/.test(p) || /\/(__tests__|testing)\//.test(p);

/** `plugins/a/plugins/b/core/x.ts` → { plugin: "a/b", folder: "core" }. */
function locate(p: string): { plugin: string; folder: string } | undefined {
  const s = p.split("/");
  if (s[0] !== "plugins" || s.length < 3) return undefined;
  let i = 1;
  const parts = [s[1]!];
  while (s[i + 1] === "plugins" && s[i + 2]) {
    i += 2;
    parts.push(s[i]!);
  }
  const folder = s[i + 1];
  if (!folder || i + 2 >= s.length) return undefined;
  return { plugin: parts.join("/"), folder };
}

const files = repo
  .all()
  .filter((p) => /\.tsx?$/.test(p) && !isTest(p) && !p.endsWith(".d.ts"))
  .map((p) => ({ p, at: locate(p) }))
  .filter(
    (f): f is { p: string; at: { plugin: string; folder: string } } =>
      f.at !== undefined && SHIPPED.has(f.at.folder),
  );
const text = new Map<string, string>();
const src = (p: string) => {
  let t = text.get(p);
  if (t === undefined) text.set(p, (t = readFileSync(join(root, p), "utf8")));
  return t;
};

const STATE =
  /^(?:export )?(?:let|var) (\w+)|^(?:export )?const (\w+)(?::[^=\n]+)? = (?:new (?:Map|Set|WeakMap|WeakSet|Array)\b|\[\]|\{\})/gm;
const EXPORTED_FN =
  /^export (?:async )?function (\w+)|^export const (\w+)(?::[^=\n]+)? = (?:async )?(?:\([^)]*\)|\w+)\s*(?::[^=\n]+)?=>/gm;

interface Candidate {
  file: string;
  plugin: string;
  state: string[];
  writers: {
    name: string;
    callers: { plugin: string; folder: string; files: string[] }[];
  }[];
}

/** The body of the top-level declaration starting at `at`: up to the next
 *  column-0 line that is not a closing brace continuation. */
function bodyFrom(t: string, at: number): string {
  const rest = t.slice(at);
  const m = /\n(?=[^\s}\])])/.exec(rest.slice(1));
  return m ? rest.slice(0, m.index + 1) : rest;
}

const candidates: Candidate[] = [];
const coreFiles = files.filter((f) => f.at.folder === "core");
for (const f of coreFiles) {
  const t = src(f.p);
  const state = new Set<string>();
  for (const m of t.matchAll(STATE)) state.add((m[1] ?? m[2])!);
  const usesGlobal = /globalThis(?:\.\w+|\[[^\]]+\])\s*(?:\?\?)?=[^=]/.test(t);
  if (state.size === 0 && !usesGlobal) continue;
  const writers: Candidate["writers"] = [];
  for (const m of t.matchAll(EXPORTED_FN)) {
    const name = (m[1] ?? m[2])!;
    const body = bodyFrom(t, m.index);
    const writes =
      /globalThis(?:\.\w+|\[[^\]]+\])\s*(?:\?\?)?=[^=]/.test(body) ||
      [...state].some((s) =>
        new RegExp(
          `(?<![.\\w])${s}\\s*(?:=[^=>]|\\?\\?=)|(?<![.\\w])${s}\\.(?:set|add|push|delete|clear|splice|unshift)\\(|(?<![.\\w])${s}\\[[^\\]]+\\]\\s*=[^=]`,
        ).test(body),
      );
    const installerName =
      /^(set|register|install|provide|attach|declare|mark|configure|init|bind|on)[A-Z]/.test(
        name,
      ) && !/Endpoint$/.test(name);
    if (!writes && !installerName) continue;
    // Who calls it, outside this plugin's own core/.
    const byKey = new Map<
      string,
      { plugin: string; folder: string; files: string[] }
    >();
    const call = new RegExp(`(?<![.\\w])${name}\\s*[(<]`);
    for (const g of files) {
      if (g.p === f.p) continue;
      if (g.at.plugin === f.at.plugin && g.at.folder === "core") continue;
      const gt = src(g.p);
      if (!gt.includes(name) || !call.test(gt)) continue;
      const k = `${g.at.plugin}\0${g.at.folder}`;
      const e = byKey.get(k) ?? {
        plugin: g.at.plugin,
        folder: g.at.folder,
        files: [],
      };
      e.files.push(g.p);
      byKey.set(k, e);
    }
    const callers = [...byKey.values()].sort(
      (a, b) =>
        Number(b.plugin === f.at.plugin) - Number(a.plugin === f.at.plugin) ||
        a.plugin.localeCompare(b.plugin),
    );
    if (callers.some((c) => RUNTIME.has(c.folder)))
      writers.push({ name, callers });
  }
  // An exported store another file mutates in place (`registry.set(…)`).
  for (const m of t.matchAll(
    /^export (?:let|const) (\w+)(?::[^=\n]+)? = (?:new (?:Map|Set|WeakMap|WeakSet|Array)\b|\[\]|\{\})/gm,
  )) {
    const name = m[1]!;
    const mut = new RegExp(
      `(?<![.\\w])${name}\\.(?:set|add|push|delete|clear|splice|unshift)\\(|(?<![.\\w])${name}\\[[^\\]]+\\]\\s*=[^=]`,
    );
    const byKey = new Map<
      string,
      { plugin: string; folder: string; files: string[] }
    >();
    for (const g of files) {
      if (g.p === f.p || !RUNTIME.has(g.at.folder)) continue;
      const gt = src(g.p);
      if (!gt.includes(name) || !mut.test(gt)) continue;
      const k = `${g.at.plugin}\0${g.at.folder}`;
      const e = byKey.get(k) ?? {
        plugin: g.at.plugin,
        folder: g.at.folder,
        files: [],
      };
      e.files.push(g.p);
      byKey.set(k, e);
    }
    if (byKey.size > 0)
      writers.push({ name: `${name} (store)`, callers: [...byKey.values()] });
  }
  if (writers.length > 0)
    candidates.push({
      file: f.p,
      plugin: f.at.plugin,
      state: [...state],
      writers,
    });
}

const own = (c: Candidate) =>
  c.writers.some((w) =>
    w.callers.some((x) => x.plugin === c.plugin && RUNTIME.has(x.folder)),
  );
candidates.sort(
  (a, b) => Number(own(b)) - Number(own(a)) || a.file.localeCompare(b.file),
);
console.log(
  `${candidates.length} core modules with module state written from a runtime half (${candidates.filter(own).length} by their OWN plugin's runtime half):\n`,
);
for (const c of candidates) {
  console.log(
    `${own(c) ? "OWN  " : "OTHER"} ${c.file}  [state: ${c.state.join(", ") || "globalThis"}]`,
  );
  for (const w of c.writers) {
    const callers = w.callers
      .filter((x) => RUNTIME.has(x.folder))
      .slice(0, 6)
      .map(
        (x) =>
          `${x.plugin}/${x.folder}${x.plugin === c.plugin ? " (own)" : ""}`,
      );
    const more =
      w.callers.filter((x) => RUNTIME.has(x.folder)).length - callers.length;
    console.log(
      `      ${w.name}() ← ${callers.join(", ")}${more > 0 ? ` … +${more}` : ""}`,
    );
  }
}
if (jsonOut) {
  await Bun.write(jsonOut, JSON.stringify(candidates, null, 1));
  console.log(`\nwrote ${jsonOut}`);
}
