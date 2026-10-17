// The signature-table store: per program key, every lintable file's type
// fingerprint (`../shared/type-fingerprint`) in that program.
//
// The chicken and egg it breaks: a typed lint result is keyed on the file's
// type fingerprint, and fresh signatures exist only once tsc has run — inside
// the worker. Without a table every typed part is decided there, so the worker
// must run. With one, prepare knows every typed key up front, sends only the
// stale parts, and skips the worker outright when nothing is stale and the
// program PASS is recorded.
//
// Keyed like the PASS record and sound for the same reason: the program key
// pins the program's full content, and signatures are a function of it. So a
// table is recorded whatever the verdict — a program with type errors still
// has signatures — by `finalize`, under the key it recomputes from the
// buildinfo the worker WROTE.
//
// An entry stores the fingerprints only, concatenated in the order of the
// run's lintable-file list, with a hash of that list to check the alignment:
// ~180 KB for ~11.4k files, against ~1.1 MB with the paths spelled out — and
// the store is host-global, a new entry per program a run builds. A reader
// whose list differs gets no table (its typed parts are decided by the worker),
// never a misaligned one.

import { createHash } from "crypto";
import { z } from "zod";
import { typeFpTablesDir } from "../data-dirs";
import { openPassSet, type PassSetBounds } from "./pass-set";

/** A type fingerprint's length (`computeTypeFingerprints`: 16 hex digits). */
const FP_LENGTH = 16;

// One entry per program a run built, ~180 KB each: the count bound is what
// caps the disk (2,000 ≈ 360 MB), the 14-day age bound — the PASS record's —
// what normally evicts.
const BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxEntries: 2000,
  trimTo: 1600,
  pruneIntervalMs: 60 * 60 * 1000,
};

const entrySchema = z.object({
  /** sha256 of the lintable files, "\n"-joined, in the order `fps` follows. */
  files: z.string(),
  /** Each file's fingerprint, concatenated in that order. */
  fps: z.string(),
});

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** A program's table, or why this run cannot use one. */
export type TableLookup =
  { kind: "table"; fps: Map<string, string> } | { kind: "none"; why: string };

export interface TypeFpTables {
  /** The table recorded for this program, read against this run's `files`. */
  read(programName: string, key: string, files: readonly string[]): TableLookup;
  /**
   * Record `files`' fingerprints under this program. Every file must have one:
   * a lintable file is a root of the program (the coverage gate), so one
   * without a fingerprint is a contradiction, not a gap to paper over.
   */
  record(
    programName: string,
    key: string,
    files: readonly string[],
    fps: ReadonlyMap<string, string>,
  ): void;
}

/** Open the host-global signature-table store. */
export function openTypeFpTables(): TypeFpTables {
  const set = openPassSet(typeFpTablesDir, BOUNDS);
  const entryKey = (programName: string, key: string): string =>
    `${programName}:${key}`;
  return {
    read(programName, key, files) {
      const raw = set.read(entryKey(programName, key));
      if (raw === undefined) {
        return { kind: "none", why: "no table for this program yet" };
      }
      // Written by `record` below and renamed into place whole: a shape this
      // schema rejects is a bug in this file, surfaced.
      const entry = entrySchema.parse(raw);
      if (
        entry.files !== sha256(files.join("\n")) ||
        entry.fps.length !== files.length * FP_LENGTH
      ) {
        return {
          kind: "none",
          why: "the table was recorded for a different lintable-file list",
        };
      }
      const fps = new Map<string, string>();
      files.forEach((rel, i) => {
        fps.set(rel, entry.fps.slice(i * FP_LENGTH, (i + 1) * FP_LENGTH));
      });
      return { kind: "table", fps };
    },
    record(programName, key, files, fps) {
      const parts = files.map((rel) => {
        const fp = fps.get(rel);
        if (fp === undefined || fp.length !== FP_LENGTH) {
          throw new Error(
            `type-check: ${rel} is lintable but has no type fingerprint in the program the worker built`,
          );
        }
        return fp;
      });
      set.record(entryKey(programName, key), {
        files: sha256(files.join("\n")),
        fps: parts.join(""),
      });
    },
  };
}
