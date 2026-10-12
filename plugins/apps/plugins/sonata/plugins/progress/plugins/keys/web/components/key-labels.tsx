import { collectKeyEntries } from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { Score } from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { ProgressLabel } from "@plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web";
import {
  changeAt,
  keyAt,
  keyChanges,
  longKeyName,
  shortKeyName,
} from "../key-names";
import { KEY_TONE } from "../key-tone";

/**
 * The keys' share of the label lane and the hover preview. The lane groups
 * labels by beat across contributors, so a key changing where a section starts
 * reads inside that section's label (`Answer G♯m`) and the starting key after
 * the first section's name (`Theme B`) — this plugin only says "this key, at
 * this beat".
 */

/** One short key name per key entry; the starting key muted and regular weight. */
export function keyLabels(score: Score): ProgressLabel[] {
  return collectKeyEntries(score).map((e, i) => ({
    beat: e.beat,
    key: `key-${e.beat}`,
    node:
      i === 0 ? (
        <span
          className="text-2xs font-normal text-muted-foreground"
          title={`Starting key: ${longKeyName(e.key)}`}
        >
          {shortKeyName(e.key)}
        </span>
      ) : (
        <span
          className={`text-2xs font-semibold ${KEY_TONE.label}`}
          title={`Key change → ${longKeyName(e.key)}`}
        >
          {shortKeyName(e.key)}
        </span>
      ),
  }));
}

/**
 * The hover preview's key line: "Key change → G♯ minor" on a change (the
 * preview snaps onto change beats, see `keyChangeBeats`), else the key in
 * force there, spelled out. A keyless song says nothing.
 */
export function describeKey(score: Score, beat: number) {
  const entries = collectKeyEntries(score);
  const change = changeAt(entries, beat);
  if (change) {
    return (
      <span className={KEY_TONE.text}>
        Key change → {longKeyName(change.key)}
      </span>
    );
  }
  const key = keyAt(entries, beat);
  return key ? <span>{longKeyName(key)}</span> : null;
}

/** The beats the hover preview snaps onto: every key change. */
export function keyChangeBeats(score: Score): number[] {
  return keyChanges(collectKeyEntries(score)).map((e) => e.beat);
}
