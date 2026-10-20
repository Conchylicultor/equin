import { useEffect, useState, type ReactNode } from "react";
import {
  LOOP_EXTRAS,
  chordTokenFromParts,
  type ChordToken,
  type LoopExtras,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { chordLabel } from "@plugins/apps/plugins/chord/plugins/vocabulary/core";
import {
  ChordNumeral,
  chordToneStyle,
} from "@plugins/apps/plugins/chord/plugins/vocabulary/web";
import {
  chordPaint,
  type ChordPaint,
} from "@plugins/music/plugins/chord-box/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { SectionHeaderRow } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  pct,
  placedClasses,
  placedStyle,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealClass,
  useHoverReveal,
} from "@plugins/primitives/plugins/hover-reveal/web";
import {
  legacyDraftKeys,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  BLANKS,
  BLANKS_LABEL,
  chordPlaces,
  chordState,
  groupState,
  sectionTokens,
  suggestedNext,
  trackStanding,
  type Blanks,
  type Catalog,
  type CatalogSection,
  type CatalogTrack,
  type ChordChange,
  type ChordState,
  type RareGroup,
  type Selection,
} from "../../core";
import { useCurriculumWrites } from "../internal/use-curriculum";
import "./chords.css";

const checkIcon = symbol("check");

/** How long the "from the next loop" note stays after a change. */
const APPLIED_MS = 1600;
/** How long Undo clear is offered after a Clear. */
const UNDO_MS = 6000;
/** Remembered folds last a year: they are a viewer's habit, not a draft. */
const FOLD_TTL = 365 * 24 * 60 * 60 * 1000;

const sectionOpenStore = defineStore({
  owner: "chord.chords-section-open",
  label: "Chord section folds",
  area: "local",
  cap: "1 KB",
  ttl: FOLD_TTL,
  whenFull: "refuse",
  schema: z.boolean(),
  legacy: legacyDraftKeys("chord.chords-section.open"),
});

const openTracksStore = defineStore({
  owner: "chord.chords-section-tracks",
  label: "Chord track folds",
  area: "local",
  cap: "2 KB",
  ttl: FOLD_TTL,
  whenFull: "refuse",
  schema: z.record(z.string(), z.boolean()),
  legacy: legacyDraftKeys("chord.chords-section.tracks"),
});

/** The swatch chord of the legend: V, in its blue. */
const LEGEND_TOKEN = chordTokenFromParts({
  root: 7,
  intervals: [4, 3],
  inversion: 0,
});

/**
 * How a chord chip is painted in each state (vocabulary's named paints): a
 * practised chord is the solid tile the trainer's boxes and "Your chords"
 * wear, a heard one the tint, an off one the ghost.
 */
const STATE_PAINT: Record<ChordState, ChordPaint> = {
  practice: "tile",
  hear: "tint",
  off: "ghost",
};
const STATE_LABEL: Record<ChordState, string> = {
  off: "Off",
  hear: "Hear",
  practice: "Practise",
};
const STATE_WORD: Record<ChordState | "mixed", string> = {
  off: "off",
  hear: "hearing",
  practice: "practising",
  mixed: "partly on",
};
/** A click moves a chord one step: off → hear → practise → off. */
const NEXT_STATE: Record<ChordState | "mixed", ChordState> = {
  off: "hear",
  hear: "practice",
  practice: "off",
  // A group partly on is completed, as a half-ticked box is ticked.
  mixed: "practice",
};
const BLANKS_HELP: Record<Blanks, string> = {
  all: "Name every practised chord",
  first: "Name every practised chord but the loop's first, given as an anchor",
  random: "Name half of them, drawn at random each loop",
  half: "Name the practised chords in the loop's second half, where the cadence is",
};
const EXTRAS_LABEL: Record<string, string> = {
  "0": "None",
  "1": "1",
  "2": "2",
  any: "Any",
};

/**
 * How a practised chord stands, as the section draws it. The trainer builds it
 * from `chord.progress` (the curriculum does not read progress: progress
 * depends on it).
 */
export type ChipStanding = {
  /** Answers in the mastery window, and the window's size. */
  answers: number;
  window: number;
  accuracy: number | null;
  mastered: boolean;
  /** About what share of the loops it gets now (0…1). */
  loopShare: number;
};

