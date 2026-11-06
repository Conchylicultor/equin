// The memory of a fork tree that shares a large segment — the Postgres cluster:
// a postmaster and the backends it forked — with every page counted once.
//
// A process's physical footprint charges it for every page of shared memory it
// has mapped, so summing the tree's footprints counts the cluster's shared
// segment (shared_buffers and the rest, ~210–260 MB) once per backend that
// touched it: 11.7 GB summed against 3.1 GB real (2026-11-06, Apple's
// `footprint -p postgres`, which counts shared pages once). Here each process
// is charged its PRIVATE pages (resident + compressed, of its copy-on-write and
// private regions), and the root also every writable shared object of the tree
// once (by VM object id, resident + compressed): the segment it created, the
// copy-on-write pages its children still share with it, and the dynamic
// segments a backend maps. Same minute: 3,058 MB here vs 3,102 MB `footprint`.
//
// The kernel counts a region's pages one by one, so the walk is O(the tree's
// address space). Two things keep it near O(what changed):
//
// - **The root is the template.** A child is a fork of the root, so the ranges
//   it inherited sit at the same addresses: the root's shared-inherited
//   segment (counted once from the root) and its read-only mappings (text, the
//   dyld shared cache — a child cannot dirty them without making them writable)
//   are stepped over in every child. Measured: 2.2× fewer µs, 99.3 % of the
//   private pages kept (what is lost: a few compressed pages of read-only
//   ranges).
// - **A child whose footprint and start did not move is not walked again**: a
//   footprint is private + mapped shared, so a backend that allocated, freed or
//   touched anything moved it. Measured: about half the backends change in
//   30 s (7–102 new, 39–81 changed of ~210–310).

/** proc_regioninfo's share modes (mach/vm_region.h SM_*). */
const SM_COW = 1;
const SM_PRIVATE = 2;
const SM_SHARED = 4;
const SM_TRUESHARED = 5;
const SM_PRIVATE_ALIASED = 6;
const SM_SHARED_ALIASED = 7;
const PRIVATE_MODES = new Set([SM_COW, SM_PRIVATE, SM_PRIVATE_ALIASED]);
const SHARED_MODES = new Set([SM_SHARED, SM_TRUESHARED, SM_SHARED_ALIASED]);
/** VM_INHERIT_SHARE: a MAP_SHARED mapping, the same pages in parent and child. */
const INHERIT_SHARE = 0;
const VM_PROT_WRITE = 2;

/** One VM region, as proc_pidinfo(PROC_PIDREGIONINFO) describes it. */
export interface Region {
  start: number;
  end: number;
  protection: number;
  inheritance: number;
  shareMode: number;
  residentPages: number;
  swappedPages: number;
  privateResidentPages: number;
  /** The VM object's id: equal across processes mapping the same object. */
  objectId: number;
}

/** The region of `pid` at or after `address`; null past the last one, or when refused. */
export type RegionReader = (pid: number, address: number) => Region | null;

/** What identifies one incarnation of a process and how much it holds. */
export interface ProcessStamp {
  /** Start time, any unit: a reused pid reads a different one. */
  startedAt: number;
  footprintBytes: number;
}

/** A fork tree: its root (the postmaster) and every process under it. */
export interface ForkTree {
  root: number;
  members: readonly number[];
}

interface Walk {
  privatePages: number;
  /** Writable shared objects it maps: id → pages (resident + compressed). */
  sharedObjects: Map<number, number>;
}

interface Measured {
  stamp: ProcessStamp;
  walk: Walk;
}

/**
 * A range a fork inherits at the same address and cannot hold private pages
 * in: the parent's shared-inherited segment (counted once, from the parent),
 * or a read-only mapping. Protection 0 is a reservation a child may map into,
 * so it is never one.
 */
function inheritedUnwritable(r: Region): boolean {
  const sharedSegment =
    r.inheritance === INHERIT_SHARE && SHARED_MODES.has(r.shareMode);
  const readOnly = r.protection !== 0 && (r.protection & VM_PROT_WRITE) === 0;
  return sharedSegment || readOnly;
}

