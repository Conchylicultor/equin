// THE WALK of the two-program type check (`./name-run.ts`): which files have a
// valid stored result, which must be checked, and the keys of both. PURE — no
// TypeScript, no I/O: records in, sets and hashes out.
//
// MEANING. A name's meaning hash is a Merkle hash over the name-use graph:
//
//   M(F#n) = H( t(F#n), M of every d-edge target of F#n )
//
// where `t` is the hash of the name's canonical `.d.ts` text and its d-edges
// are what that text references (`./name-records.ts`). Inference edges are
// NOT in M: an importer sees the `.d.ts` text and what it names, nothing else.
// They serve only to PREDICT which names of a file being re-checked can move.
// A cycle of names hashes as one component. A name the module does not export
// is reached through its star re-exports, or is `absent`; `F#*` (a namespace
// use, a star set) is the hash of every name of F.
//
// RESULT KEY, per file:
//
//   R(F) = H( global, F's path and version, (use, M(use)) for every name F's
//             source uses )
//
// A stored VARIANT of F (same text, recorded under some R) is valid iff its R
// is today's. What a file's check reads is its text, the `.d.ts` of what it
// imports and of everything those name, and the global scope (`global`: the
// engine, every global file's version) — exactly what R hashes.
//
// Files are visited by strongly-connected component of their USE graph, every
// component after the ones it uses. Inside an import cycle a member's key
// needs the other members' names, whose records depend on which of their
// variants is valid — so a cycle SETTLES: start each member on its newest
// variant, hash the names, key each member, keep the variant valid under its
// key, demote the misses, repeat until nothing changes. Per file still: a body
// edit inside a cycle re-checks the file, not the cycle.
//
// THE PHASES (`./name-run.ts` drives them):
//
//   0. Before program 1: a file with no stored record for its text, or with
//      every use known and no variant matching, goes to PROGRAM 1. A file
//      that uses a name of one of those is PENDING: its key waits for program
//      1's records.
//   1. After program 1: each pending file is keyed. A hit is valid; a miss
//      goes to PROGRAM 2, and so does everything using a name that can move —
//      predicted from the previous variant's edges: a name is ⊥ (null) when
//      one of its d- or i-edges reaches a target whose meaning changed since
//      that variant was recorded (`depM`), transitively among the program-2
//      files of its cycle. A program-1 file that read a stored `.d.ts` which
//      turns out stale (served before its owner was keyed) joins program 2 the
//      same way.
//   2. After program 2: every record is known; the final keys are computed for
//      the files checked, to record them.

import { createHash } from "crypto";
import { nameKey, splitKey, WHOLE, type NameRec } from "./name-records";
import { forEachComponent } from "./keys";

const h = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);

/** What the walk reads of one record — a stored variant or a fresh check. */
export interface WalkRecord {
  names: Readonly<Record<string, NameRec>>;
  star: readonly string[];
  /**
   * The meaning of every target outside the file its uses and its names' edges
   * reach, when the record was made — what a later run compares against to
   * predict which names can move. Empty for a record made this run.
   */
  depM: Readonly<Record<string, string>>;
}

/**
 * A stored variant: a record and the key it is valid under. Its names' `i`
 * edges and its `depM` are empty here — only a file re-checked in program 2
 * needs them, and they are read then (`WalkInput.detail`).
 */
export interface WalkVariant extends WalkRecord {
  r: string;
  /** The hash of its raw `.d.ts` (what importers were served). */
  contract: string;
}

/** What predicting a re-checked file's names needs of its previous variant. */
export interface VariantDetail {
  /** name → its inference edges. */
  i: Readonly<Record<string, readonly string[]>>;
  depM: Readonly<Record<string, string>>;
}

/** One repo source file, as the walk sees it. */
export interface WalkFile {
  version: string;
  /**
   * What its source uses, as name keys (resolved first hops). Undefined when
   * there is no stored record for this text and it was not checked yet.
   */
  uses: readonly string[] | undefined;
  /** Its stored variants for this text under the current global hash, newest first. */
  variants: readonly WalkVariant[];
  /** Its record from this run's check, once checked. */
  fresh?: WalkRecord;
}

export interface WalkInput {
  files: ReadonlyMap<string, WalkFile>;
  global: string;
  /** The meaning of a repo file that is not a checked source (JSON, a module `.d.ts`): its version. */
  declMeaning(path: string): string;
  /** A stored variant's prediction data (read only for files going to program 2). */
  detail(path: string, variant: WalkVariant): VariantDetail;
}

