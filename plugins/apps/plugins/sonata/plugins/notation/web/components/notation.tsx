import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  type PlayPosition,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { useConfig } from "@plugins/config_v2/web";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import {
  useHiddenTrackIds,
  useTrackMixerEntries,
} from "@plugins/apps/plugins/sonata/plugins/track-mixer/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useVirtualRows } from "@plugins/primitives/plugins/virtual-rows/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { convert, type StaffLayout } from "../internal/convert";
import {
  planEngraving,
  type BeatAnchor,
  type EngraveColors,
  type EngravePlan,
  type SystemDrawResult,
  type SystemPlan,
} from "./engrave";
import { NotationSystem } from "./notation-system";
import { notationConfig } from "../../shared/config";

/** Props the player's `SonataPlayer.Display.Dispatch` passes to the chosen display. The
 *  playback cursor is NOT a prop — it's read imperatively (playhead/highlight,
 *  zero re-render) and via `useCursorSelector` (auto-scroll, per-system). */
export interface NotationProps {
  score: Score;
  tempoScale: number;
  activeDisplayId: string;
}

const EPS = 1e-6;

/**
 * Sheet music is always engraved as black ink on white paper — deliberately
 * independent of the app theme (light/dark) AND the active color preset. Real
 * notation is monochrome print; a tinted, inverted, or light-on-dark staff reads
 * as a rendering bug, not a skin. The only accent is the active-note highlight +
 * playhead, a single fixed hue chosen for strong contrast on white paper.
 */
const PAPER = {
  /** Page background. */
  background: "#ffffff",
  /** Notes, staff lines, clefs, text, part labels. */
  ink: "#1a1a1a",
  /** Active-note highlight + playhead accent (reads well on white). */
  accent: "#2563eb",
} as const;

/** Active-note highlight + playhead accent. CSS beats SVG presentation
 *  attributes, so this recolors the engraved fills of the sounding note. */
const HIGHLIGHT_CSS = `
.notation-surface .vf-note.is-active,
.notation-surface .vf-note.is-active * {
  fill: ${PAPER.accent};
  stroke: ${PAPER.accent};
}`;

/** Fixed engraving ink (module-scope so its identity is stable — a NotationSystem
 *  layout-effect dep). Sheet music never re-skins, so this is a constant. */
const INK: EngraveColors = { foreground: PAPER.ink, primary: PAPER.accent };

/** Stable empty fallback for the virtualizer's items before a plan exists. */
const EMPTY_SYSTEMS: SystemPlan[] = [];

/** Largest anchor with `beat <= cursor`, plus the next anchor — for interpolation. */
function locate(
  anchors: BeatAnchor[],
  beat: number,
): { lo: BeatAnchor; hi: BeatAnchor | null } | null {
  if (anchors.length === 0) return null;
  let lo = 0;
  let hi = anchors.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid]!.beat <= beat + EPS) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { lo: anchors[idx]!, hi: anchors[idx + 1] ?? null };
}

/** Greatest system index whose `startBeat <= beat`, clamped to a valid index. */
function systemForBeat(systems: SystemPlan[], beat: number): number {
  if (systems.length === 0) return 0;
  let lo = 0;
  let hi = systems.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (systems[mid]!.startBeat <= beat + EPS) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.min(Math.max(idx, 0), systems.length - 1);
}

