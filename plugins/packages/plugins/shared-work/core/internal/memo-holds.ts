/**
 * How long a shared memo keeps what it made: for as long as a unit still
 * running holds it, in a process whose units say when they end — forever
 * otherwise.
 *
 * A per-run memo (`sharedMemo`) is keyed by an object every unit of a run
 * shares — a check pass's file set — so a plain `WeakMap` holds each value
 * until the RUN ends, whether or not anything still reads it. A check pass is
 * a few hundred checks of very different lengths: the source analysis, the
 * codegen trees, the evaluated barrels and every mask stayed alive for minutes
 * after the last check reading them settled, while the type-check (the pass's
 * longest check) ran alone (~1 GB of live heap, ~2 GB resident, on an 8 GB
 * host with a 4–5 GB type-check batch beside it —
 * research/2026-11-19-global-check-pass-memory-release.md).
 *
 * So a process whose units end (the check runner) installs {@link MemoHolds}:
 * each unit runs under a holder of its own, every memo entry it reads is held
 * by that holder, and the holder lets go when the unit ends. An entry nobody
 * holds is the collector's; a later ask makes it again (from records that are
 * warm by then). Work a memo's producer reads from other memos is held by the
 * entry it produces, so an entry keeps everything it was made from for exactly
 * as long as it lives.
 *
 * A process that installs none (a build, a backend, a test) keeps every entry
 * for the life of its key, as before.
 */
export interface MemoHolder {
  /** Keep `entry` alive until this holder lets go of it. */
  hold(entry: object): void;
}

/** The holder an async context runs under, as its process tracks one. */
export interface MemoHolds {
  /**
   * The holder of the current async context: a running unit's, or the entry
   * whose producer is running. `undefined` outside any (code no unit runs):
   * an entry read there is held for the life of the process.
   */
  current(): MemoHolder | undefined;
  /** Run `fn` with `holder` current, its async continuations included. */
  run<T>(holder: MemoHolder, fn: () => T): T;
}

/**
 * One memo lifetime: the holds its process installed, and the memos that
 * follow them. The process has one (below); a test makes its own.
 */
export interface MemoLifetime {
  /**
   * Install how this process tracks holders — once, by the runner whose
   * units end (`checks/core`), before any unit runs. A second install
   * throws: two trackers would each see half the holds.
   */
  installMemoHolds(next: MemoHolds): void;
  /** A held memo keyed by objects (an entry dies with its key, as a `WeakMap`'s). */
  heldObjectMemo<K extends object, V>(): HeldMemo<K, V>;
  /** A held memo keyed by values (a path): a collected entry's key is dropped. */
  heldValueMemo<K, V>(): HeldMemo<K, V>;
}

/**
 * One memoized value and what keeps it: the key it was made for (so an entry
 * alive keeps its key, and with it its slot in a key-weak map), and the
 * entries its producer read (held by this one).
 */
interface Entry<V> {
  value: V;
  readonly key: unknown;
  readonly made: Set<object>;
}

/**
 * What a memo map keeps per key: the entry itself where nothing tracks
 * holders, a weak reference where something does — the entry then lives only
 * while a holder holds it.
 */
type Slot<V> = Entry<V> | WeakRef<Entry<V>>;

/** The backing map of a held memo: `Map` for value keys, `WeakMap` for objects. */
interface SlotMap<K, V> {
  get(key: K): Slot<V> | undefined;
  set(key: K, slot: Slot<V>): unknown;
  delete(key: K): unknown;
}

/**
 * A memo whose entries live while held ({@link MemoHolds}): `get` / `has`
 * answer a live entry (held by the asker from then on), `make` runs a
 * producer under the new entry's own holder and stores what it returned (a
 * producer that throws stores nothing).
 */
export interface HeldMemo<K, V> {
  get(key: K): V | undefined;
  has(key: K): boolean;
  make(key: K, produce: () => V, opts?: MakeOptions): V;
}