/** A name or file meaning: a hash, `null` (⊥: may change this run). */
type Meaning = string | null;

/**
 * The shared machinery: components over the use graph (plus each record's
 * d-edge owners, so a name's targets are hashed before it), meanings as files
 * get their record.
 */
class Meanings {
  /** The record each visited file's names come from; null: every name ⊥. */
  readonly recOf = new Map<string, WalkRecord | null>();
  /** Names forced to ⊥ in a file whose record is otherwise known. */
  readonly bottomNames = new Map<string, Set<string>>();
  private readonly m = new Map<string, Meaning>();
  private readonly wholeMemo = new Map<string, Meaning>();

  constructor(private readonly input: WalkInput) {}

  /** A target's meaning: undefined when its owner was not visited yet. */
  of(key: string, guard: Set<string> = new Set()): Meaning | undefined {
    const [p, n] = splitKey(key);
    if (!this.input.files.has(p))
      return h(`decl\0${p}\0${this.input.declMeaning(p)}`);
    if (!this.recOf.has(p)) return undefined;
    const rec = this.recOf.get(p)!;
    if (rec === null) return null;
    if (n === WHOLE) return this.whole(p, guard);
    if (rec.names[n] !== undefined) {
      const v = this.m.get(key);
      if (v === undefined) {
        throw new Error(`name-walk: ${p}#${n} has a record but no meaning yet`);
      }
      return v;
    }
    if (rec.star.length === 0) return h(`absent\0${p}\0${n}`);
    if (guard.has(key)) return h(`star-cycle\0${key}`);
    guard.add(key);
    const parts: string[] = [];
    for (const s of rec.star) {
      const v = this.of(nameKey(s, n), guard);
      if (v === undefined || v === null) return null;
      parts.push(v);
    }
    return h(`via\0${n}\0${parts.join("\0")}`);
  }

  private whole(p: string, guard: Set<string>): Meaning {
    const memo = this.wholeMemo.get(p);
    if (memo !== undefined) return memo;
    const key = nameKey(p, WHOLE);
    if (guard.has(key)) return h(`star-cycle\0${key}`);
    guard.add(key);
    const rec = this.recOf.get(p)!;
    if (rec === null) return null;
    const parts: string[] = [];
    for (const n of Object.keys(rec.names).sort()) {
      const v = this.m.get(nameKey(p, n));
      if (v === undefined || v === null) {
        this.wholeMemo.set(p, null);
        return null;
      }
      parts.push(`${n}\0${v}`);
    }
    for (const s of rec.star) {
      if (!this.input.files.has(s)) {
        parts.push(`*${s}`);
        continue;
      }
      if (!this.recOf.has(s)) return null;
      const v = this.whole(s, guard);
      if (v === null) {
        this.wholeMemo.set(p, null);
        return null;
      }
      parts.push(`*${s}\0${v}`);
    }
    const out = h(`whole\0${parts.join("\n")}`);
    this.wholeMemo.set(p, out);
    return out;
  }

  /**
   * Give a component's members their records (null: all ⊥) and hash their
   * names: a component of names (d-edges inside the files) hashes as one, ⊥
   * when any target is ⊥ or unknown, or a member is in `bottomNames`.
   */
  assign(
    members: readonly string[],
    recs: ReadonlyMap<string, WalkRecord | null>,
  ): void {
    for (const p of members) {
      this.recOf.set(p, recs.get(p)!);
      this.wholeMemo.delete(p);
    }
    const nodes: string[] = [];
    const own = new Set<string>();
    for (const p of members) {
      const rec = recs.get(p);
      if (!rec) continue;
      for (const n of Object.keys(rec.names)) {
        const k = nameKey(p, n);
        nodes.push(k);
        own.add(k);
      }
    }
    const index = new Map(nodes.map((k, i) => [k, i]));
    const recOfKey = (k: string): NameRec => {
      const [p, n] = splitKey(k);
      return recs.get(p)!.names[n]!;
    };
    forEachComponent(
      nodes.map((_, i) => i),
      (v) => {
        const out: number[] = [];
        for (const d of recOfKey(nodes[v]!).d) {
          const i = index.get(d);
          if (i !== undefined) out.push(i);
        }
        return out;
      },
      (comp) => {
        const keys = comp.map((i) => nodes[i]!);
        let bottom = keys.some((k) => {
          const [p, n] = splitKey(k);
          return this.bottomNames.get(p)?.has(n) === true;
        });
        const ext: string[] = [];
        const inComp = new Set(keys);
        for (const k of keys) {
          for (const d of recOfKey(k).d) {
            if (inComp.has(d)) continue;
            const v = own.has(d) ? this.m.get(d) : this.of(d);
            if (v === undefined || v === null) {
              bottom = true;
              break;
            }
            ext.push(v);
          }
          if (bottom) break;
        }
        const value: Meaning = bottom
          ? null
          : h(
              `names\0${keys
                .map((k) => `${k}\0${recOfKey(k).t}`)
                .sort()
                .join("\n")}\0${[...new Set(ext)].sort().join("\n")}`,
            );
        for (const k of keys) this.m.set(k, value);
      },
    );
  }
}

