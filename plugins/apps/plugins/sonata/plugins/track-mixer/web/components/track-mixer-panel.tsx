import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMemo, useState } from "react";

import { useLibrarySong } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { SonataAudio } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  FloatingAction,
  FloatingActionFadeIn,
} from "@plugins/primitives/plugins/overlay/plugins/floating-action/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { Slider } from "@plugins/primitives/plugins/css/plugins/slider/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import {
  SectionLabel,
  Text,
  textVariantClass,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  insetClass,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  SearchInput,
  useTextFilter,
} from "@plugins/primitives/plugins/search/web";
import { SwatchGrid } from "@plugins/primitives/plugins/css/plugins/color-picker/web";
import {
  setTrackColor,
  setTrackHidden,
  setTrackInstrument,
  setTrackMuted,
} from "../actions";
import { useTrackMixerEntries, type TrackMixerEntry } from "../hooks";
import { useTrackFader } from "../use-track-fader";
import { TRACK_PALETTE, accidentalColor } from "../palette";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const autoModeIcon = symbol("auto-mode");
const checkIcon = symbol("check");
const keyboardArrowDownIcon = symbol("keyboard-arrow-down");
const visibilityIcon = symbol("visibility");
const visibilityOffIcon = symbol("visibility-off");
const volumeDownIcon = symbol("volume-down");
const volumeMuteIcon = symbol("volume-mute");
const volumeOffIcon = symbol("volume-off");
const volumeUpIcon = symbol("volume-up");

/** The instrument-contribution metadata the picker reads (never `createVoices`). */
interface InstrumentOption {
  id: string;
  label: string;
  icon?: IconRef;
  group?: string;
}

/**
 * Round swatch that opens a categorical palette picker for one track. A soft
 * halo of its own colour rings it, so the swatch reads as the track's colour
 * rather than a dot on the surface. The colour is track data (an explicit hex
 * from the palette or the user's pick), not a theme token — hence inline.
 */
function ColorSwatch({
  songId,
  trackId,
  color,
  dimmed,
}: {
  songId: string;
  trackId: string;
  color: string;
  /** A hidden track's swatch fades with its name. */
  dimmed: boolean;
}) {
  return (
    <InlinePopover
      tooltip="Track color"
      width="content"
      padding="sm"
      trigger={
        <button
          type="button"
          aria-label="Track color"
          className={cn(
            "size-3.5 rounded-full transition-transform hover:scale-110",
            rigidClass(),
            dimmed && "opacity-50",
          )}
          style={{
            background: accidentalColor(color),
            boxShadow: `0 0 0 3px color-mix(in oklab, ${accidentalColor(color)} 20%, transparent)`,
          }}
        />
      }
    >
      <SwatchGrid
        colors={[...TRACK_PALETTE]}
        value={color}
        renderColor={accidentalColor}
        onChange={(c) => setTrackColor(songId, trackId, c)}
      />
    </InlinePopover>
  );
}

/**
 * Functional per-track instrument picker. The trigger shows the resolved
 * instrument's label (+ icon); the popover offers a searchable list of every
 * registered timbre grouped by its `group`, plus a "Reset to auto" entry that
 * clears the override back to the GM-derived / default timbre. Selecting writes
 * the override (or clears it) and closes the popover. Active option is checked.
 */
