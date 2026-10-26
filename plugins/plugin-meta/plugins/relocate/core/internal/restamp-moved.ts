// Keeps the GIT layer's hash chain across a plugin move — the committed
// `config/` overrides' twin of what `applyPluginMoves` does for a namespace's
// saved settings.
//
// A move re-roots reorder keys (`"<from>:<id>"` → `"<to>:<id>"`) in committed
// overrides by hand (the mover's planner), but their origins are derived: the
// build regenerates each `.origin.jsonc` from the slot catalog / `defineConfig`
// defaults, so its new `// @hash` is only known after codegen — and a renamed
// key re-sorts in the catalog, so no text edit could predict it. Every override
// anchored to the old hash would then read as stale: `config-origins-in-sync`
// fails, and a mandatory override is re-marked `@review` though nothing about
// it needs reviewing.
//
// So the build snapshots every origin before codegen and, after it, asks of
// each origin whose hash changed: is the change exactly a recorded move? It is
// when re-rooting the OLD origin's reorder keys through the ledger changes at
// least one key and yields the NEW origin (arrays compared as multisets — a
// renamed key re-sorts). Then each override anchored to the old hash is
// re-stamped to the new one, body untouched. Anything else — an entry that
// appeared, a field default that changed, a ledger entry whose old id a later
// plugin reused — fails the comparison and is left to the usual staleness gates.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { APP_SCOPE_DIR } from "@plugins/config_v2/core";
import {
  configTextHash,
  parseConfigText,
  walkConfigFiles,
  withConfigTextHash,
} from "@plugins/config_v2/plugins/ledger/core";
import { rewriteKeys } from "./apply-moves";
import { readPluginMoves } from "./ledger";

const ORIGIN_SUFFIX = ".origin.jsonc";

/** Every committed origin under `configDir`, by `config/`-relative path → text. */
export function snapshotConfigOrigins(configDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of walkConfigFiles(configDir)) {
    if (rel.endsWith(ORIGIN_SUFFIX)) {
      out.set(rel, readFileSync(join(configDir, rel), "utf8"));
    }
  }
  return out;
}

/** A JSON value in a canonical form: object keys sorted, array elements sorted. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((v) => JSON.stringify(canonical(v)))
      .sort()
      .map((s) => JSON.parse(s) as unknown);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The overrides anchored to an origin: its base `<name>.jsonc` and every
 *  `@app/<id>/<name>.jsonc` scope (a scope anchors to the BASE origin). */
function overridesOf(configDir: string, originRel: string): string[] {
  const dir = dirname(originRel);
  const name = basename(originRel, ORIGIN_SUFFIX);
  const at = (rel: string) => (dir === "." ? rel : `${dir}/${rel}`);
  const out = [at(`${name}.jsonc`)];
  const scopes = join(configDir, at(APP_SCOPE_DIR));
  if (existsSync(scopes)) {
    for (const e of readdirSync(scopes, { withFileTypes: true })) {
      if (e.isDirectory())
        out.push(at(`${APP_SCOPE_DIR}/${e.name}/${name}.jsonc`));
    }
  }
  return out.filter((rel) => existsSync(join(configDir, rel)));
}

/**
 * Re-stamp every committed override whose origin changed under it by nothing
 * but a recorded plugin move. `prior` is `snapshotConfigOrigins` taken before
 * codegen regenerated the origins; `root` is the checkout (its move ledger).
 * Returns the re-stamped overrides, `config/`-relative, sorted.
 */
export function restampMovedOverrides(opts: {
  root: string;
  prior: ReadonlyMap<string, string>;
}): string[] {
  const moves = readPluginMoves(opts.root);
  if (moves.length === 0) return [];
  const configDir = join(opts.root, "config");
  const restamped: string[] = [];
  for (const [rel, before] of opts.prior) {
    const path = join(configDir, rel);
    if (!existsSync(path)) continue;
    const after = readFileSync(path, "utf8");
    const oldHash = configTextHash(before);
    const newHash = configTextHash(after);
    if (oldHash === undefined || newHash === undefined || oldHash === newHash)
      continue;

    const rerooted = moves.reduce(
      (text, move) => rewriteKeys(rel, text, move),
      before,
    );
    if (rerooted === before) continue;
    const same =
      JSON.stringify(canonical(parseConfigText(rel, rerooted))) ===
      JSON.stringify(canonical(parseConfigText(rel, after)));
    if (!same) continue;

    for (const override of overridesOf(configDir, rel)) {
      const file = join(configDir, override);
      const text = readFileSync(file, "utf8");
      if (configTextHash(text) !== oldHash) continue;
      writeFileSync(file, withConfigTextHash(text, newHash));
      restamped.push(override);
    }
  }
  return restamped.sort();
}