/** Components of the use graph, dependencies first. */
function components(
  files: ReadonlyMap<string, WalkFile>,
  extraEdges: (p: string) => readonly string[],
): string[][] {
  const paths = [...files.keys()].sort();
  const idx = new Map(paths.map((p, i) => [p, i]));
  const out: string[][] = [];
  forEachComponent(
    paths.map((_, i) => i),
    (v) => {
      const p = paths[v]!;
      const f = files.get(p)!;
      const targets = new Set<number>();
      for (const k of [...(f.uses ?? []), ...extraEdges(p)]) {
        const i = idx.get(splitKey(k)[0]);
        if (i !== undefined && i !== v) targets.add(i);
      }
      return [...targets];
    },
    (comp) => out.push(comp.map((i) => paths[i]!).sort()),
  );
  return out;
}

/** The d-edge targets of a record's names (for ordering). */
const dTargets = (rec: WalkRecord | undefined): string[] =>
  rec === undefined ? [] : Object.values(rec.names).flatMap((n) => n.d);

/**
 * A file's result key: its text and the meaning of every name it uses — in
 * other components, or in its own import cycle (whose names hash through the
 * name graph like any) — or null when one of them is ⊥. Per FILE, so a body
 * edit inside a cycle stops at the file, as it does outside one.
 */
function fileKey(
  p: string,
  files: ReadonlyMap<string, WalkFile>,
  global: string,
  meanings: Meanings,
): string | null {
  const f = files.get(p)!;
  const lines: string[] = [];
  for (const k of f.uses ?? []) {
    if (splitKey(k)[0] === p) continue; // its own names are its text
    const v = meanings.of(k);
    if (v === undefined || v === null) return null;
    lines.push(`${k}\0${v}`);
  }
  return h(`file\0${global}\0${p}\0${f.version}\0${lines.sort().join("\n")}`);
}

/** At most this many passes to settle a cycle's records; past it, a miss. */
const MAX_PASSES = 8;

// ─── Phase 0 ────────────────────────────────────────────────────────────────

export interface Phase0 {
  /** Program 1's sources. */
  first: Set<string>;
  /** Files whose key waits for program 1. */
  pending: Set<string>;
  /** Files with a valid stored variant, and which. */
  valid: Map<string, WalkVariant>;
}

/**
 * Before program 1. A component's members start on their newest stored
 * variant; each pass hashes their names, keys each member, and keeps the
 * variant valid under that key (another one may be) — a member with no
 * matching variant goes to program 1, one with a use still unknown waits.
 * Settled when a pass changes nothing.
 */
export function phase0(input: WalkInput): Phase0 {
  const { files, global } = input;
  const meanings = new Meanings(input);
  const first = new Set<string>();
  const pending = new Set<string>();
  const valid = new Map<string, WalkVariant>();
  const comps = components(files, (p) => dTargets(files.get(p)!.variants[0]));
  for (const members of comps) {
    const rec = new Map<string, WalkVariant | null>();
    for (const p of members) {
      const f = files.get(p)!;
      if (f.uses === undefined || f.variants.length === 0) {
        first.add(p);
        rec.set(p, null);
      } else rec.set(p, f.variants[0]!);
    }
    for (let pass = 0; ; pass++) {
      meanings.assign(members, rec);
      let changed = false;
      for (const p of members) {
        const cur = rec.get(p);
        if (cur === null || cur === undefined) continue;
        const r = fileKey(p, files, global, meanings);
        const v =
          r === null
            ? undefined
            : files.get(p)!.variants.find((x) => x.r === r);
        if (v === cur) continue;
        changed = true;
        if (v !== undefined && pass < MAX_PASSES) {
          rec.set(p, v);
          continue;
        }
        rec.set(p, null);
        if (r === null) pending.add(p);
        else first.add(p);
      }
      if (!changed) break;
    }
    for (const p of members) {
      const v = rec.get(p);
      if (v) valid.set(p, v);
    }
  }
  return { first, pending, valid };
}