function InstrumentPicker({
  songId,
  trackId,
  options,
  resolvedId,
  resolvedLabel,
  instrumentCustomized,
}: {
  songId: string;
  trackId: string;
  options: InstrumentOption[];
  resolvedId: string;
  resolvedLabel: string;
  /**
   * Whether the timbre was chosen by hand. Deliberately NOT the entry's
   * `customized`, which means "any override at all": a row exists as soon as
   * the track is muted or its fader moved, so reading that here would make the
   * picker stop offering "Auto" and tick the merely-resolved instrument as if
   * the user had picked it.
   */
  instrumentCustomized: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { query, setQuery, filtered } = useTextFilter({
    items: options,
    accessor: (o) => `${o.label} ${o.group ?? ""}`,
  });

  // Group the (filtered) options by their `group` label, preserving the
  // contribution order both within and across groups.
  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, InstrumentOption[]>();
    for (const o of filtered) {
      const g = o.group ?? "Other";
      if (!byGroup.has(g)) {
        byGroup.set(g, []);
        order.push(g);
      }
      byGroup.get(g)!.push(o);
    }
    return order.map((g) => ({ group: g, options: byGroup.get(g)! }));
  }, [filtered]);

  const ResolvedIcon = options.find((o) => o.id === resolvedId)?.icon;

  const select = (id: string | null) => {
    setTrackInstrument(songId, trackId, id);
    setOpen(false);
  };

  return (
    <InlinePopover
      resetOnClose
      open={open}
      onOpenChange={setOpen}
      tooltip="Track instrument"
      width="sm"
      padding="sm"
      trigger={
        <Line
          as="button"
          type="button"
          aria-label="Track instrument"
          className={cn(
            yieldClass("x"),
            textVariantClass("caption"),
            // A chip: the hover fill marks it as the picker it is.
            "gap-xs rounded-sm px-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          )}
        >
          {ResolvedIcon ? (
            <Icon icon={ResolvedIcon} className={cn("size-3", rigidClass())} />
          ) : null}
          <span className="truncate">{resolvedLabel}</span>
          <Icon
            icon={keyboardArrowDownIcon}
            className={cn("size-3", rigidClass())}
          />
        </Line>
      }
    >
      <SearchInput
        autoFocus
        placeholder="Search instruments…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mt offsets the scroll list below the search input (no named margin utility) */}
      <Scroll className="mt-2 max-h-64">
        {/* Reset-to-auto: clears the override so resolution falls back to the
            track's GM program / the default timbre. Active when no override. */}
        <Row
          size="sm"
          selected={!instrumentCustomized}
          icon={<Icon icon={autoModeIcon} />}
          actions={
            !instrumentCustomized ? (
              <Icon icon={checkIcon} className="size-3.5 text-primary-text" />
            ) : undefined
          }
          actionsAlwaysVisible
          onClick={() => select(null)}
        >
          <span className="truncate">Auto</span>
        </Row>

        {groups.map(({ group, options: groupOptions }) => (
          // eslint-disable-next-line spacing/no-adhoc-spacing -- mt separates each instrument group header from the prior group (no named margin utility)
          <div key={group} className="mt-1">
            <SectionLabel className="px-sm py-xs">{group}</SectionLabel>
            {/* eslint-disable-next-line data-view/no-adhoc-row-list -- mixer channel strips (bespoke instrument UI) */}
            {groupOptions.map((o) => {
              const icon = o.icon;
              const active = instrumentCustomized && o.id === resolvedId;
              return (
                <Row
                  key={o.id}
                  size="sm"
                  selected={active}
                  icon={
                    icon ? (
                      <Icon icon={icon} className="size-3.5" />
                    ) : (
                      <span className="size-3.5" />
                    )
                  }
                  actions={
                    active ? (
                      <Icon
                        icon={checkIcon}
                        className="size-3.5 text-primary-text"
                      />
                    ) : undefined
                  }
                  actionsAlwaysVisible
                  onClick={() => select(o.id)}
                >
                  <span className="truncate">{o.label}</span>
                </Row>
              );
            })}
          </div>
        ))}
      </Scroll>
    </InlinePopover>
  );
}

/**
 * Which speaker the trigger shows. The icon reports the LEVEL, not just the
 * mute flag: a track dragged all the way down is silent, and showing it the
 * same "audible" speaker as a track at unity is the icon lying about what you
 * will hear. Mute keeps its own destructive-tinted glyph because it is a
 * different thing — it removes the track's notes upstream, rather than being a
 * fader position — and it is what a click on this button toggles.
 */
function levelIcon(muted: boolean, volume: number): IconRef {
  if (muted) return volumeOffIcon;
  if (volume === 0) return volumeMuteIcon;
  return volume < 1 ? volumeDownIcon : volumeUpIcon;
}

/**
 * The track's level control: a speaker button that expands leftwards into a
 * fader on hover / focus / tap, with no extra click.
 *
 * The whole thing is one `FloatingAction` — the primitive for exactly this
 * disclosure (grace delay on close, no re-entry dead zone, a stable hitbox that
 * cures open/close flicker), with the speaker as its required `trigger` so the
 * collapsed footprint can never shrink away next to the revealed fader.
 *
 * Clicking the speaker still mutes. The primitive marks the panel `inert` while
 * closed, but the pointer-enter that opens it is delivered to the always-live
 * wrapper underneath and lands before the press, so by the time the click
 * arrives the button is live again — the disclosure never swallows it.
 */
function TrackLevel({
  songId,
  trackId,
  name,
  muted,
  volume,
}: {
  songId: string;
  trackId: string;
  name: string;
  muted: boolean;
  volume: number;
}) {
  const fader = useTrackFader(songId, trackId, volume);
  const percent = Math.round(fader.value * 100);

  return (
    <FloatingAction
      // The wrapper reserves the collapsed footprint in the row, so it must be
      // EXACTLY the neighbouring hide button's box — hence the density var
      // rather than a hardcoded `size-6`, which would drift out of alignment
      // the moment the user picked a different density preset.
      className="relative size-(--control-height-sm) z-popover"
      variant="ghost"
      direction="row"
      // Speaker pinned at the right where the mute button already was; the
      // fader is revealed leftwards, over the track name.
      triggerAt="end"
      anchor="top-right"
      align="center"
      gap="xs"
      // No `pad`: padding on the panel would widen the collapsed box past the
      // trigger and break the row alignment above. The revealed content carries
      // its own breathing room from the panel's left edge instead.
      panelClassName={cn(
        "max-w-(--control-height-sm) group-data-open/fa:max-w-48",
        // Opened, the fader floats over the track name: lift it onto the
        // popover surface so it reads as a panel above the row.
        "group-data-open/fa:bg-popover group-data-open/fa:shadow-lg",
      )}
      trigger={
        <IconButton
          icon={levelIcon(muted, fader.value)}
          label={muted ? "Unmute track" : "Mute track"}
          aria-pressed={muted}
          className={cn(muted && "text-destructive")}
          onClick={() => setTrackMuted(songId, trackId, !muted)}
        />
      }
    >
      {/* Rigid, so the collapsed panel REVEALS the fader by clipping it rather
          than squashing it: without this the flex row would shrink the slider
          to nothing under the clamp, and the morph would read as a control
          being stretched into existence instead of slid out from behind the
          speaker. */}
      <FloatingActionFadeIn
        className={cn(rigidClass(), insetClass({ l: "xs" }))}
      >
        <Stack direction="row" gap="xs" align="center">
          {/* Fixed width + tabular figures: the readout runs 0% to 200%, and
              letting it size itself would shove the fader sideways as you
              drag it. */}
          <Text
            as="span"
            variant="caption"
            tone="muted"
            className="w-10 whitespace-nowrap tabular-nums text-right"
          >
            {percent}%
          </Text>
          <Slider
            value={fader.value}
            min={0}
            max={2}
            step={0.01}
            // Unity gets a tick and a magnet, so "back to how it was recorded"
            // stays findable on a fader that travels past it.
            detent={1}
            onValueChange={fader.onValueChange}
            aria-label={`Volume for ${name}`}
            className="w-24"
          />
        </Stack>
      </FloatingActionFadeIn>
    </FloatingAction>
  );
}

function TrackRow({
  songId,
  options,
  entry,
}: {
  songId: string;
  options: InstrumentOption[];
  entry: TrackMixerEntry;
}) {
  const {
    trackId,
    name,
    noteCount,
    color,
    muted,
    hidden,
    volume,
    instrumentId,
    instrumentLabel,
    instrumentCustomized,
  } = entry;
  return (
    <Stack direction="row" gap="sm" align="center" className="py-sm">
      <ColorSwatch
        songId={songId}
        trackId={trackId}
        color={color}
        dimmed={hidden}
      />

      <Fill className={cn(hidden && "opacity-50")}>
        <Text
          as="div"
          variant="body"
          className="truncate font-semibold text-foreground"
        >
          {name}
        </Text>
        <Stack
          direction="row"
          align="center"
          gap="xs"
          className="text-muted-foreground"
        >
          <InstrumentPicker
            songId={songId}
            trackId={trackId}
            options={options}
            resolvedId={instrumentId}
            resolvedLabel={instrumentLabel}
            instrumentCustomized={instrumentCustomized}
          />
          <Text
            as="span"
            variant="caption"
            tone="muted"
            className="whitespace-nowrap"
          >
            · {noteCount.toLocaleString("en-US")}{" "}
            {noteCount === 1 ? "note" : "notes"}
          </Text>
        </Stack>
      </Fill>

      <ControlSizeProvider size="sm">
        <Stack direction="row" align="center" gap="sm">
          <TrackLevel
            songId={songId}
            trackId={trackId}
            name={name}
            muted={muted}
            volume={volume}
          />
          <IconButton
            icon={hidden ? visibilityOffIcon : visibilityIcon}
            label={hidden ? "Show track" : "Hide track"}
            aria-pressed={hidden}
            className={cn(hidden && "text-muted-foreground")}
            onClick={() => setTrackHidden(songId, trackId, !hidden)}
          />
        </Stack>
      </ControlSizeProvider>
    </Stack>
  );
}

/**
 * The "Tracks" section panel (`Sonata.Section`, area "player"). Lists every
 * track of the open song with a compact control set: categorical color, a
 * speaker that mutes on click and expands into a volume fader on hover, and
 * hide (piano-roll), plus a functional per-track instrument picker and the
 * name / note count. State persists per (song, track).
 *
 * The host (SectionCard) paints the card chrome, title, and collapse; the
 * per-song reset is the section's header-right `actions` (`TrackMixerActions`).
 * Visibility is gated by the contribution's `useAvailable`
 * (`useTrackMixerAvailable`), so this body renders only with a loaded, tracked
 * library song — `useLibrarySong()` is therefore guaranteed a song here. While the song's
 * track views are loading it renders a loading state, never default rows.
 */
export function TrackMixerPanel() {
  const song = useLibrarySong();
  const entries = useTrackMixerEntries();

  // Registered timbres, read generically (never names a contributor). Mapped to
  // the plain metadata the picker renders; `createVoices` stays in the engine.
  const instruments = SonataAudio.Instrument.useContributions();
  const options = useMemo<InstrumentOption[]>(
    () =>
      instruments.map((c) => ({
        id: c.id,
        label: c.label,
        icon: c.icon,
        group: c.group,
      })),
    [instruments],
  );

  if (song.kind === "none") {
    throw new Error(
      "TrackMixerPanel rendered without a loaded library song — the section gate (useTrackMixerAvailable) should prevent this.",
    );
  }
  if (entries.kind === "pending") return <Loading variant="rows" count={3} />;
  if (entries.kind === "failed")
    return (
      <ResourceErrorInline
        variant="block"
        subject="the track views"
        error={entries.error}
        refetch={entries.refetch}
      />
    );

  return (
    <div className="divide-y divide-border/60">
      {entries.value.map((entry) => (
        <TrackRow
          key={entry.trackId}
          songId={song.songId}
          options={options}
          entry={entry}
        />
      ))}
    </div>
  );
}
