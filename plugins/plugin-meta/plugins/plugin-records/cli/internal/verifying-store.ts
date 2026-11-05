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
  const store: RecordStore = {
    environment: shared.environment,
    getMany: (table, keys) => own.getMany(table, keys),
    putMany(table, entries) {
      // A key this process already made is not compared twice.
      const known = own.getMany(
        table,
        entries.map(([k]) => k),
      );
      const fresh = entries.filter(([k]) => !known.has(k));
      own.putMany(table, fresh);
      const stored = shared.getMany(
        table,
        fresh.map(([k]) => k),
      );
      for (const [key, value] of fresh) {
        const s = stored.get(key);
        if (s === undefined) absent++;
        else if (s === value) agreed++;
        else disagreements.push({ table, key, stored: s, fresh: value });
      }
    },
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
