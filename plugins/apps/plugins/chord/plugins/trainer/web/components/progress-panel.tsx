import type { ReactNode } from "react";
import type { ChordToken } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import {
  MASTERY_WINDOW,
  TARGET_ACCURACY,
  TARGET_MEDIAN_MS,
  type ChordProgress,
  type MasteryStanding,
} from "@plugins/apps/plugins/chord/plugins/progress/core";
import { chordLabel } from "@plugins/apps/plugins/chord/plugins/vocabulary/core";
import {
  ChordNumeral,
  chordToneStyle,
} from "@plugins/apps/plugins/chord/plugins/vocabulary/web";
import { chordPaint } from "@plugins/music/plugins/chord-box/web";
import {
  catalogOrder,
  type Catalog,
  type Selection,
} from "@plugins/apps/plugins/chord/plugins/curriculum/core";
import {
  ChordsSection,
  type StandingLookup,
} from "@plugins/apps/plugins/chord/plugins/curriculum/web";
import {
  foldResource,
  matchResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  pct,
  placedClasses,
  placedStyle,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { desiredShare } from "../../core";

const checkIcon = symbol("check");

/**
 * The side panel: today's totals, a quieter all-time line, "Your chords" — one
 * line per listed chord that is on, in catalog order (track, section, share;
 * a chord only heard is dimmed and says so), and one Rare line when a chord
 * no track lists is on, standing for every rare chord answered, pooled (the
 * Rare button answers them all) — and the Chords section
 * (curriculum), which holds every practice control.
 *
 * "Your chords" is a plain component, not a DataView: it is a small fixed
 * status list (the chords on, a few dozen at most, in catalog order), not a
 * collection anyone searches, sorts or filters.
 */
export function ProgressPanel({
  progress,
  selection,
  catalog,
  listed,
}: {
  progress: ResourceResult<ChordProgress>;
  selection: Selection;
  catalog: Catalog;
  /** Whether a track lists a chord: the ones it does not are pooled as Rare. */
  listed: (token: ChordToken) => boolean;
}) {
  return (
    <Card className="rounded-2xl" aria-label="Your progress">
      <Stack gap="lg">
        {matchResource(progress, {
          loading: () => <Loading variant="rows" count={4} />,
          ready: (p) => (
            <PanelBody
              progress={p}
              selection={selection}
              catalog={catalog}
              listed={listed}
            />
          ),
        })}
        {/* Outside the progress gate: the section must never remount (it
            would lose its Undo) — the progress read is keyed on the catalog
            alone, so a chord change does not send it back to loading, but a
            catalog reload or a read failure must not take the section down. */}
        <ChordsSection
          selection={selection}
          catalog={catalog}
          standing={foldResource(progress, {
            loading: () => null,
            error: () => null,
            ready: standingLookup,
          })}
        />
      </Stack>
    </Card>
  );
}

function PanelBody({
  progress,
  selection,
  catalog,
  listed,
}: {
  progress: ChordProgress;
  selection: Selection;
  catalog: Catalog;
  listed: (token: ChordToken) => boolean;
}) {
  const { today, allTime } = progress;
  const byToken = new Map(progress.chords.map((c) => [c.token, c] as const));
  const order = new Map(catalogOrder(catalog).map((t, i) => [t, i] as const));
  const chords = selection.chords
    .filter((c) => listed(c.token))
    .sort(
      (a, b) =>
        (order.get(a.token) ?? Infinity) - (order.get(b.token) ?? Infinity),
    );
  const rare = selection.chords.filter((c) => !listed(c.token));
  const rarePractised = rare.some((c) => c.state === "practice");
  return (
    <Stack gap="lg">
      <Stack gap="sm">
        <Text variant="caption" tone="faint" className="font-semibold">
          Today
        </Text>
        <Grid cols={3} gap="sm">
          <Stat value={String(today.songs)} label="songs" />
          <Stat value={percent(today.correct, today.answers)} label="right" />
          <Stat
            value={
              today.answers === 0
                ? "–"
                : `${(today.totalMs / today.answers / 1000).toFixed(1)} s`
            }
            label="per chord"
          />
        </Grid>
        <Text variant="caption" tone="faint">
          All time: {allTime.songs} {allTime.songs === 1 ? "song" : "songs"},{" "}
          {percent(allTime.correct, allTime.answers)} right
        </Text>
      </Stack>
      <Stack gap="sm" className="border-t border-border pt-lg">
        <Text variant="caption" tone="faint" className="font-semibold">
          Your chords
        </Text>
        <Stack gap="none">
          {chords.map(({ token, state }) => (
            <ChordStandingLine
              key={token}
              chip={<ChordNumeral token={token} />}
              label={chordLabel(token).text}
              tone={token}
              heardOnly={state === "hear"}
              standing={byToken.get(token) ?? null}
            />
          ))}
          {rare.length > 0 && (
            <ChordStandingLine
              chip={<span className="chord-chip-word">Rare</span>}
              label={`Rare (${String(rare.length)} chord${rare.length === 1 ? "" : "s"} no track lists)`}
              tone={null}
              heardOnly={!rarePractised}
              standing={progress.rare}
            />
          )}
        </Stack>
      </Stack>
    </Stack>
  );
}

/**
 * Each practised chord as the Chords section draws it: its mastery and the
 * share of the loops it gets now. A chord the server did not list has never
 * been answered: new, at the new chord's share.
 */
function standingLookup(progress: ChordProgress): StandingLookup {
  const byToken = new Map(progress.chords.map((c) => [c.token, c] as const));
  return (key) => {
    const s = key === "rare" ? progress.rare : (byToken.get(key) ?? null);
    return {
      answers: s?.answers ?? 0,
      window: MASTERY_WINDOW,
      accuracy: s?.accuracy ?? null,
      mastered: s?.mastered ?? false,
      loopShare: desiredShare(s),
    };
  };
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <Stack gap="none">
      <Text variant="title" className="font-bold tabular-nums">
        {value}
      </Text>
      <Text variant="caption" tone="faint">
        {label}
      </Text>
    </Stack>
  );
}