/** A practised chord's standing, or the practised rare chords' pooled one (`"rare"`). Null: not known (the progress is still loading). */
export type StandingLookup = (key: ChordToken | "rare") => ChipStanding | null;

/** How a practised chord stands, read off its mastery. */
type Learning =
  | { kind: "new" }
  | { kind: "learning"; standing: ChipStanding; progress: number }
  | { kind: "mastered"; standing: ChipStanding };

function learningOf(standing: ChipStanding | null): Learning {
  if (standing === null || standing.answers === 0) return { kind: "new" };
  if (standing.mastered) return { kind: "mastered", standing };
  return {
    kind: "learning",
    standing,
    progress:
      Math.min(1, standing.answers / standing.window) *
      (standing.accuracy ?? 0),
  };
}

/** What the footer explains: the chip or group under the pointer (or focus). */
type Hover =
  | {
      kind: "chord";
      token: ChordToken;
      /** What it reads as in its section ("V/V"), or null. */
      reading: string | null;
      track: CatalogTrack;
      section: CatalogSection;
      share: number;
    }
  | {
      kind: "group";
      track: CatalogTrack;
      section: CatalogSection;
      group: RareGroup;
    };

/** Everything a part of the section reads and writes. */
type Ctx = {
  selection: Selection;
  catalog: Catalog;
  standing: StandingLookup;
  /** Apply chord changes, flash "from the next loop", and drop a pending Undo. */
  apply: (changes: readonly ChordChange[]) => void;
  setHover: (hover: Hover | null) => void;
};

/**
 * The Chords section of the trainer's side panel: which chords the learner
 * practises, hears or leaves off, how much of a loop is blank, how many other
 * chords a loop may hold — and every chord of the song index to choose from,
 * in tracks and sections, most common first. Folded state is remembered per
 * viewer. Every change applies from the next loop: the round on screen is
 * never dealt again.
 *
 * No percentages or totals at rest: the footer gives a chip's exact numbers
 * while it is hovered (or focused), and a legend otherwise.
 */