export interface ForkTreeMeter {
  /**
   * Each process's memory, bytes, the tree's shared objects charged once to
   * its root; a process gone (or refused) before it was read is absent.
   */
  measure(trees: readonly ForkTree[]): Map<number, number>;
}

export function createForkTreeMeter(opts: {
  readRegion: RegionReader;
  /** The process's stamp, or null when gone or refused. */
  readStamp: (pid: number) => ProcessStamp | null;
  pageBytes: number;
}): ForkTreeMeter {
  const { readRegion, readStamp, pageBytes } = opts;
  const measured = new Map<number, Measured>();

  /**
   * Every region of `pid` but the `skip` ranges (start → end); into
   * `template`, when given, the ranges a fork of `pid` inherits and cannot
   * hold private pages in.
   */
  function walk(
    pid: number,
    skip: ReadonlyMap<number, number>,
    template?: Map<number, number>,
  ): Walk | null {
    const out: Walk = { privatePages: 0, sharedObjects: new Map() };
    let address = 0;
    let read = 0;
    for (;;) {
      const skipTo = skip.get(address);
      if (skipTo !== undefined) {
        address = skipTo;
        continue;
      }
      const r = readRegion(pid, address);
      if (r === null) break;
      read++;
      address = r.end;
      // A gap before a skipped range: the read returned that range itself.
      if (skip.has(r.start)) continue;
      if (template && inheritedUnwritable(r)) template.set(r.start, r.end);
      if (PRIVATE_MODES.has(r.shareMode)) {
        out.privatePages += r.privateResidentPages + r.swappedPages;
      } else if (
        SHARED_MODES.has(r.shareMode) &&
        (r.protection & VM_PROT_WRITE) !== 0
      ) {
        const pages = r.residentPages + r.swappedPages;
        const seen = out.sharedObjects.get(r.objectId) ?? 0;
        if (pages > seen) out.sharedObjects.set(r.objectId, pages);
      }
    }
    return read === 0 ? null : out;
  }

  /** `pid` walked now, or its last walk when its stamp did not move. */
  function measureOne(
    pid: number,
    skip: ReadonlyMap<number, number>,
  ): Walk | null {
    const stamp = readStamp(pid);
    if (stamp === null) return null;
    const last = measured.get(pid);
    if (
      last !== undefined &&
      last.stamp.startedAt === stamp.startedAt &&
      last.stamp.footprintBytes === stamp.footprintBytes
    ) {
      return last.walk;
    }
    const w = walk(pid, skip);
    // Gone mid-walk: its partial map is not its memory.
    if (w === null || readStamp(pid) === null) return null;
    measured.set(pid, { stamp, walk: w });
    return w;
  }

  return {
    measure(trees) {
      const out = new Map<number, number>();
      const live = new Set<number>();
      for (const tree of trees) {
        // The root is walked whole every time: it is the template, and it
        // holds the objects the tree shares.
        const skip = new Map<number, number>();
        const rootWalk = walk(tree.root, new Map(), skip);
        if (rootWalk === null) continue;
        const shared = new Map(rootWalk.sharedObjects);
        for (const pid of tree.members) {
          if (pid === tree.root) continue;
          const w = measureOne(pid, skip);
          if (w === null) continue;
          live.add(pid);
          out.set(pid, w.privatePages * pageBytes);
          for (const [id, pages] of w.sharedObjects) {
            if (pages > (shared.get(id) ?? 0)) shared.set(id, pages);
          }
        }
        let sharedPages = 0;
        for (const pages of shared.values()) sharedPages += pages;
        out.set(tree.root, (rootWalk.privatePages + sharedPages) * pageBytes);
      }
      for (const pid of measured.keys()) {
        if (!live.has(pid)) measured.delete(pid);
      }
      return out;
    },
  };
}
