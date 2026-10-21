// The generic "rewrite a namespace's saved config once" ledger.
//
// A namespace's USER-layer config (`~/.singularity/state/config/<ns>/`) is not
// in git, so no commit can carry a change to it — and a hand-run migration is a
// step that gets skipped. Instead `./singularity build` replays committed,
// keyed entries onto the namespace dir right before it propagates the git
// config there, and records each applied key in a per-ledger marker file, so an
// entry runs exactly once per namespace. Two ledgers ride this engine:
//
//   - plugin moves (`plugin-meta/relocate`): files follow a moved plugin and
//     saved reorder keys are re-rooted;
//   - config migrations (`defineConfigMigration`, config_v2): a descriptor's
//     saved values are rewritten after its schema changed shape.
//
// Both rewrite `.jsonc` documents whose `// @hash` headers chain: an override
// records the hash of the default (origin) it was written against. Rewriting
// that default changes its hash, which would mark the override stale and let
// the default win — the very loss a migration exists to prevent. So
// `rewriteConfigFiles` rewrites snapshots (origins, ancestors) first, collects
// each old → new hash pair, and re-stamps every override anchored to an old one.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";
import {
  computeHash,
  CONFIG_HASH_RE,
  type JsonValue,
} from "@plugins/config_v2/core";

const appliedSchema = z.object({ applied: z.array(z.string()) });

/** Every file under `dir`, relative to it, forward-slash separated. */
export function walkConfigFiles(
  dir: string,
  rel = "",
  out: string[] = [],
): string[] {
  if (!existsSync(join(dir, rel))) return out;
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) walkConfigFiles(dir, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function readApplied(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  return new Set(
    appliedSchema.parse(JSON.parse(readFileSync(file, "utf8"))).applied,
  );
}

function writeApplied(file: string, applied: Set<string>): void {
  writeFileSync(
    file,
    `${JSON.stringify({ applied: [...applied] }, null, 2)}\n`,
  );
}

export interface ConfigLedgerEntry<R> {
  /** Stable, unique within the ledger — what the marker records. */
  readonly key: string;
  /** Rewrite the namespace dir; what it returns is reported back. */
  apply(userConfigDir: string): R;
}

/**
 * Apply, in order, every entry `userConfigDir` has not applied yet, recording
 * each key in `<userConfigDir>/<markerFile>` right after it runs, so a failed
 * build resumes where it stopped. A `fresh` namespace (nothing saved yet) has
 * nothing to rewrite: every entry is recorded without running. The marker is
 * not `.jsonc`, so neither the config registry nor the orphan audit reads it.
 */
export function runConfigLedger<R>(opts: {
  userConfigDir: string;
  markerFile: string;
  fresh: boolean;
  entries: readonly ConfigLedgerEntry<R>[];
}): { key: string; result: R }[] {
  const { userConfigDir, markerFile, fresh, entries } = opts;
  mkdirSync(userConfigDir, { recursive: true });
  const file = join(userConfigDir, markerFile);
  const applied = readApplied(file);
  const out: { key: string; result: R }[] = [];
  for (const entry of entries) {
    if (applied.has(entry.key)) continue;
    if (!fresh)
      out.push({ key: entry.key, result: entry.apply(userConfigDir) });
    applied.add(entry.key);
    writeApplied(file, applied);
  }
  return out;
}

export function parseConfigText(file: string, text: string): JsonValue {
  const errors: ParseError[] = [];
  const body = text.replace(CONFIG_HASH_RE, "");
  const value = parseJsonc(body, errors, { allowTrailingComma: true }) as
    JsonValue | undefined;
  if (errors.length > 0 || value === undefined) {
    throw new Error(`config ledger: ${file} is not valid JSONC`);
  }
  return value;
}

/** The hash a config file's first line records, or undefined when it has none. */
export function configTextHash(text: string): string | undefined {
  return CONFIG_HASH_RE.exec(text)?.[1];
}

function setHash(text: string, hash: string): string {
  return text.replace(CONFIG_HASH_RE, `// @hash ${hash}\n`);
}

const isSnapshot = (f: string) =>
  f.endsWith(".origin.jsonc") || f.endsWith(".ancestor.jsonc");

/**
 * Rewrite the `.jsonc` files of `dir` that `select` picks through `rewrite`
 * (text in, text out; return it unchanged to leave a file alone), keeping the
 * hash chain: each rewritten snapshot gets the hash of its new content, and
 * each override whose header named a rewritten snapshot's old hash is
 * re-stamped with the new one. Returns the rewritten files, sorted.
 */
export function rewriteConfigFiles(
  dir: string,
  opts: {
    select?: (rel: string) => boolean;
    rewrite: (rel: string, text: string) => string;
  },
): string[] {
  const select = opts.select ?? (() => true);
  const files = walkConfigFiles(dir).filter(
    (f) => f.endsWith(".jsonc") && select(f),
  );
  const next = new Map<string, string>();
  const rehash = new Map<string, string>();
  // Snapshots first: they produce the old → new hash pairs overrides follow.
  for (const f of [...files].sort(
    (a, b) => Number(isSnapshot(b)) - Number(isSnapshot(a)),
  )) {
    const text = readFileSync(join(dir, f), "utf8");
    let out = opts.rewrite(f, text);
    const header = configTextHash(out);
    if (isSnapshot(f)) {
      if (out !== text && header !== undefined) {
        const hash = computeHash(parseConfigText(f, out));
        rehash.set(header, hash);
        out = setHash(out, hash);
      }
    } else if (header !== undefined && rehash.has(header)) {
      out = setHash(out, rehash.get(header)!);
    }
    if (out !== text) next.set(f, out);
  }
  for (const [f, text] of next) writeFileSync(join(dir, f), text);
  return [...next.keys()].sort();
}
