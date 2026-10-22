// The two-program type check's store (`./name-run.ts`): host-wide,
// content-addressed, one entry per file TEXT — no per-run or per-worktree
// state. A fresh worktree on a main tree reads the entries main's build wrote;
// a run writes only the files it checked (and the few whose resolution key it
// refreshed).
//
//   - `type-check-name-records`, key H(path, version — the git blob sha): the
//     file's imports (text only), its resolution record (`./name-resolve.ts`),
//     whether its syntax is global, and up to `MAX_VARIANTS` recent VARIANTS — its result under one
//     result key (`./name-walk.ts`): diagnostics, signature, raw `.d.ts` hash,
//     per-name records and the meanings they were recorded against.
//   - `type-check-contracts`, key: the hash of a raw `.d.ts` — its text, what a
//     later program is served for the file.
//   - in the contracts store too: key `detail\0<result key>`, a variant's
//     prediction data (inference edges, `depM`), read only for a file
//     re-checked in program 2; and key `program\0<global hash>`, the
//     program-level diagnostics (options, global) of the environment that hash
//     names, so a run that builds no program still reports them.

import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { contractsDir, nameRecordsDir } from "../data-dirs";
import { sha256 } from "./keys";
import { openPassSet, type PassSetBounds } from "./pass-set";

/** A file's result under one result key. */
export const variantSchema = z.object({
  /** The global hash it was recorded under. */
  global: z.string(),
  r: z.string(),
  contract: z.string(),
  signature: z.string(),
  diagnostics: z.array(z.string()),
  /** name → [t, d-edges]. */
  names: z.record(z.string(), z.tuple([z.string(), z.array(z.string())])),
  star: z.array(z.string()),
});

export type StoredVariant = z.infer<typeof variantSchema>;

/**
 * A variant's prediction data — its names' inference edges and the meanings
 * it was recorded against — apart from the entry: the walk reads every
 * entry on every run, and only a file re-checked in program 2 needs these
 * (two thirds of the bytes).
 */
export const detailSchema = z.object({
  i: z.record(z.string(), z.array(z.string())),
  depM: z.record(z.string(), z.string()),
});

export type VariantDetailEntry = z.infer<typeof detailSchema>;

export const entrySchema = z.object({
  global: z.boolean(),
  /** [specifier, mode, imported name] — `*` for a whole-module use. */
  imports: z.array(z.tuple([z.string(), z.number(), z.string()])),
  res: z.object({
    targets: z.array(z.tuple([z.string(), z.number(), z.string()])),
    dirs: z.array(z.string()),
    files: z.array(z.string()),
    key: z.string(),
  }),
  variants: z.array(variantSchema),
  recordedAt: z.number().optional(),
});

export type FileEntry = z.infer<typeof entrySchema>;

/** Variants kept per text: two worktrees on two versions of a hub's API keep both. */
export const MAX_VARIANTS = 4;

/** An entry older than this is re-written when read valid, so the age bound means "unused". */
export const REFRESH_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export interface NameStore {
  readEntry(path: string, version: string): FileEntry | undefined;
  writeEntry(path: string, version: string, entry: FileEntry): void;
  /**
   * A contract's text — undefined when the store no longer holds it (aged
   * out): the caller re-checks the file it belongs to instead.
   */
  readContract(hash: string): string | undefined;
  /** Whether a contract is stored (no read). */
  hasContract(hash: string): boolean;
  writeContract(hash: string, text: string): void;
  /** A variant's prediction data, by its result key — undefined when absent. */
  readDetail(r: string): VariantDetailEntry | undefined;
  writeDetail(r: string, detail: VariantDetailEntry): void;
  /**
   * Mark a file's records used — its entry, the contract and the prediction
   * data of its result `r` — without reading them: what the walk base does
   * for the files it carries fixed, which nothing reads (`./walk-base.ts`).
   */
  touch(path: string, version: string, contract: string, r: string): void;
  readProgramDiagnostics(global: string): string[] | undefined;
  writeProgramDiagnostics(global: string, diagnostics: string[]): void;
}

/**
 * What a file's VERSION is: its git blob sha, read out of the run's tree
 * (`./repo-view.ts`). Until 2026-10-21 it was the sha256 of the text, and an
 * entry keyed on one kind must never be read as the other, so the kind is part
 * of the format below.
 */
const VERSION_KIND = "git-blob";

/**
 * The FORMAT every key here is under: the version kind and the hash of this
 * module's own source. An entry written by another version of the schemas
 * below is not one this code can read, and nothing has to remember to bump a
 * number for that.
 */
const FORMAT = sha256(
  `${VERSION_KIND}\n${readFileSync(join(import.meta.dir, "name-store.ts"), "utf8")}`,
).slice(0, 12);

const entryKey = (path: string, version: string): string =>
  `${FORMAT}\0${path}\0${version}`;

// One entry per file text per tree version a host has seen: a full tree is
// ~12.5k, a commit adds a few dozen. Bounded like the lint result store.
const ENTRY_BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxEntries: 300000,
  trimTo: 240000,
  pruneIntervalMs: 60 * 60 * 1000,
};

// One per distinct `.d.ts` text: early cutoff makes them rarer than entries.
const CONTRACT_BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxEntries: 200000,
  trimTo: 160000,
  pruneIntervalMs: 60 * 60 * 1000,
};

const contractEntry = z.object({ text: z.string() });
const programEntry = z.object({ diagnostics: z.array(z.string()) });