// ─── Phase 1 ────────────────────────────────────────────────────────────────

export interface Phase1 {
  /** Program 2's sources (re-checks; lint-only sources are the caller's). */
  second: Set<string>;
  /** Every file not checked this run with a valid stored variant. */
  valid: Map<string, WalkVariant>;
  /** Program-1 files whose fresh record stands, with their result key. */
  confirmed: Map<string, string>;
  /** Each program-2 file's predicted-stable names (to verify after the check). */
  stable: Map<string, { prev: WalkRecord; names: Set<string> }>;
  /** Program-1 files that read a stale served `.d.ts` (joined program 2). */
  tainted: Set<string>;
  /**
   * Why each other program-2 file is there: its key `moved` (a name it uses
   * means something else), or a name it uses is ⊥ (`bottom`: predicted to
   * possibly move).
   */
  why: Map<string, "moved" | "bottom">;
}

/**
 * After program 1. `files` carries program 1's records (`fresh`, and their
 * `uses`); `served` is what program 1 was given for each file it loaded as a
 * `.d.ts`: the hash of the contract served.
 *
 * Each component settles like phase 0, a member in one of three states: a
 * stored variant (valid), program 1's record (confirmed), or program 2. A
 * member using a name of a program-2 member goes to program 2 too (within the
 * cycle, every name of a re-checked file counts as ⊥ while it settles). Then
 * each program-2 member's names are predicted from its previous record: ⊥
 * where its d- or i-edges reach a target whose meaning moved since that
 * record was made (`depM`), stable otherwise — what files outside the
 * component see.
 */