/** `correct / answers` as a whole percentage, or "–" with no answers. */
function percent(correct: number, answers: number): string {
  return answers === 0
    ? "–"
    : `${String(Math.round((correct / answers) * 100))}%`;
}

/**
 * One chord: its chip, an accuracy meter marked at 90 %, the accuracy, the
 * usual answer time (red when over 2 s), and a check once it is mastered.
 * `standing` is null for a chord the server did not list (never answered).
 */
function ChordStandingLine({
  chip,
  label,
  tone,
  heardOnly,
  standing,
}: {
  /** What the chip shows: the chord's numeral, or the word Rare. */
  chip: ReactNode;
  label: string;
  /** The chord whose colour the line wears; null for the neutral Rare line. */
  tone: ChordToken | null;
  /** Played in loops but never asked: the line says so instead of scoring it. */
  heardOnly: boolean;
  standing: MasteryStanding | null;
}) {
  const answers = standing?.answers ?? 0;
  const accuracy = standing?.accuracy ?? null;
  const medianMs = standing?.medianMs ?? null;
  const mastered = standing?.mastered ?? false;
  const toneStyle = tone === null ? undefined : chordToneStyle(tone);
  if (heardOnly) {
    return (
      <Line
        // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip; move it onto its surface's header/footer or a Band
        className="chord-tone gap-xs border-b border-border py-xs last:border-b-0"
        style={toneStyle}
        data-heard-only=""
        title={`${label}: hear only — it plays in loops, always given`}
      >
        <Center
          className={cn(rigidClass(), "chord-chip w-11", chordPaint("tile"))}
        >
          {chip}
        </Center>
        <Fill>
          <Text variant="caption" tone="faint">
            hear only
          </Text>
        </Fill>
      </Line>
    );
  }
  const title =
    accuracy === null || medianMs === null
      ? `${label}: not heard yet`
      : `${label}: ${String(Math.round(accuracy * 100))}% right over your last ${String(answers)}, usually in ${(medianMs / 1000).toFixed(1)} s`;
  return (
    <Line
      // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip; move it onto its surface's header/footer or a Band
      className="chord-tone gap-xs border-b border-border py-xs last:border-b-0"
      style={toneStyle}
      title={title}
    >
      <Center
        className={cn(rigidClass(), "chord-chip w-11", chordPaint("tile"))}
      >
        {chip}
      </Center>
      <Fill className="relative">
        <Clip className="chord-meter relative w-full">
          <span
            className={cn(
              placedClasses({ decorative: true }),
              "chord-meter-fill",
            )}
            style={placedStyle({ start: 0, size: pct(accuracy ?? 0) }, "fill")}
          />
        </Clip>
        <span
          className={cn(
            placedClasses({ decorative: true }),
            "chord-meter-target",
          )}
          style={placedStyle(
            { start: pct(TARGET_ACCURACY) },
            { start: -4, end: -4 },
          )}
        />
      </Fill>
      <Text
        variant="caption"
        className={cn(
          rigidClass(),
          "chord-figure w-10 text-right font-semibold",
        )}
      >
        {accuracy === null ? "–" : `${String(Math.round(accuracy * 100))}%`}
      </Text>
      <Text
        variant="caption"
        tone="faint"
        className={cn(rigidClass(), "chord-figure w-10 text-right")}
        data-slow={
          medianMs !== null && medianMs > TARGET_MEDIAN_MS ? "" : undefined
        }
      >
        {medianMs === null ? "–" : `${(medianMs / 1000).toFixed(1)} s`}
      </Text>
      <Center
        className={cn(rigidClass(), "chord-mastery")}
        data-mastered={mastered ? "" : undefined}
        aria-label={mastered ? "Mastered" : "Not mastered yet"}
      >
        {mastered && <Icon icon={checkIcon} aria-hidden="true" />}
      </Center>
    </Line>
  );
}