/** Open the host-wide store. */
export function openNameStore(): NameStore {
  const entries = openPassSet(nameRecordsDir, ENTRY_BOUNDS);
  const contracts = openPassSet(contractsDir, CONTRACT_BOUNDS);
  const memo = new Map<string, string>();
  return {
    readEntry(path, version) {
      const raw = entries.read(entryKey(path, version));
      // Written by `writeEntry` below, renamed into place whole: a shape the
      // schema rejects is a bug here, surfaced.
      return raw === undefined ? undefined : entrySchema.parse(raw);
    },
    writeEntry(path, version, entry) {
      const { recordedAt: _drop, ...rest } = entry;
      entries.record(entryKey(path, version), rest);
    },
    readContract(hash) {
      const hit = memo.get(hash);
      if (hit !== undefined) return hit;
      const raw = contracts.read(hash);
      if (raw === undefined) return undefined;
      const text = contractEntry.parse(raw).text;
      memo.set(hash, text);
      // Marked used: the store's count bound evicts the least recently
      // USED, and a stable file's `.d.ts` is read for years, written once.
      contracts.touch(hash);
      return text;
    },
    hasContract: (hash) => memo.has(hash) || contracts.has(hash),
    writeContract(hash, text) {
      if (contracts.touch(hash)) return;
      contracts.record(hash, { text });
    },
    readDetail(r) {
      const raw = contracts.read(`${FORMAT}\0detail\0${r}`);
      return raw === undefined ? undefined : detailSchema.parse(raw);
    },
    writeDetail(r, detail) {
      contracts.record(`${FORMAT}\0detail\0${r}`, detail);
    },
    readProgramDiagnostics(global) {
      const raw = contracts.read(`${FORMAT}\0program\0${global}`);
      return raw === undefined
        ? undefined
        : programEntry.parse(raw).diagnostics;
    },
    writeProgramDiagnostics(global, diagnostics) {
      contracts.record(`${FORMAT}\0program\0${global}`, { diagnostics });
    },
    touch(path, version, contract, r) {
      entries.touch(entryKey(path, version));
      contracts.touch(contract);
      contracts.touch(`${FORMAT}\0detail\0${r}`);
    },
  };
}

/**
 * `store` read as empty and written through: a run over it checks every file
 * in one program and rewrites every entry — what a run does when the store
 * cannot be trusted (a divergence, a missed prediction).
 */
export function coldWriteThrough(store: NameStore): NameStore {
  return {
    readEntry: () => undefined,
    writeEntry: (p, v, e) => store.writeEntry(p, v, e),
    readContract: (h) => store.readContract(h),
    hasContract: (h) => store.hasContract(h),
    writeContract: (h, t) => store.writeContract(h, t),
    readDetail: (r) => store.readDetail(r),
    writeDetail: (r, d) => store.writeDetail(r, d),
    readProgramDiagnostics: () => undefined,
    writeProgramDiagnostics: (g, d) => store.writeProgramDiagnostics(g, d),
    touch: (p, v, c, r) => store.touch(p, v, c, r),
  };
}

/**
 * `store` with its WRITES kept in memory: reads see the store and what was
 * written here, the store itself is untouched. A comparison run's (the full
 * walk beside the incremental one, `./worker.ts`): both must start from the
 * same store.
 */
export function bufferedNameStore(store: NameStore): NameStore {
  const mem = memoryNameStore();
  return {
    readEntry: (p, v) => mem.readEntry(p, v) ?? store.readEntry(p, v),
    writeEntry: (p, v, e) => mem.writeEntry(p, v, e),
    readContract: (h) => mem.readContract(h) ?? store.readContract(h),
    hasContract: (h) => mem.hasContract(h) || store.hasContract(h),
    writeContract: (h, t) => mem.writeContract(h, t),
    readDetail: (r) => mem.readDetail(r) ?? store.readDetail(r),
    writeDetail: (r, d) => mem.writeDetail(r, d),
    readProgramDiagnostics: (g) =>
      mem.readProgramDiagnostics(g) ?? store.readProgramDiagnostics(g),
    writeProgramDiagnostics: (g, d) => mem.writeProgramDiagnostics(g, d),
    touch: () => {},
  };
}

/** An in-memory store: tests, and a dual run's fresh oracle. */
export function memoryNameStore(): NameStore & {
  entries: Map<string, FileEntry>;
  contracts: Map<string, string>;
} {
  const entries = new Map<string, FileEntry>();
  const contracts = new Map<string, string>();
  const details = new Map<string, VariantDetailEntry>();
  const programs = new Map<string, string[]>();
  return {
    entries,
    contracts,
    readEntry: (p, v) => {
      const e = entries.get(entryKey(p, v));
      return e === undefined ? undefined : structuredClone(e);
    },
    writeEntry: (p, v, e) =>
      void entries.set(entryKey(p, v), structuredClone(e)),
    readContract: (hash) => contracts.get(hash),
    hasContract: (hash) => contracts.has(hash),
    writeContract: (hash, text) => void contracts.set(hash, text),
    readDetail(r) {
      const d = details.get(r);
      return d === undefined ? undefined : structuredClone(d);
    },
    writeDetail: (r, d) => void details.set(r, structuredClone(d)),
    readProgramDiagnostics: (g) => programs.get(g),
    writeProgramDiagnostics: (g, d) => void programs.set(g, d),
    touch: () => {},
  };
}