function NotationInner({ score }: NotationProps) {
  const { showChordSymbols, splitPitch, staffLayout, separateVoices } =
    useConfig(notationConfig);
  const { seekTo, isPlaying } = useSession();
  const { content } = useSongDocument();
  const scorePending = content.kind === "pending";
  const scoreFailure = content.kind === "failed" ? content.failure : null;
  const cursor = useCursorApi();

  // Drop hidden tracks (track-mixer) before engraving, and pass the visible
  // tracks' names through so per-track staves can be labeled. Until the song's
  // track views are known nothing is engraved (a hidden track must never flash
  // in), and the surface shows the loading state below.
  const hiddenTrackIds = useHiddenTrackIds();
  const trackEntries = useTrackMixerEntries();
  // A failed track-view read also fails the score gate (the track view is a
  // registered setting), so `scoreFailure` covers it; unsettled views
  // otherwise read as still loading.
  const viewPending =
    scorePending ||
    hiddenTrackIds.kind !== "settled" ||
    trackEntries.kind !== "settled";
  const visibleScore = useMemo<Score>(() => {
    if (hiddenTrackIds.kind !== "settled") return { ...score, notes: [] };
    const hidden = hiddenTrackIds.value;
    if (hidden.size === 0) return score;
    return {
      ...score,
      notes: score.notes.filter((n) => !hidden.has(n.track)),
    };
  }, [score, hiddenTrackIds]);
  // Track metadata for `convert`: instrument key (gmProgram/instrumentHint) from
  // the score's own tracks — the authoritative instrument info `auto` groups by —
  // joined with the track-mixer's display name (honors a user rename). Filtered
  // to the visible tracks so a hidden track never forms a part.
  const trackMeta = useMemo(() => {
    if (hiddenTrackIds.kind !== "settled" || trackEntries.kind !== "settled")
      return [];
    const hidden = hiddenTrackIds.value;
    const nameById = new Map(
      trackEntries.value.map((e) => [e.trackId, e.name]),
    );
    return score.tracks
      .filter((t) => !hidden.has(t.id))
      .map((t) => ({
        id: t.id,
        name: nameById.get(t.id) ?? t.name,
        gmProgram: t.gmProgram,
        instrumentHint: t.instrumentHint,
      }));
  }, [score.tracks, trackEntries, hiddenTrackIds]);

  const [sizeRef, size] = useElementSize<HTMLDivElement>();
  const playheadRef = useRef<HTMLDivElement | null>(null);

  // One entry per mounted (drawn) system, keyed by system index — the anchors +
  // tagged notes each NotationSystem registers. The imperative playhead reads
  // the active system's entry; off-window systems have no entry (and no DOM).
  const registryRef = useRef<Map<number, SystemDrawResult>>(new Map());
  const activeElsRef = useRef<SVGElement[]>([]);
  // Last system the playhead auto-scrolled to — so we scroll only on a system
  // boundary, not every frame. Play-state read via a ref so applyCursor stays
  // identity-stable (never re-attaches the per-frame subscription).
  const lastScrolledSystemRef = useRef(-1);
  const isPlayingRef = useLatestRef(isPlaying);

  const model = useMemo(
    () =>
      convert(visibleScore, {
        splitPitch,
        showChordSymbols,
        staffLayout: staffLayout as StaffLayout,
        separateVoices,
        tracks: trackMeta,
      }),
    [
      visibleScore,
      splitPitch,
      showChordSymbols,
      staffLayout,
      separateVoices,
      trackMeta,
    ],
  );
  const hasNotes = visibleScore.notes.length > 0;

  // PURE layout plan (no DOM/Renderer) — safe in a memo. Each mounted system
  // draws itself from this; recomputes on model / width change.
  const plan = useMemo<EngravePlan | null>(
    () =>
      !hasNotes || size.width <= 0 ? null : planEngraving(model, size.width),
    [model, size.width, hasNotes],
  );
  const planRef = useLatestRef(plan);

  // Headless windowing: only systems near the viewport mount (create SVG DOM).
  // Each system's height is exact from the plan (systems vary with their ink).
  const estimateSize = useCallback(
    (i: number) => plan?.systems[i]?.pitch ?? 1,
    [plan],
  );
  const { measureRef, virtualizer, virtualItems, scrollMargin, totalSize } =
    useVirtualRows<SystemPlan>({
      items: plan?.systems ?? EMPTY_SYSTEMS,
      estimateSize,
      getKey: (s) => String(s.index),
      overscan: 4,
    });
  const virtualizerRef = useLatestRef(virtualizer);

  // Set by the re-plan effect; NotationSystem calls it after (re)drawing so the
  // playhead re-locates immediately once a freshly mounted system registers.
  const reapplyRef = useRef<((i: number) => void) | null>(null);

  // Imperative per-frame cursor application — playhead position + note highlight,
  // ZERO React renders. Reads the latest plan + drawn-system registry from refs.
  const applyCursor = useCallback((position: PlayPosition) => {
    const beat = position.beat;
    const plan = planRef.current;
    const playhead = playheadRef.current;
    if (!plan || !playhead || plan.systems.length === 0) {
      if (playhead) playhead.style.display = "none";
      return;
    }

    const sysIndex = systemForBeat(plan.systems, beat);
    const sys = plan.systems[sysIndex]!;
    const reg = registryRef.current.get(sysIndex);

    // x within the active system — interpolate between the two bracketing
    // anchors (a forward-only path ending on the system's closing barline, see
    // `playheadPath`). The active system is kept mounted (auto-scroll centers it); if
    // its registry entry is momentarily missing (mid-scroll), fall back to the
    // left pad — the playhead re-locates once the system registers next frame.
    let x = plan.leftPad;
    if (reg) {
      const found = locate(reg.anchors, beat);
      if (found) {
        const { lo, hi } = found;
        x = lo.x;
        if (hi && hi.systemIndex === lo.systemIndex && hi.beat > lo.beat) {
          x = lo.x + ((hi.x - lo.x) * (beat - lo.beat)) / (hi.beat - lo.beat);
        }
      }
    }

    playhead.style.display = "block";
    playhead.style.height = `${sys.boxHeight}px`;
    playhead.style.transform = `translate(${x}px, ${sys.top}px)`;

    // Auto-scroll the active system to center — only on a system boundary, and
    // only while playing so a paused reader can scroll and browse freely.
    if (sysIndex !== lastScrolledSystemRef.current) {
      lastScrolledSystemRef.current = sysIndex;
      if (isPlayingRef.current) {
        virtualizerRef.current?.scrollToIndex(sysIndex, {
          align: "center",
          behavior: "smooth",
        });
      }
    }

    // Highlight: clear the previous active set, light up notes sounding now.
    // Only mounted systems have notes; the sounding note is in the (mounted)
    // active system, so iterating every registry entry suffices. Inside an A–B
    // loop's rest nothing sounds (the playhead waits on A), so nothing lights.
    for (const el of activeElsRef.current) el.classList.remove("is-active");
    const next: SVGElement[] = [];
    const sounding = position.rest > 0 ? [] : registryRef.current.values();
    for (const entry of sounding) {
      for (const n of entry.notes) {
        if (n.beat <= beat + EPS && n.end > beat + EPS) {
          n.el.classList.add("is-active");
          next.push(n.el);
        }
      }
    }
    activeElsRef.current = next;
  }, []);

  // Drive the imperative path on every cursor change — no React render.
  useEffect(
    () => cursor.subscribe(() => applyCursor(cursor.getPosition())),
    [cursor, applyCursor],
  );

  // Re-plan reset: on a new plan (score / width / config change), forget the
  // last scrolled system + active highlights, arm the redraw callback so newly
  // mounted systems re-locate the playhead, and re-apply the cursor once.
  useEffect(() => {
    lastScrolledSystemRef.current = -1;
    activeElsRef.current = [];
    reapplyRef.current = () => applyCursor(cursor.getPosition());
    applyCursor(cursor.getPosition());
  }, [plan, applyCursor, cursor]);

  // Click a notehead to seek the transport to its beat.
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element;
      const noteEl = target.closest<SVGElement>(".vf-note");
      const beat = noteEl?.dataset.beat;
      if (beat !== undefined) seekTo(Number(beat));
    },
    [seekTo],
  );

  if (scoreFailure !== null) {
    // A setting could not be read: say so, not "no notes" nor a spinner.
    return (
      <Center className="h-full w-full bg-background">
        <ResourceErrorInline
          variant="block"
          subject="the song's settings"
          error={scoreFailure.error}
          refetch={scoreFailure.refetch}
        />
      </Center>
    );
  }
  if (viewPending) {
    // The song's settings are still loading: not "no notes".
    return (
      <Center className="h-full w-full bg-background">
        <Loading />
      </Center>
    );
  }
  if (!hasNotes) {
    return (
      <Center className="h-full w-full bg-background">
        <Placeholder>No notes to display as notation.</Placeholder>
      </Center>
    );
  }

  return (
    // Fixed white "paper" surface — sheet music is always black-on-white,
    // independent of the app theme (see PAPER). `relative` makes it the
    // positioning context for the corner-pinned HUD over the scroll body.
    <div
      className="notation-surface relative h-full w-full"
      style={{ backgroundColor: PAPER.background }}
    >
      <style>{HIGHLIGHT_CSS}</style>
      <Scroll axis="y" className="h-full">
        <Inset pad="md">
          {/* Width source for the plan (measured) + start of the virtual region. */}
          <div ref={sizeRef} className="relative">
            {/* The windowing sizer: a relative host whose height is the full
                virtual extent, anchoring each system row at a measured
                translateY. No layout primitive models a windowed list, and the
                playhead is its absolutely-positioned sibling. */}
            <div
              ref={measureRef}
              className="relative w-full"
              style={{ height: totalSize }}
              onClick={onClick}
            >
              {virtualItems.map((vi) => (
                // x is a plain inset (the row spans the sizer); only y is a
                // `shift`, so the measured offset stays on the compositor.
                <Placed
                  key={vi.key}
                  data-index={vi.index}
                  x={{ start: 0, end: 0 }}
                  y={{ start: 0, shift: vi.start - scrollMargin }}
                >
                  <NotationSystem
                    plan={plan!}
                    systemIndex={vi.index}
                    colors={INK}
                    registryRef={registryRef}
                    onDrawn={reapplyRef}
                  />
                </Placed>
              ))}
              {/* The playhead line: anchored at the sizer's top-left and moved
                  imperatively (applyCursor writes `transform` + `height` per
                  frame — `translate` and `transform` compose, and this box
                  declares no shift anyway). A sizer sibling, so scrollMargin
                  cancels exactly as it does for the rows. */}
              <Placed
                ref={playheadRef}
                x={{ start: 0 }}
                y={{ start: 0 }}
                layer="raised"
                decorative
                className="w-0.5"
                style={{
                  display: "none",
                  backgroundColor: PAPER.accent,
                  opacity: 0.7,
                }}
              />
            </div>
          </div>
        </Inset>
      </Scroll>

      {/* HUD: screen-anchored chips (current key, …) pinned to the top-right
          corner. Collection-consumer clean — renders the generic Sonata.Hud
          slot, never naming a contributor. */}
      <Pin to="top-right" offset="sm" layer="float" decorative>
        <Stack gap="xs" align="end">
          <Sonata.Hud.Render>
            {(h) => <h.component key={h.id} />}
          </Sonata.Hud.Render>
        </Stack>
      </Pin>
    </div>
  );
}

/**
 * The notation Display. Engraves the score as a grand staff (treble + bass) via
 * VexFlow — clefs, key/time signatures, barlines, accidentals, rests, ties — and
 * follows playback with a moving playhead, active-note highlight, and per-system
 * auto-scroll. A reading view: no projection, no capabilities; click a note to
 * seek the transport.
 */
export function Notation(props: NotationProps) {
  return <NotationInner {...props} />;
}
