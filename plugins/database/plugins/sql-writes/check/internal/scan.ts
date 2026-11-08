import { loadModule, type Node } from "libpg-query";
import { relative } from "path";
import { SchemaModel } from "./model";
import type { ExportRef } from "./probe-types";
import { runSchemaProbe } from "./run-probe";
import { repoCompilerOptions, SiteScanner, type SqlSite } from "./sites";
import { parseSite, type Parsed } from "./statements";
import { validateStatements, writesIn, type IssueKind } from "./validate";

export interface FileIssue {
  readonly file: string;
  readonly line: number;
  readonly kind: IssueKind;
  readonly message: string;
}

export interface WriteSite {
  readonly file: string;
  readonly line: number;
  readonly tagged: boolean;
  readonly text: string;
  readonly stmts: readonly Node[];
  /** Offset of the marker comment binding it, or null. */
  readonly marker: number | null;
}

/** A marker comment that binds no write site. */
export interface StrayMarker {
  readonly file: string;
  readonly line: number;
  /** How many write sites it binds: 0 (stale) or more than 1 (shared). */
  readonly binds: number;
}

export type ScanResult =
  | {
      readonly kind: "ok";
      readonly files: number;
      readonly writeSites: number;
      readonly statements: number;
      readonly issues: readonly FileIssue[];
      /** Every write site, with its parsed statements. */
      readonly writes: readonly WriteSite[];
      /**
       * Marker comments binding no write site (stale) or several (shared):
       * a marker declares exactly ONE write, so a write added under it later
       * is not covered by a declaration made for another.
       */
      readonly strayMarkers: readonly StrayMarker[];
    }
  | { readonly kind: "failed"; readonly message: string };

// A module talking to SQLite (bun:sqlite) holds SQLite's SQL, not the app's
// Postgres: a different database with a different grammar.
const SQLITE = /from\s+["']bun:sqlite["']/;
// Cheap prefilter before a file is parsed as TypeScript.
// A marker is matched too, so a file whose last raw write was typed still has
// its stale marker found.
const MENTIONS =
  /\b(insert|update|delete|merge|create|alter)\b|sql-writes:hand-written/i;

export async function scanSqlWrites(opts: {
  readonly root: string;
  /** Repo-relative candidate files. */
  readonly files: readonly string[];
  readonly read: (rel: string) => Promise<string | null>;
  readonly readSync: (abs: string) => string | null;
  /** Absolute schema-glob files. */
  readonly schemaFiles: readonly string[];
}): Promise<ScanResult> {
  await loadModule();
  const scanner = new SiteScanner(
    opts.root,
    repoCompilerOptions(opts.root),
    opts.readSync,
    new Set(opts.schemaFiles),
  );
  const texts = await Promise.all(
    opts.files.map(async (f) => [f, await opts.read(f)] as const),
  );
  const sites: SqlSite[] = [];
  const markers = new Map<string, { text: string; at: number[] }>();
  let files = 0;
  for (const [file, text] of texts) {
    if (text === null || !MENTIONS.test(text) || SQLITE.test(text)) continue;
    files++;
    const scanned = await scanner.scan(file, text);
    sites.push(...scanned.sites);
    if (scanned.markers.length > 0)
      markers.set(file, { text, at: scanned.markers });
  }

  // One probe for every export a hole names.
  const refs = new Map<string, ExportRef>();
  const refIdOf = (r: Omit<ExportRef, "id">) =>
    `${r.file}#${r.exportName}.${r.path.join(".")}`;
  for (const s of sites)
    for (const h of s.holes)
      if (h.kind === "export")
        refs.set(refIdOf(h.ref), { id: refIdOf(h.ref), ...h.ref });
  const probe = await runSchemaProbe(opts.root, {
    files: opts.schemaFiles,
    refs: [...refs.values()],
  });
  if (probe.kind === "probe-failed")
    return { kind: "failed", message: probe.message };
  if (probe.loadFailures.length > 0)
    return {
      kind: "failed",
      message:
        `${probe.loadFailures.length} schema file(s) failed to load, so their tables are unknown:\n` +
        probe.loadFailures
          .map((f) => `  ${relative(opts.root, f.file)} — ${f.error}`)
          .join("\n"),
    };

  const parsed: { site: SqlSite; parsed: Parsed }[] = sites.map((site) => ({
    site,
    parsed: parseSite(site, (i) => {
      const h = site.holes[i];
      return h?.kind === "export" ? probe.refs[refIdOf(h.ref)] : undefined;
    }),
  }));

  // The declared schema: the probe's tables, then every hand-written CREATE,
  // then every ALTER (in file order).
  const model = SchemaModel.fromProbe(probe, (abs) => relative(opts.root, abs));
  for (const { site, parsed: p } of parsed)
    if (p.kind === "parsed")
      for (const stmt of p.stmts)
        model.applyCreate(stmt, `${site.file}:${site.line}`);
  for (const { parsed: p } of parsed)
    if (p.kind === "parsed") for (const stmt of p.stmts) model.applyAlter(stmt);

  const issues: FileIssue[] = [];
  const writes: WriteSite[] = [];
  let writeSites = 0;
  let statements = 0;
  for (const { site, parsed: p } of parsed) {
    if (p.kind === "unparseable") {
      // An untagged string that is no statement is prose; a sql`…` tag that
      // reads as a write and does not parse cannot be checked.
      if (site.tagged)
        issues.push({
          file: site.file,
          line: site.line,
          kind: "dynamic",
          message: `a sql\`…\` write that does not parse as Postgres (${p.error}): ${oneLine(p.text)}`,
        });
      continue;
    }
    const n = writesIn(p.stmts);
    if (n === 0) continue;
    writeSites++;
    writes.push({
      file: site.file,
      line: site.line,
      tagged: site.tagged,
      text: p.text,
      stmts: p.stmts,
      marker: site.marker,
    });
    statements += n;
    for (const issue of validateStatements(p.stmts, model))
      issues.push({ file: site.file, line: site.line, ...issue });
  }
  const binds = new Map<string, number>();
  for (const w of writes)
    if (w.marker !== null) {
      const k = `${w.file}#${w.marker}`;
      binds.set(k, (binds.get(k) ?? 0) + 1);
    }
  const strayMarkers: StrayMarker[] = [];
  for (const [file, { text, at }] of markers)
    for (const pos of at) {
      const n = binds.get(`${file}#${pos}`) ?? 0;
      if (n !== 1)
        strayMarkers.push({
          file,
          line: text.slice(0, pos).split("\n").length,
          binds: n,
        });
    }
  return {
    kind: "ok",
    files,
    writeSites,
    statements,
    issues,
    writes,
    strayMarkers,
  };
}

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 140 ? `${t.slice(0, 140)}…` : t;
}