export function phase1(
  input: WalkInput,
  first: ReadonlySet<string>,
  served: ReadonlyMap<string, string>,
): Phase1 {
  const { files, global } = input;
  const meanings = new Meanings(input);
  const second = new Set<string>();
  const valid = new Map<string, WalkVariant>();
  const confirmed = new Map<string, string>();
  const stable = new Map<string, { prev: WalkRecord; names: Set<string> }>();
  const tainted = new Set<string>();
  const why = new Map<string, "moved" | "bottom">();
  // A file is STALE-READ when program 1 was served a `.d.ts` of it that is not
  // its final one (it is re-checked, or keyed to another variant), or when it
  // uses such a file: whatever loaded it through that path may have seen stale
  // text.
  const staleRead = new Set<string>();
  // Directly stale: served to program 1, and not what it is now (re-checked,
  // or keyed to another variant). Program-1 records are judged against these.
  const directStale = new Set<string>();
  // A program-2 file's PREVIOUS record: program 1's for a file it checked,
  // else its newest variant with its prediction data.
  const prevMemo = new Map<string, WalkRecord | null>();
  const prevOf = (p: string): WalkRecord | null => {
    if (prevMemo.has(p)) return prevMemo.get(p)!;
    const f = files.get(p)!;
    const v = f.variants[0];
    let rec: WalkRecord | null = null;
    if (f.fresh !== undefined) rec = f.fresh;
    else if (v !== undefined) {
      const d = input.detail(p, v);
      rec = {
        names: Object.fromEntries(
          Object.entries(v.names).map(([n, r]) => [
            n,
            { ...r, i: [...(d.i[n] ?? [])] },
          ]),
        ),
        star: v.star,
        depM: d.depM,
      };
    }
    prevMemo.set(p, rec);
    return rec;
  };
  const comps = components(files, (p) =>
    dTargets(files.get(p)!.fresh ?? files.get(p)!.variants[0]),
  );
  for (const members of comps) {
    type State =
      | { kind: "valid"; v: WalkVariant }
      | { kind: "confirmed" }
      | { kind: "second" };
    const state = new Map<string, State>();
    for (const p of members) {
      const f = files.get(p)!;
      if (first.has(p)) state.set(p, { kind: "confirmed" });
      else if (f.variants[0] !== undefined) {
        state.set(p, { kind: "valid", v: f.variants[0] });
      } else state.set(p, { kind: "second" });
    }
    const readsStale = (p: string): boolean =>
      (files.get(p)!.uses ?? []).some((k) => {
        const o = splitKey(k)[0];
        return o !== p && staleRead.has(o);
      });
    let bottom = new Set<string>();
    for (let pass = 0; ; pass++) {
      const recs = new Map<string, WalkRecord | null>();
      for (const p of members) {
        const st = state.get(p)!;
        recs.set(
          p,
          st.kind === "valid"
            ? st.v
            : st.kind === "confirmed"
              ? files.get(p)!.fresh!
              : prevOf(p),
        );
      }
      // Stale reads among the members, as they stand this pass.
      for (const p of members) {
        const st = state.get(p)!;
        const s = served.get(p);
        if (
          s !== undefined &&
          (st.kind === "second" || (st.kind === "valid" && st.v.contract !== s))
        ) {
          staleRead.add(p);
          directStale.add(p);
        }
      }
      for (let grew = true; grew;) {
        grew = false;
        for (const p of members) {
          if (!staleRead.has(p) && readsStale(p)) {
            staleRead.add(p);
            grew = true;
          }
        }
      }
      // The program-2 members' names: what they mean under their previous
      // records (no name ⊥ yet), then which of them can move.
      const p2 = members.filter((p) => state.get(p)!.kind === "second");
      for (const p of members) meanings.bottomNames.delete(p);
      meanings.assign(members, recs);
      bottom = predictBottom(
        p2,
        prevOf,
        meanings,
        directStale,
        served,
        first,
        files,
        second,
      );
      for (const p of p2) {
        const rec = recs.get(p);
        if (rec === null || rec === undefined) continue;
        meanings.bottomNames.set(
          p,
          new Set(
            Object.keys(rec.names).filter((n) => bottom.has(nameKey(p, n))),
          ),
        );
      }
      meanings.assign(members, recs);

      let changed = false;
      for (const p of members) {
        const st = state.get(p)!;
        if (st.kind === "second") continue;
        const r = fileKey(p, files, global, meanings);
        if (st.kind === "confirmed") {
          if (r !== null && !readsStale(p)) continue;
          state.set(p, { kind: "second" });
          tainted.add(p);
          changed = true;
          continue;
        }
        const v =
          r === null
            ? undefined
            : files.get(p)!.variants.find((x) => x.r === r);
        if (v === st.v) continue;
        changed = true;
        if (v !== undefined && pass < MAX_PASSES)
          state.set(p, { kind: "valid", v });
        else {
          state.set(p, { kind: "second" });
          why.set(p, r === null ? "bottom" : "moved");
        }
      }
      if (!changed) break;
    }

    for (const p of members) {
      const st = state.get(p)!;
      if (st.kind === "valid") valid.set(p, st.v);
      else if (st.kind === "confirmed") {
        confirmed.set(p, fileKey(p, files, global, meanings)!);
      } else {
        second.add(p);
        const rec = prevOf(p);
        if (rec === null) continue;
        stable.set(p, {
          prev: rec,
          names: new Set(
            Object.keys(rec.names).filter((n) => !bottom.has(nameKey(p, n))),
          ),
        });
      }
    }
  }
  return { second, valid, confirmed, stable, tainted, why };
}

/**
 * Which names of the program-2 files `p2` (one component's) can move. A name
 * is ⊥ when a target outside its file means something else now than what its
 * record was made against — for a stored record, `depM`; for a program-1
 * record, what program 1 was served: a program-2 file (`second`, from an
 * earlier component, or a member) counts as served its previous record unless
 * it was served another contract; any other owner served a contract it no
 * longer has (`directStale`) counts as moved — or when a target in a program-2
 * member, or in its own file, is ⊥ (propagated). `meanings` holds every
 * member's name under its current record (program-2 members on their previous
 * one, no name ⊥); a ⊥ name of an earlier component reads as moved.
 */