export interface MakeOptions {
  /**
   * Keep the entry for the life of the process, held or not: its producer
   * does something a second run must not repeat (a live slot-declaration
   * pass, which must run once per process).
   */
  forProcess?: boolean;
}

export function memoLifetime(): MemoLifetime {
  let holds: MemoHolds | undefined;
  // Entries kept for the life of the process: read where no holder is
  // current (as without holds), or made `forProcess`.
  const pinned = new Set<object>();
  // The entry that made each object value. A memo keyed by another memo's
  // value (the trees keyed by a codegen pass) holds the entry that made its
  // key, so while anything keyed by a value lives, the value is the one its
  // memo answers: let go, the next ask would make a new pass, and every memo
  // keyed by the old one would miss — made again, side effects and all.
  const madeBy = new WeakMap<object, object>();

  const holdHere = (entry: object): void => {
    if (holds === undefined) return;
    const holder = holds.current();
    if (holder !== undefined) holder.hold(entry);
    else pinned.add(entry);
  };
  const holdKeyMaker = (key: unknown, also?: Set<object>): void => {
    if (typeof key !== "object" || key === null) return;
    const maker = madeBy.get(key);
    if (maker === undefined) return;
    holdHere(maker);
    also?.add(maker);
  };

  function heldMemo<K, V>(
    slots: SlotMap<K, V>,
    dropOnCollect: boolean,
  ): HeldMemo<K, V> {
    // A value-keyed map keeps its key after the entry is collected; this
    // removes it then (unless a newer entry took the key).
    const collected = dropOnCollect
      ? new FinalizationRegistry<{ key: K; ref: WeakRef<Entry<V>> }>(
          ({ key, ref }) => {
            if (slots.get(key) === ref) slots.delete(key);
          },
        )
      : undefined;
    const live = (key: K): Entry<V> | undefined => {
      const slot = slots.get(key);
      const entry = slot instanceof WeakRef ? slot.deref() : slot;
      if (entry !== undefined) {
        holdHere(entry);
        holdKeyMaker(key);
      }
      return entry;
    };
    return {
      get: (key) => live(key)?.value,
      has: (key) => live(key) !== undefined,
      make(key, produce, opts) {
        const made = new Set<object>();
        const entry: Entry<V> = { key, made, value: undefined as V };
        holdHere(entry);
        holdKeyMaker(key, made);
        // Stored once the producer returned, as before holds: a producer that
        // throws leaves no entry, and the next ask runs it again.
        entry.value =
          holds === undefined
            ? produce()
            : holds.run({ hold: (e) => void made.add(e) }, produce);
        if (typeof entry.value === "object" && entry.value !== null)
          madeBy.set(entry.value, entry);
        if (holds === undefined || opts?.forProcess) {
          if (holds !== undefined) pinned.add(entry);
          slots.set(key, entry);
        } else {
          const ref = new WeakRef(entry);
          slots.set(key, ref);
          collected?.register(entry, { key, ref });
        }
        return entry.value;
      },
    };
  }

  return {
    installMemoHolds(next) {
      if (holds !== undefined)
        throw new Error("[shared-work] memo holds are already installed");
      holds = next;
    },
    heldObjectMemo: <K extends object, V>() =>
      heldMemo<K, V>(new WeakMap<K, Slot<V>>(), false),
    heldValueMemo: <K, V>() => heldMemo<K, V>(new Map<K, Slot<V>>(), true),
  };
}

const lifetime = memoLifetime();

/** {@link MemoLifetime.installMemoHolds}, for this process. */
export function installMemoHolds(next: MemoHolds): void {
  lifetime.installMemoHolds(next);
}

/** {@link MemoLifetime.heldObjectMemo}, under this process's holds. */
export function heldObjectMemo<K extends object, V>(): HeldMemo<K, V> {
  return lifetime.heldObjectMemo<K, V>();
}

/** {@link MemoLifetime.heldValueMemo}, under this process's holds. */
export function heldValueMemo<K, V>(): HeldMemo<K, V> {
  return lifetime.heldValueMemo<K, V>();
}