export function ChordsSection({
  selection,
  catalog,
  standing,
}: {
  selection: Selection;
  catalog: Catalog;
  /**
   * How each practised chord stands (and the practised rare chords, pooled);
   * null while the progress loads — the chips then show no mastery mark and the
   * footer says the progress is loading. A prop rather than a gate around the
   * section, so a selection change (which re-keys the progress read) never
   * remounts it and loses its Undo or its open tracks.
   */
  standing: StandingLookup | null;
}) {
  const writes = useCurriculumWrites();
  const [open, setOpen] = useDraft(sectionOpenStore, true);
  const [hover, setHover] = useState<Hover | null>(null);
  const applied = useFlash(APPLIED_MS);
  const [undo, setUndo] = useState<Selection["chords"] | null>(null);
  useEffect(() => {
    if (undo === null) return;
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  const ctx: Ctx = {
    selection,
    catalog,
    standing: standing ?? (() => null),
    apply: (changes) => {
      if (changes.length === 0) return;
      setUndo(null);
      writes.setChords(changes, applied.show);
    },
    setHover,
  };

  const clear = () => {
    const snapshot = selection.chords;
    if (snapshot.length === 0) return;
    writes.setChords(
      snapshot.map((c) => ({ token: c.token, state: "off" as const })),
      () => {
        setUndo(snapshot);
        applied.show();
      },
    );
  };
  const undoClear = () => {
    if (undo === null) return;
    const kept = new Set(undo.map((c) => c.token));
    // Exactly the snapshot: chords turned on since the Clear go off again.
    const changes: ChordChange[] = [
      ...selection.chords
        .filter((c) => !kept.has(c.token))
        .map((c) => ({ token: c.token, state: "off" as const })),
      ...undo,
    ];
    setUndo(null);
    writes.setChords(changes, applied.show);
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-t border-border pt-md"
    >
      <SectionHeaderRow
        variant="value"
        actions={
          <Line className="gap-sm">
            <Text
              variant="caption"
              className="chord-applied"
              data-show={applied.on ? "" : undefined}
              aria-live="polite"
            >
              {applied.on ? "✓ from the next loop" : ""}
            </Text>
            {undo !== null ? (
              <button
                type="button"
                className="chord-clear"
                data-undo=""
                onClick={undoClear}
              >
                Undo clear
              </button>
            ) : (
              selection.chords.length > 0 && (
                <button type="button" className="chord-clear" onClick={clear}>
                  Clear
                </button>
              )
            )}
          </Line>
        }
      >
        Chords
      </SectionHeaderRow>
      <CollapsibleContent>
        <Stack gap="lg" className="pt-sm">
          <PillGroup<Blanks>
            label="Blanks"
            options={BLANKS.map((blanks) => ({
              id: blanks,
              label: BLANKS_LABEL[blanks],
              icon: <BlanksGlyph blanks={blanks} />,
              title: BLANKS_HELP[blanks],
            }))}
            value={selection.blanks}
            onChange={(blanks) => writes.setBlanks(blanks, applied.show)}
          />
          <PillGroup<LoopExtras>
            label="Other chords per loop"
            options={LOOP_EXTRAS.map((extras) => ({
              id: extras,
              label: EXTRAS_LABEL[String(extras)] ?? String(extras),
              title:
                extras === 0
                  ? "Only loops made of the chords you have on"
                  : extras === "any"
                    ? "Any loop holding a practised chord, whatever else it holds"
                    : `Loops may hold up to ${String(extras)} chord${extras === 1 ? "" : "s"} you have off — always given`,
            }))}
            value={selection.extras}
            onChange={(extras) => writes.setExtras(extras, applied.show)}
          />
          <Stack gap="none" className="border-t border-border">
            {catalog.tracks.map((track, index) => (
              <Track key={track.id} track={track} index={index} ctx={ctx} />
            ))}
          </Stack>
        </Stack>
        <Sticky edge="bottom" className="chord-foot border-t border-border">
          {hover === null ? (
            <Legend />
          ) : (
            <HoverDetail hover={hover} ctx={ctx} />
          )}
        </Sticky>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A flag that turns itself off `ms` after each `show`. */
function useFlash(ms: number): { on: boolean; show: () => void } {
  const [shown, setShown] = useState(0);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(timer);
  }, [on, shown, ms]);
  return {
    on,
    show: () => {
      setOn(true);
      setShown((n) => n + 1);
    },
  };
}

// ── Pills: Blanks, and Other chords per loop ────────────────────────────────

function PillGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string; icon?: ReactNode; title: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  // The segmented control keys its options by string; a count (Other chords
  // per loop) is read back through the options themselves.
  const byKey = new Map(options.map((o) => [String(o.id), o.id] as const));
  return (
    <Stack gap="xs">
      <Text variant="caption" tone="faint" className="font-semibold">
        {label}
      </Text>
      <SegmentedControl<string>
        label={label}
        options={options.map((o) => ({
          id: String(o.id),
          label: o.label,
          icon: o.icon,
          title: o.title,
        }))}
        value={String(value)}
        onChange={(key) => {
          const id = byKey.get(key);
          if (id === undefined) throw new Error(`no option "${key}"`);
          if (id !== value) onChange(id);
        }}
      />
    </Stack>
  );
}

/** A tiny loop of four boxes: hollow ones are blank, filled ones given. */
const GLYPH: Record<Blanks, readonly boolean[]> = {
  all: [true, true, true, true],
  first: [false, true, true, true],
  random: [false, true, false, true],
  half: [false, false, true, true],
};

function BlanksGlyph({ blanks }: { blanks: Blanks }) {
  return (
    <span className="chord-blanks-glyph" aria-hidden="true">
      {GLYPH[blanks].map((blank, i) => (
        <i key={i} data-blank={blank ? "" : undefined} />
      ))}
    </span>
  );
}

// ── Tracks ───────────────────────────────────────────────────────────────────

/**
 * How much of the track's chord use the learner has on: each listed chord
 * weighted by its windows, each rare group by the windows holding one of its
 * chords (half when only partly on).
 */
function trackCoverage(track: CatalogTrack, selection: Selection): number {
  let on = 0;
  let all = 0;
  for (const section of track.sections) {
    for (const chord of section.chords) {
      const weight = chord.share * section.windows;
      all += weight;
      if (chordState(selection, chord.token) !== "off") on += weight;
    }
    if (section.rare !== null) {
      const weight = section.rare.share * section.windows;
      all += weight;
      const state = groupState(selection, section.rare.tokens);
      if (state === "mixed") on += weight / 2;
      else if (state !== "off") on += weight;
    }
  }
  return all === 0 ? 0 : on / all;
}

function Track({
  track,
  index,
  ctx,
}: {
  track: CatalogTrack;
  index: number;
  ctx: Ctx;
}) {
  const [openTracks, setOpenTracks] = useDraft(openTracksStore, {
    major: true,
  });
  const open = openTracks[track.id] === true;
  const standing = trackStanding(track, ctx.selection);
  const next = suggestedNext(track, ctx.selection);
  const coverage = standing.started
    ? trackCoverage(track, ctx.selection)
    : null;
  return (
    <Collapsible
      open={open}
      onOpenChange={(o) => setOpenTracks((all) => ({ ...all, [track.id]: o }))}
      className="chord-track border-b border-border last:border-b-0"
    >
      <CollapsibleTrigger
        className="chord-track-head gap-sm"
        title={track.blurb}
      >
        <Center
          className={cn(rigidClass(), "chord-track-badge")}
          data-started={standing.started ? "" : undefined}
        >
          {index + 1}
        </Center>
        <Fill>
          <Text variant="body" className="font-semibold">
            {track.name}
          </Text>
        </Fill>
        <Text variant="caption" tone="faint" className={rigidClass()}>
          {standing.started ? (
            <>
              <b className="chord-stat">{standing.practised}</b> practised
              {standing.heard > 0 && (
                <>
                  {" · "}
                  <b className="chord-stat">{standing.heard}</b> heard
                </>
              )}
              {standing.rare > 0 && (
                <>
                  {" · "}
                  <b className="chord-stat">+{standing.rare}</b> rare
                </>
              )}
            </>
          ) : (
            "not started"
          )}
        </Text>
        <CollapsibleChevron className="text-faint-foreground" />
        {/* Inside the trigger, so the hover surface encloses it rather than
            the bar poking into the highlight's bottom edge from outside. */}
        {coverage !== null && (
          <Clip
            className="chord-track-cov"
            title={`The chords you have on make up ${String(Math.round(coverage * 100))}% of the chords played in ${track.name} loops`}
          >
            <span
              className={cn(
                placedClasses({ decorative: true }),
                "chord-track-cov-fill",
              )}
              style={placedStyle({ start: 0, size: pct(coverage) }, "fill")}
            />
          </Clip>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Stack gap="lg" className="chord-track-body" aria-label={track.name}>
          {track.sections.map((section) => (
            <Section
              key={section.id}
              track={track}
              section={section}
              next={next}
              ctx={ctx}
            />
          ))}
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Sections and their chips ─────────────────────────────────────────────────

function Section({
  track,
  section,
  next,
  ctx,
}: {
  track: CatalogTrack;
  section: CatalogSection;
  next: ChordToken | null;
  ctx: Ctx;
}) {
  const reveal = useHoverReveal();
  const all = sectionTokens(section);
  const whole = all.length > 0 ? groupState(ctx.selection, all) : "off";
  const on = section.chords.filter(
    (c) => chordState(ctx.selection, c.token) !== "off",
  ).length;
  const other = section.kind === "other";
  return (
    <Stack gap="xs" {...reveal.groupProps}>
      <Line className="gap-sm">
        <Text variant="eyebrow" tone="muted" className={yieldClass("x")}>
          {section.name}
        </Text>
        {section.chords.length > 0 && (
          <Text
            variant="caption"
            tone="faint"
            className={cn(rigidClass(), "tabular-nums")}
          >
            {on}/{section.chords.length}
          </Text>
        )}
        <Fill />
        {!other && (
          <span
            className={cn(
              rigidClass(),
              "chord-sec-set",
              hoverRevealClass(reveal.revealed),
            )}
            title="Set the whole section, rare chords included"
          >
            {(["off", "hear", "practice"] as const).map((state) => (
              <button
                key={state}
                type="button"
                aria-pressed={whole === state}
                aria-label={`${section.name}: ${state === "off" ? "None" : STATE_LABEL[state]}`}
                onClick={() =>
                  ctx.apply(all.map((token) => ({ token, state })))
                }
              >
                {state === "off" ? "None" : STATE_LABEL[state]}
              </button>
            ))}
          </span>
        )}
      </Line>
      <Stack direction="row" gap="xs" wrap align="start">
        {section.chords.map((chord) => (
          <ChordChip
            key={chord.token}
            token={chord.token}
            reading={chord.reading}
            suggested={chord.token === next}
            ctx={ctx}
            onHover={() =>
              ctx.setHover({
                kind: "chord",
                token: chord.token,
                reading: chord.reading,
                track,
                section,
                share: chord.share,
              })
            }
          />
        ))}
        {section.rare !== null && (
          <RareChip
            section={section}
            group={section.rare}
            ctx={ctx}
            onHover={() =>
              section.rare !== null &&
              ctx.setHover({
                kind: "group",
                track,
                section,
                group: section.rare,
              })
            }
          />
        )}
      </Stack>
    </Stack>
  );
}

function ChordChip({
  token,
  reading,
  suggested,
  ctx,
  onHover,
}: {
  token: ChordToken;
  reading: string | null;
  suggested: boolean;
  ctx: Ctx;
  onHover: () => void;
}) {
  const state = chordState(ctx.selection, token);
  const learning =
    state === "practice" ? learningOf(ctx.standing(token)) : null;
  return (
    <button
      type="button"
      className={cn("chord-pick relative", chordPaint(STATE_PAINT[state]))}
      style={chordToneStyle(token)}
      data-state={state}
      data-next={suggested ? "" : undefined}
      aria-label={[chordLabel(token).text, reading, STATE_LABEL[state]]
        .filter((part) => part !== null)
        .join(", ")}
      onClick={() => ctx.apply([{ token, state: NEXT_STATE[state] }])}
      onPointerEnter={onHover}
      onFocus={onHover}
      onPointerLeave={() => ctx.setHover(null)}
      onBlur={() => ctx.setHover(null)}
    >
      <ChordNumeral token={token} />
      {reading !== null && (
        <span className="chord-caption chord-pick-caption">{reading}</span>
      )}
      {learning?.kind === "mastered" && (
        <span
          className={cn(placedClasses({ decorative: true }), "chord-pick-ok")}
          style={placedStyle({ end: 4 }, { start: 2 })}
        >
          <Icon icon={checkIcon} />
        </span>
      )}
      {learning?.kind === "learning" && (
        <span
          className={cn(placedClasses({ decorative: true }), "chord-pick-m")}
          style={placedStyle({ start: 8, end: 8 }, { end: 4 })}
        >
          <span
            className={cn(
              placedClasses({ decorative: true }),
              "chord-pick-m-fill",
            )}
            style={placedStyle(
              { start: 0, size: pct(learning.progress) },
              "fill",
            )}
          />
        </span>
      )}
    </button>
  );
}

/** One chip for a section's rare chords (or a track's Other), cycling the whole group. */
function RareChip({
  section,
  group,
  ctx,
  onHover,
}: {
  section: CatalogSection;
  group: RareGroup;
  ctx: Ctx;
  onHover: () => void;
}) {
  const state = groupState(ctx.selection, group.tokens);
  const n = group.tokens.length;
  const other = section.kind === "other";
  const text = other
    ? `${n.toLocaleString()} other chord${n === 1 ? "" : "s"}`
    : `+${String(n)} rare`;
  return (
    <button
      type="button"
      className="chord-rare"
      data-state={state}
      aria-label={`${text} in ${section.name}, ${state === "mixed" ? "Mixed" : STATE_LABEL[state]}`}
      onClick={() =>
        ctx.apply(
          group.tokens.map((token) => ({ token, state: NEXT_STATE[state] })),
        )
      }
      onPointerEnter={onHover}
      onFocus={onHover}
      onPointerLeave={() => ctx.setHover(null)}
      onBlur={() => ctx.setHover(null)}
    >
      {text}
    </button>
  );
}

// ── The footer: a legend at rest, the exact numbers on hover ────────────────

function Legend() {
  return (
    <Stack
      direction="row"
      gap="sm"
      wrap
      align="center"
      className="chord-legend chord-tone"
      style={chordToneStyle(LEGEND_TOKEN)}
    >
      <span>
        <i className={chordPaint(STATE_PAINT.off)} /> off
      </span>
      <span>
        <i className={chordPaint(STATE_PAINT.hear)} /> hear
      </span>
      <span>
        <i className={chordPaint(STATE_PAINT.practice)} /> practise
      </span>
      <span>
        <i data-kind="next" /> next
      </span>
      <span>most common first · hover for details</span>
      <span>click a chord: off → hear → practise</span>
    </Stack>
  );
}

/** A share as people read it: whole above 10 %, one decimal below. */
function fmtShare(share: number): string {
  const p = share * 100;
  return `${p >= 10 ? String(Math.round(p)) : p.toFixed(1)}%`;
}

/** How common a share is, in a word. */
function tier(share: number): string {
  return share >= 0.05 ? "common" : share >= 0.01 ? "occasional" : "rare";
}

/** What a section's shares are counted over: its own mode when it has one, else its track. */
function scopeName(track: CatalogTrack, section: CatalogSection): string {
  return section.scope.join() === track.scope.join()
    ? track.name
    : section.name;
}

function masteryText(standing: ChipStanding | null): string {
  if (standing === null) return "progress loading…";
  const learning = learningOf(standing);
  const state =
    learning.kind === "new"
      ? "new"
      : learning.kind === "mastered"
        ? "mastered"
        : `learning ${String(learning.standing.answers)}/${String(learning.standing.window)} · ${String(Math.round((learning.standing.accuracy ?? 0) * 100))}%`;
  return `${state} · ~${String(Math.round(standing.loopShare * 100))}% of your loops`;
}

function HoverDetail({ hover, ctx }: { hover: Hover; ctx: Ctx }) {
  const scope = scopeName(hover.track, hover.section);
  if (hover.kind === "group") {
    const { group, section } = hover;
    const state = groupState(ctx.selection, group.tokens);
    const other = section.kind === "other";
    const n = group.tokens.length;
    const examples = group.tokens
      .slice(0, 3)
      .map((token) => chordLabel(token).text)
      .join(", ");
    const line2 = [
      `together in ${fmtShare(group.share)} of ${scope} loops`,
      state === "practice"
        ? masteryText(ctx.standing("rare"))
        : state === "hear"
          ? "plays filled in, never asked"
          : null,
      other ? null : `${examples}${n > 3 ? "…" : ""}`,
    ]
      .filter((part) => part !== null)
      .join(" · ");
    return (
      <FootRow
        big={
          <span className="chord-foot-word">
            {other ? "Other" : `+${String(n)}`}
          </span>
        }
        line1={
          <>
            <b>
              {other
                ? `${n.toLocaleString()} chords no rule names yet`
                : `${String(n)} rare · ${section.name}`}
            </b>
            {` · ${STATE_WORD[state]} as a group · the Rare button answers them`}
          </>
        }
        line2={line2}
      />
    );
  }
  const { token, reading, track, share } = hover;
  const state = chordState(ctx.selection, token);
  const others = [
    ...new Set(
      chordPlaces(ctx.catalog, token)
        .filter((place) => place.listed && place.trackId !== track.id)
        .map(
          (place) =>
            ctx.catalog.tracks.find((t) => t.id === place.trackId)?.name ??
            place.trackId,
        ),
    ),
  ];
  const line2 = [
    `in ${fmtShare(share)} of ${scope} loops (${tier(share)})`,
    state === "practice"
      ? masteryText(ctx.standing(token))
      : state === "hear"
        ? "plays filled in, never asked"
        : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <FootRow
      tone={token}
      big={<ChordNumeral token={token} />}
      line1={
        <>
          <b>
            {state === "practice"
              ? "Practising"
              : state === "hear"
                ? "Hearing"
                : "Off"}
          </b>
          {reading !== null && ` · ${reading}`}
          {others.length > 0 && ` · also in ${others.join(", ")}`}
        </>
      }
      line2={line2}
    />
  );
}

function FootRow({
  tone,
  big,
  line1,
  line2,
}: {
  tone?: ChordToken;
  big: ReactNode;
  line1: ReactNode;
  line2: string;
}) {
  return (
    <Line
      className={cn("gap-md", tone !== undefined && "chord-tone")}
      style={tone === undefined ? undefined : chordToneStyle(tone)}
    >
      <Center className={cn(rigidClass(), "chord-foot-big")}>{big}</Center>
      <Fill>
        <Stack gap="2xs">
          <Line>
            <Text variant="caption" tone="muted">
              {line1}
            </Text>
          </Line>
          <Line>
            <Text variant="caption" tone="muted">
              {line2}
            </Text>
          </Line>
        </Stack>
      </Fill>
    </Line>
  );
}
