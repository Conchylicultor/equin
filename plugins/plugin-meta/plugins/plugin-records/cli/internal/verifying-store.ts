import {
  createMemoryRecordStore,
  type RecordStore,
  type RecordTable,
} from "../../core";

/** A record whose fresh value is not the one the shared store holds under its key. */
export interface RecordDisagreement {
  table: RecordTable;
  key: string;
  stored: string;
  fresh: string;
}

export interface RecordVerification {
  /** Install this: every record is computed again, and checked against `shared`. */
  readonly store: RecordStore;
  /** Fresh records the shared store also held: equal, or disagreeing. */
  readonly agreed: number;
  /** Fresh records the shared store did not hold (nothing to compare). */
  readonly absent: number;
  readonly disagreements: readonly RecordDisagreement[];
  /**
   * Resolves once every fresh record put so far was compared (a comparison
   * reads the shared store, which is async). Await it before reading the
   * counts.
   */
  settled(): Promise<void>;
}

/**
 * The verifier's store. A key is the hash of every input its value is a
 * function of, so a record computed again under the same key must come out
 * byte-identical; one that does not names a key that missed an input (or a
 * producer that is not deterministic). This store answers reads only from what
 * its own process computed — so every record is computed again — and compares
 * each fresh value with the shared store's under the same key. It writes no
 * record to the shared store (its reads refresh the rows' last-read day, as any
 * reader's do): verifying is not a cache bypass, and a fresh value is not more
 * right than a stored one until someone has read why they differ.
 */
export function verifyRecordsAgainst(shared: RecordStore): RecordVerification {
  const own = createMemoryRecordStore(shared.environment);
  let agreed = 0;
  let absent = 0;
  const disagreements: RecordDisagreement[] = [];
  // Keys this process already made, per table: one is not compared twice.
  const made = new Map<RecordTable, Set<string>>();
  // Each comparison settled to its error (or null) the moment it is made, so
  // one that fails mid-pass is held for `settled()` to throw, never left an
  // unhandled rejection that kills the pass before its verdict.
  const comparisons: Promise<unknown>[] = [];
  const compare = async (
    table: RecordTable,
    fresh: ReadonlyArray<readonly [string, string]>,
  ): Promise<void> => {
    const stored = await shared.getMany(
      table,
      fresh.map(([k]) => k),
    );
    for (const [key, value] of fresh) {
      const s = stored.get(key);
      if (s === undefined) absent++;
      else if (s === value) agreed++;
      else disagreements.push({ table, key, stored: s, fresh: value });
    }
  };
  const store: RecordStore = {
    environment: shared.environment,
    getMany: (table, keys) => own.getMany(table, keys),
    putMany(table, entries) {
      let seen = made.get(table);
      if (!seen) made.set(table, (seen = new Set()));
      const fresh = entries.filter(([k]) => !seen.has(k));
      for (const [k] of fresh) seen.add(k);
      own.putMany(table, fresh);
      if (fresh.length > 0)
        comparisons.push(
          compare(table, fresh).then(
            () => null,
            (err: unknown) => err,
          ),
        );
    },
    // Writes nothing to the shared store, so holds nothing back.
    flush() {},
  };
  return {
    store,
    get agreed() {
      return agreed;
    },
    get absent() {
      return absent;
    },
    disagreements,
    async settled() {
      // A comparison settled meanwhile may have been joined by more puts.
      for (let n = 0; n < comparisons.length; n = comparisons.length)
        for (const err of await Promise.all(comparisons.slice(n)))
          if (err !== null) throw err;
    },
  };
}

/**
 * Did the verification pass? Only when it compared something and nothing
 * disagreed: a run that found no stored record to compare (an empty store, a
 * pass that read no record) verified nothing, and says so by failing.
 */
export function verificationPassed(v: RecordVerification): boolean {
  return v.agreed > 0 && v.disagreements.length === 0;
}

/** The verdict, as lines a person reads: each disagreement with where the two values first differ. */
export function describeVerification(v: RecordVerification): string[] {
  const lines = [
    `plugin records: ${v.agreed} agree with the shared store, ${v.disagreements.length} disagree, ${v.absent} not stored yet`,
  ];
  if (v.agreed === 0)
    lines.push(
      "  ✗ no record was compared: nothing was verified (an empty store, or a pass that read no record)",
    );
  for (const d of v.disagreements) {
    let i = 0;
    while (i < d.stored.length && d.stored[i] === d.fresh[i]) i++;
    const at = (s: string): string =>
      JSON.stringify(s.slice(Math.max(0, i - 80), i + 160));
    lines.push(
      `  ✗ ${d.table} ${d.key}: differs at char ${i}`,
      `      stored: …${at(d.stored)}…`,
      `      fresh:  …${at(d.fresh)}…`,
    );
  }
  return lines;
}
