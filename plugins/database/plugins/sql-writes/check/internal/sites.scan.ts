import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import ts from "typescript";
import { scanFileSites, type Marker, type ScannedSite } from "./sites";

// sql-writes:fit's per-file work as a fold kept along the directory tree
// (plugin-records' `foldRepoFiles`): each file's sites and marker comments,
// from its own bytes, so a pass after an edit parses only the edited files.
// Its records are keyed by this module's whole closure — the site scanner
// (`./sites`) included — so an edit to the scanner re-folds every file.

/** A marker comment, in its file. */
export interface FileMarker extends Marker {
  readonly file: string;
}

/** The sites and markers of a set of files, in path order. */
export interface SqlWritesPart {
  /** Files that passed the prefilter and were parsed. */
  readonly files: number;
  readonly sites: readonly ScannedSite[];
  readonly markers: readonly FileMarker[];
}

// A module talking to SQLite (bun:sqlite) holds SQLite's SQL, not the app's
// Postgres: a different database with a different grammar.
const SQLITE = /from\s+["']bun:sqlite["']/;
// Cheap prefilter before a file is parsed as TypeScript.
// A marker is matched too, so a file whose last raw write was typed still has
// its stale marker found.
const MENTIONS =
  /\b(insert|update|delete|merge|create|alter)\b|sql-writes:hand-written/i;

const NONE: SqlWritesPart = { files: 0, sites: [], markers: [] };

export const sqlWritesFold: FileFold<null, SqlWritesPart> = {
  url: import.meta.url,
  scan(src, rel) {
    if (!MENTIONS.test(src) || SQLITE.test(src)) return NONE;
    const { sites, markers } = scanFileSites(
      ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true),
    );
    return {
      files: 1,
      sites,
      markers: markers.map((m) => ({ file: rel, ...m })),
    };
  },
  combine: (parts) => ({
    files: parts.reduce((n, p) => n + p.files, 0),
    sites: parts.flatMap((p) => p.sites),
    markers: parts.flatMap((p) => p.markers),
  }),
};
