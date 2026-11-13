import { loadModule, type Node } from "libpg-query";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { SchemaModel } from "./model";
import type { ExportRef } from "./probe-types";
import { runSchemaProbe } from "./run-probe";
import type { ScannedSite, SqlSite } from "./sites";
import type { SqlWritesPart } from "./sites.scan";
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

export async function scanSqlWrites(opts: {
  /** The run's file set: the probe's answer is keyed over it. */
  readonly repo: RepoFiles;
  /** Every candidate file's sites and markers (`sites.scan.ts`, folded). */
  readonly folded: SqlWritesPart;
  /** Follows the holes another file decides (`resolve.ts`). */
  readonly resolver: { resolveSite(site: ScannedSite): Promise<SqlSite> };
  /** The schema-glob files, repo-relative. */
  readonly schemaFiles: readonly string[];
}): Promise<ScanResult> {
  await loadModule();
  const sites: SqlSite[] = [];
  for (const site of opts.folded.sites)
    sites.push(await opts.resolver.resolveSite(site));
  const files = opts.folded.files;

  // One probe for every export a hole names.
  const refs = new Map<string, ExportRef>();
  const refIdOf = (r: Omit<ExportRef, "id">) =>
    `${r.file}#${r.exportName}.${r.path.join(".")}`;
  for (const s of sites)
    for (const h of s.holes)
      if (h.kind === "export")
        refs.set(refIdOf(h.ref), { id: refIdOf(h.ref), ...h.ref });
  const probe = await runSchemaProbe(opts.repo, {
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
        probe.loadFailures.map((f) => `  ${f.file} — ${f.error}`).join("\n"),
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
  const model = SchemaModel.fromProbe(probe);
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
  for (const m of opts.folded.markers) {
    const n = binds.get(`${m.file}#${m.pos}`) ?? 0;
    if (n !== 1) strayMarkers.push({ file: m.file, line: m.line, binds: n });
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