function predictBottom(
  p2: readonly string[],
  prevOf: (p: string) => WalkRecord | null,
  meanings: Meanings,
  directStale: ReadonlySet<string>,
  served: ReadonlyMap<string, string>,
  first: ReadonlySet<string>,
  files: ReadonlyMap<string, WalkFile>,
  second: ReadonlySet<string>,
): Set<string> {
  const inside = new Set(p2);
  const moved = (k: string, rec: WalkRecord, fromFresh: boolean): boolean => {
    const owner = splitKey(k)[0];
    const cur = meanings.of(k);
    if (cur === undefined || cur === null) return true;
    // A stored record was made against what its targets meant then: `depM`.
    if (!fromFresh) return rec.depM[k] !== cur;
    // A program-1 record was made against what program 1 was served. For a
    // program-2 owner that is its previous record (its newest variant) unless
    // the served contract was another: a name of it not ⊥ means then what it
    // meant. Any other owner served a contract it no longer has: moved.
    if (inside.has(owner) || second.has(owner)) {
      if (first.has(owner)) return false;
      const sv = served.get(owner);
      return sv !== undefined && files.get(owner)?.variants[0]?.contract !== sv;
    }
    return directStale.has(owner);
  };
  const bottom = new Set<string>();
  const rev = new Map<string, string[]>();
  const queue: string[] = [];
  const seed = (self: string): void => {
    if (bottom.has(self)) return;
    bottom.add(self);
    queue.push(self);
  };
  for (const p of p2) {
    const rec = prevOf(p);
    if (rec === null) continue;
    const fromFresh = first.has(p);
    for (const [n, nr] of Object.entries(rec.names)) {
      const self = nameKey(p, n);
      for (const k of [...nr.d, ...nr.i]) {
        const [o, tn] = splitKey(k);
        if (inside.has(o)) {
          // Into a program-2 member: ⊥ follows by propagation when the
          // target is one of its owner's own names; reached through a star,
          // or absent, it cannot be followed — moved.
          const ownerRec = prevOf(o);
          const followable =
            ownerRec !== null &&
            (tn === WHOLE || ownerRec.names[tn] !== undefined);
          if (!followable) {
            seed(self);
            continue;
          }
          const list = rev.get(k) ?? [];
          list.push(self);
          rev.set(k, list);
          if (o !== p && moved(k, rec, fromFresh)) seed(self);
        } else if (moved(k, rec, fromFresh)) seed(self);
      }
    }
  }
  while (queue.length > 0) {
    const k = queue.pop()!;
    const [p] = splitKey(k);
    for (const dep of [
      ...(rev.get(k) ?? []),
      ...(rev.get(nameKey(p, WHOLE)) ?? []),
    ]) {
      seed(dep);
    }
  }
  return bottom;
}

// ─── Phase 2: the final keys ────────────────────────────────────────────────

export interface FinalKeys {
  /** Each checked file's result key. */
  keys: Map<string, string>;
  /** Each checked file's `depM`: the meaning of every target outside it that it reaches. */
  depM: Map<string, Record<string, string>>;
  /** Any name key's final meaning (undefined: no such repo file was visited). */
  meaning(key: string): string | null | undefined;
}

/**
 * With every record known — `valid` variants, `fresh` records for the files
 * checked — the result key and `depM` of each checked file, to record.
 */
export function finalKeys(
  input: WalkInput,
  valid: ReadonlyMap<string, WalkVariant>,
  checked: ReadonlySet<string>,
): FinalKeys {
  const { files, global } = input;
  const meanings = new Meanings(input);
  const keys = new Map<string, string>();
  const depM = new Map<string, Record<string, string>>();
  const recOf = (p: string): WalkRecord => {
    const r = checked.has(p) ? files.get(p)!.fresh : valid.get(p);
    if (r === undefined) {
      throw new Error(
        `name-walk: ${p} has neither a fresh nor a valid record at the end of the run`,
      );
    }
    return r;
  };
  const comps = components(files, (p) => dTargets(recOf(p)));
  for (const members of comps) {
    meanings.assign(members, new Map(members.map((p) => [p, recOf(p)])));
    for (const p of members) {
      if (!checked.has(p)) continue;
      const r = fileKey(p, files, global, meanings);
      if (r === null) {
        throw new Error(
          `name-walk: ${p} has a use with no meaning at the end of the run`,
        );
      }
      keys.set(p, r);
      const rec = recOf(p);
      const out: Record<string, string> = {};
      const targets = new Set<string>(files.get(p)!.uses ?? []);
      for (const nr of Object.values(rec.names)) {
        for (const k of [...nr.d, ...nr.i]) targets.add(k);
      }
      for (const k of targets) {
        if (splitKey(k)[0] === p) continue;
        const v = meanings.of(k);
        if (v === undefined || v === null) {
          throw new Error(
            `name-walk: ${p} reaches ${k.replace("\0", "#")}, which has no meaning at the end of the run`,
          );
        }
        out[k] = v;
      }
      depM.set(p, out);
    }
  }
  return { keys, depM, meaning: (k) => meanings.of(k) };
}
