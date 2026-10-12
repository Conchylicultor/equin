import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import type { Lane } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import {
  stripAttemptBranchPrefix,
  type OpKind,
} from "@plugins/infra/plugins/worktree/core";
import {
  WAIT_KINDS,
  type OpSleep,
  type OpWait,
  type WaitKind,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import {
  formatDuration,
  GanttContainer,
  HATCH_CLASS,
  HATCH_STYLE,
  minBarSize,
  SpanDetail,
  useGanttContainerContext,
  type Span,
} from "@plugins/debug/plugins/profiling/web";
import {
  pct,
  Placed,
} from "@plugins/primitives/plugins/css/plugins/coords/web";

/**
 * One op on the Gantt, positioned on the chart's axis — `debug/profiling/ops`
 * projects each stored op (`op-store`'s `opsHistory` row, through op-log's
 * `toOpRecord`) onto this; the Gantt itself stays renderable from any source.
 * The two enums are IMPORTED (`OpKind` from worktree's `core`, `WaitKind` from
 * op-log's) rather than re-typed, so the fill maps below are exhaustive by
 * construction.
 */
export interface OpEntry {
  opId: string;
  kind: OpKind;
  /** Offset from the Gantt origin. */
  startMs: number;
  /** The op's FULL span: waits + the work gaps between them + the final hold. */
  totalMs: number;
  /**
   * Each entry's `startMs` is relative to THIS op's start. May gap; may repeat
   * a kind. An in-flight op's open wait is the last entry, clocked to the
   * reader's `now`.
   */
  waits: OpWait[];
  /**
   * Every nap inside the span, on the wall axis (`startMs` relative to THIS
   * op's start), drawn hatched over the bar — time that was neither work nor a
   * wait. An in-flight op's live tail is included.
   */
  sleeps: OpSleep[];
  holdMs: number;
  outcome: string;
  interrupted: boolean;
  branch: string;
  buildId: string | null;
  conversationId: string | null;
  lane: Lane | null;
}

export interface WorktreeGroup {
  worktree: string;
  conversationId: string | null;
  title: string | null;
  ops: OpEntry[];
}

export interface OpData {
  groups: WorktreeGroup[];
  totalMs: number;
}

export interface OpGanttProps {
  groups: WorktreeGroup[];
  totalMs: number;
  title?: string;
  highlightWorktree?: string;
  onWorktreeClick?: (worktree: string, conversationId: string | null) => void;
  /**
   * Handle a click on an op bar. Always fired (so the click never silently falls
   * through to the row's onWorktreeClick); the consumer dispatches on
   * `op.kind` — and, for a build, decides what to do when `op.buildId` is null
   * (legacy log entries predating the field have no profile to open).
   * `worktree` is the row's canonical worktree id, which the build-profile pane
   * needs and the op itself does not carry.
   */
  onOpClick?: (op: OpEntry, worktree: string) => void;
}

// ── The render model ────────────────────────────────────────────────────────
// An op is ONE bar spanning `startMs → startMs + totalMs`, colored by kind,
// with each `waits[]` entry painted as an overlay segment at its own true
// offset INSIDE that span.
//
// This is deliberately NOT a `[wait][hold]` head-to-tail split. Waits interleave
// with real work — a build reads
// `[build-lock][…migrations/codegen…][duress-valve][host-grant][…heavy work…]` —
// and one op may carry SEVERAL waits of the same kind (a build re-queues for the
// host grant across duress requeue cycles). So: N segments at arbitrary offsets,
// and `sum(waits) + holdMs` is generally LESS than `totalMs`. The gaps are the
// op actually working — unless the machine slept through them: each `sleeps[]`
// entry is painted hatched on top (over a wait, too: a nap is never a wait).
//
// The bar's axis is the WALL clock (`requestedAt → +totalMs`), so a wait is
// placed by its wall fields (`atMs`/`wallMs`) when it has them; its
// `startMs`/`durationMs` are on the monotonic clock, which pauses while the
// machine sleeps and would sit too early after a nap. A legacy wait has only
// those, and is placed by them as before.

// ── Visual language ─────────────────────────────────────────────────────────
// Three orthogonal channels so a bar is never ambiguous:
//
//   • TYPE_FILL answers "what is this?" — the base bar's fill, keyed on kind.
//     Cool/semantic hues. NEVER changes with status.
//   • WAIT_FILL answers "what is it blocked on?" — the overlay segments, keyed
//     on wait kind. Warm hues, drawn from the `categorical` token group (which
//     exists precisely to supply N mutually-distinguishable, light+dark-tested
//     hues — see plugins/ui/plugins/tokens/plugins/categorical). The warm/cool
//     split IS the gestalt: any warm patch on a bar means "not working here",
//     and its hue names WHICH resource — self-queued (push-mutex / build-lock)
//     vs. fleet-starved (host-grant) vs. duress-held (duress-valve). That
//     distinction is the entire diagnostic value of this pane.
//   • STATUS_TREATMENT answers "how did it go?" — layered on top of the fill:
//     ok → solid, in-flight → pulsing, failed/interrupted → red ring. Status
//     NEVER recolors the fill.
//
// This is why a running push is green+pulsing (not blue) and a failed build is
// blue+red-ring (not a different hue): color = type, ring = error.
const TYPE_FILL: Record<OpKind, string> = {
  build: "bg-info",
  push: "bg-success",
  // No semantic status token means "check", and every warm hue is spoken for by
  // a wait — so a check takes the one strongly-saturated cool hue neither the
  // other kinds nor any wait uses.
  check: "bg-categorical-5",
  // The two ops that only ever contend for the host grant: the next two unused
  // categorical hues (3/4/8/9 are the waits).
  test: "bg-categorical-6",
  e2e: "bg-categorical-7",
};

// A warm severity ramp: benign self-inflicted queueing (amber → orange), then
// the fleet starving you (red), then the cluster sentinel holding you out of a
// storm (magenta). The two closest hues — amber/orange — are exactly the pair
// that can never co-occur on one bar (a push never takes the build lock, a
// build never takes the push mutex), so the weakest contrast pair is the one
// you never have to tell apart in place.
const WAIT_FILL: Record<WaitKind, string> = {
  "push-mutex": "bg-categorical-3",
  "build-lock": "bg-categorical-9",
  "host-grant": "bg-categorical-4",
  "duress-valve": "bg-categorical-8",
  // Cool, not on the warm ramp: an in-flight wait is not contention — it is
  // this op riding on another's run, and costs the host nothing.
  "in-flight": "bg-categorical-1",
};

/** Where a wait sits on its op's wall-clock bar: its wall fields, else (legacy) its monotonic ones. */
export function waitPlacement(wait: OpWait): {
  startMs: number;
  durationMs: number;
} {
  return {
    startMs: wait.atMs ?? wait.startMs,
    durationMs: wait.wallMs ?? wait.durationMs,
  };
}

/**
 * A nap's hover label. Its length is always exact; its position is a guess
 * (`approx`) when no wake instant fell inside the gap it was found in.
 */
export function sleepLabel(sleep: OpSleep): string {
  const label = `Asleep ${formatDuration(sleep.durationMs)}`;
  return sleep.approx ? `${label} (position approximate)` : label;
}

/** The fill a kind's base bar uses — for consumers rendering the same op elsewhere. */
export function opFillClass(kind: OpKind): string {
  return TYPE_FILL[kind];
}

/** The fill a wait's segment uses — for consumers rendering the same op elsewhere. */
export function waitFillClass(kind: WaitKind): string {
  return WAIT_FILL[kind];
}

type EventStatus = "ok" | "running" | "failed" | "interrupted";

const STATUS_TREATMENT: Record<EventStatus, string> = {
  ok: "",
  running: "animate-pulse",
  // ring-inset so the ring isn't clipped by the row's overflow-hidden track.
  failed: "ring-1 ring-inset ring-destructive",
  interrupted: "ring-1 ring-inset ring-destructive",
};

// Status dot in the row label — summarizes the worktree's last op. Mirrors the
// bar language: green = landed, green-pulse = in flight, red = failed/interrupted.
const STATUS_DOT: Record<EventStatus, string> = {
  ok: "bg-success",
  running: "bg-success animate-pulse",
  failed: "bg-destructive",
  interrupted: "bg-destructive",
};

/**
 * ONE status derivation for all three kinds, replacing the separate
 * `pushStatus`/`buildStatus` — the duplication that let build and push drift.
 *
 * The terminal vocabularies differ per kind (`build`/`check`:
 * `success | failed | error`; `push`: `success | failed_rebase | failed_checks |
 * failed_push | error`) but they agree on `success`, and the two synthetic
 * in-flight outcomes (`waiting` = still queued, `running` = admitted, possibly
 * parked in a POST-grant wait) are shared. So: success → ok, in-flight →
 * running, everything else → failed.
 */
function opStatus(op: OpEntry): EventStatus {
  if (op.interrupted) return "interrupted";
  switch (op.outcome) {
    case "success":
      return "ok";
    case "waiting":
    case "running":
      return "running";
    // failed, error, failed_rebase, failed_checks, failed_push
    default:
      return "failed";
  }
}

/**
 * A wait's hover label: its kind, the writer's reason (the duress latch's trip
 * cause) and the requeue cycle it belonged to — the "why" behind the hue.
 */
export function waitLabel(wait: OpWait): string {
  const reason = wait.reason ? ` — ${wait.reason}` : "";
  const cycle = wait.cycle > 0 ? ` · requeue #${wait.cycle}` : "";
  const result =
    wait.result === "fail-open" || wait.result === "aborted"
      ? ` · ${wait.result}`
      : "";
  return `${WAIT_KINDS[wait.kind].label} wait${reason}${cycle}${result}`;
}

// Hard-killed ops have no known end, so there is no duration to scale a bar
// from (the reader stamps totalMs 0). Render them as a fixed-width marker at
// their start instead — a visible trace that the op began and never finished,
// without a fake bar. No wait segments either: an unbounded span cannot place
// them honestly.
const INTERRUPTED_MARKER_PX = 4;

export function OpGantt({
  groups,
  totalMs,
  title = "Ops",
  highlightWorktree,
  onWorktreeClick,
  onOpClick,
}: OpGanttProps): ReactElement {
  const [hovered, setHovered] = useState<Span | null>(null);

  return (
    <div className="relative">
      <GanttContainer title={title} totalMs={totalMs}>
        <div className="border-b">
          {groups.map((group) => (
            <OpRow
              key={group.worktree}
              group={group}
              hovered={hovered}
              setHovered={setHovered}
              highlighted={group.worktree === highlightWorktree}
              onWorktreeClick={onWorktreeClick}
              onOpClick={onOpClick}
            />
          ))}
        </div>
      </GanttContainer>
      <OpLegend groups={groups} />
      <Sticky edge="bottom" className="backdrop-blur-sm">
        <SpanDetail span={hovered} />
      </Sticky>
    </div>
  );
}

/**
 * Four wait hues are only diagnostic if the mapping is readable, so the legend
 * is part of the feature, not decoration. It lists ONLY what the current data
 * actually contains, so a pane with no duress episode never spends a line
 * explaining one.
 */
function OpLegend({
  groups,
}: {
  groups: WorktreeGroup[];
}): ReactElement | null {
  const entries = useMemo(() => {
    const kinds = new Set<OpKind>();
    const waits = new Set<WaitKind>();
    let asleep = false;
    for (const group of groups) {
      for (const op of group.ops) {
        kinds.add(op.kind);
        for (const wait of op.waits) {
          if (waitPlacement(wait).durationMs > 0) waits.add(wait.kind);
        }
        if (op.sleeps.some((sl) => sl.durationMs > 0)) asleep = true;
      }
    }
    return [
      ...[...kinds].map((k) => ({
        key: `kind:${k}`,
        label: k,
        fill: TYPE_FILL[k],
        hatched: false,
      })),
      ...[...waits].map((w) => ({
        key: `wait:${w}`,
        label: `${w} wait`,
        fill: WAIT_FILL[w],
        hatched: false,
      })),
      ...(asleep
        ? [{ key: "asleep", label: "Asleep", fill: HATCH_CLASS, hatched: true }]
        : []),
    ];
  }, [groups]);

  if (entries.length === 0) return null;

  return (
    <Cluster gap="md" className="border-b px-lg py-xs">
      {entries.map((entry) => (
        <Stack key={entry.key} direction="row" align="center" gap="2xs">
          {entry.hatched ? (
            // The nap swatch: the bars' own hatch, in a box big enough for
            // its stripes to read (a dot-sized one would be a grey smudge).
            <span
              className={cn("inline-block size-3 rounded-sm", entry.fill)}
              style={HATCH_STYLE}
            />
          ) : (
            <StatusDot colorClass={entry.fill} />
          )}
          <Text as="span" variant="caption" className="text-muted-foreground">
            {entry.label}
          </Text>
        </Stack>
      ))}
    </Cluster>
  );
}

function OpRow({
  group,
  hovered,
  setHovered,
  highlighted,
  onWorktreeClick,
  onOpClick,
}: {
  group: WorktreeGroup;
  hovered: Span | null;
  setHovered: (span: Span | null) => void;
  highlighted: boolean;
  onWorktreeClick?: (worktree: string, conversationId: string | null) => void;
  onOpClick?: (op: OpEntry, worktree: string) => void;
}): ReactElement {
  const lastOp = group.ops[group.ops.length - 1];
  const dotColor = lastOp ? STATUS_DOT[opStatus(lastOp)] : TYPE_FILL.build;
  // Each op's own FULL span, summed. Never `waits + hold` — that omits the work
  // gaps between the waits and would under-report every build.
  const totalDuration = group.ops.reduce((sum, op) => sum + op.totalMs, 0);
  // A row is keyed on the checkout id, but a legacy line with no slug is filed
  // under its branch, so the identifier can still arrive branch-shaped; the
  // label shows the bare id either way.
  const worktreeLabel = stripAttemptBranchPrefix(group.worktree);

  const handleClick = useMemo(() => {
    if (!onWorktreeClick) return undefined;
    const uniqueConvIds = [
      ...new Set(
        group.ops
          .map((o) => o.conversationId)
          .filter((id): id is string => id != null),
      ),
    ];
    const singleConvId = uniqueConvIds.length === 1 ? uniqueConvIds[0]! : null;
    return () => onWorktreeClick(group.worktree, singleConvId);
  }, [group, onWorktreeClick]);

  return (
    <Stack
      direction="row"
      align="center"
      gap="sm"
      className={cn(
        "px-lg py-xs hover:bg-muted/50",
        handleClick && "cursor-pointer",
        highlighted && "ring-1 ring-inset ring-primary/40 bg-primary/5",
      )}
      onClick={handleClick}
    >
      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- fixed 160px (w-40) worktree-label column kept rigid (shrink-0) to align with the Gantt time axis (LABEL_WIDTH)
        className="flex w-40 shrink-0 items-center gap-xs truncate"
        // Bare worktree id stays discoverable on hover even when a title shows.
        title={worktreeLabel}
      >
        <StatusDot colorClass={dotColor} />
        <span
          className={cn(
            "truncate text-2xs text-muted-foreground",
            // Titles read as prose; the opaque worktree id stays monospace.
            group.title ? "" : "font-mono",
          )}
        >
          {group.title ?? worktreeLabel}
        </span>
      </div>
      {/* eslint-disable-next-line layout/no-adhoc-layout -- flexible timeline track (flex-1) clipping the runtime-positioned bars (overflow-hidden) */}
      <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-muted/30">
        {group.ops.map((op) => (
          <OpBar
            key={op.opId}
            op={op}
            worktree={group.worktree}
            hovered={hovered}
            setHovered={setHovered}
            onOpClick={onOpClick}
          />
        ))}
      </div>
      {/* eslint-disable-next-line layout/no-adhoc-layout -- fixed 64px (w-16) duration column kept rigid (shrink-0) to align with the Gantt time axis (DURATION_WIDTH) */}
      <div className="w-16 shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground">
        {formatDuration(totalDuration)}
      </div>
    </Stack>
  );
}

/** The op's base bar plus one overlay per wait, each at its true in-span offset. */
function OpBar({
  op,
  worktree,
  hovered,
  setHovered,
  onOpClick,
}: {
  op: OpEntry;
  worktree: string;
  hovered: Span | null;
  setHovered: (span: Span | null) => void;
  onOpClick?: (op: OpEntry, worktree: string) => void;
}): ReactElement {
  const { toLeftFraction, toWidthFraction, totalMs } =
    useGanttContainerContext();
  const status = opStatus(op);
  const clickable = onOpClick !== undefined;

  // The lane explains WHY an op waited (interactive draws from a reserved
  // floor; background does not), so it rides the hover label rather than taking
  // room on the bar — the diagnosis is one hover away, and the track stays a
  // pure time axis.
  const laneSuffix = op.lane ? ` · ${op.lane}` : "";

  // Shared handlers: the whole op — base bar and every wait segment — is one
  // click target. stopPropagation on pointerdown keeps GanttContainer's
  // drag-zoom from setPointerCapture'ing and retargeting the click off the bar;
  // stopPropagation on click keeps it from falling through to the row's
  // onWorktreeClick (a surprising silent redirect into the conversation).
  const interactions = clickable
    ? {
        onPointerDown: (e: ReactPointerEvent) => e.stopPropagation(),
        onClick: (e: ReactMouseEvent) => {
          e.stopPropagation();
          onOpClick(op, worktree);
        },
      }
    : {};

  if (op.interrupted) {
    const markerSpan: Span = {
      id: `op:${op.opId}`,
      phase: worktree,
      label: `${op.kind} (interrupted)${laneSuffix}`,
      startMs: op.startMs,
      durationMs: 0,
    };
    return (
      <Placed
        x={{
          start: pct(toLeftFraction(op.startMs, totalMs)),
          size: INTERRUPTED_MARKER_PX,
        }}
        y="fill"
        className={cn(
          "rounded-md transition-opacity",
          TYPE_FILL[op.kind],
          STATUS_TREATMENT[status],
          hovered?.id === markerSpan.id ? "opacity-100" : "opacity-70",
          clickable && "cursor-pointer",
        )}
        onMouseEnter={() => setHovered(markerSpan)}
        onMouseLeave={() => setHovered(null)}
        {...interactions}
      />
    );
  }

  const baseSpan: Span = {
    id: `op:${op.opId}`,
    phase: worktree,
    label: `${op.kind} (${op.outcome})${laneSuffix}`,
    startMs: op.startMs,
    durationMs: op.totalMs,
  };

  // Zero-length waits and naps would paint nothing (`minBarSize` declines to
  // floor an empty span), so they are dropped rather than emitted as empty boxes.
  const waits = op.waits.filter((w) => waitPlacement(w).durationMs > 0);
  const sleeps = op.sleeps.filter((sl) => sl.durationMs > 0);

  return (
    <>
      <Placed
        x={{
          start: pct(toLeftFraction(op.startMs, totalMs)),
          size: pct(toWidthFraction(op.totalMs, totalMs)),
          minSize: minBarSize(op.totalMs),
        }}
        y="fill"
        className={cn(
          "rounded-md transition-opacity",
          TYPE_FILL[op.kind],
          STATUS_TREATMENT[status],
          hovered?.id === baseSpan.id ? "opacity-100" : "opacity-50",
          clickable && "cursor-pointer",
        )}
        onMouseEnter={() => setHovered(baseSpan)}
        onMouseLeave={() => setHovered(null)}
        {...interactions}
      />
      {waits.map((wait, i) => {
        // Relative to the op's own start — waits are painted at their true
        // offsets inside the span, never packed head-to-tail.
        const at = waitPlacement(wait);
        const waitSpan: Span = {
          id: `wait:${op.opId}:${i}`,
          phase: worktree,
          label: waitLabel(wait),
          startMs: op.startMs + at.startMs,
          durationMs: at.durationMs,
        };
        return (
          <Placed
            key={waitSpan.id}
            x={{
              start: pct(toLeftFraction(waitSpan.startMs, totalMs)),
              size: pct(toWidthFraction(at.durationMs, totalMs)),
              minSize: minBarSize(at.durationMs),
            }}
            y="fill"
            className={cn(
              "rounded-sm transition-opacity",
              WAIT_FILL[wait.kind],
              hovered?.id === waitSpan.id ? "opacity-100" : "opacity-90",
              clickable && "cursor-pointer",
            )}
            onMouseEnter={() => setHovered(waitSpan)}
            onMouseLeave={() => setHovered(null)}
            {...interactions}
          />
        );
      })}
      {sleeps.map((sleep, i) => {
        // Painted LAST, over any wait it overlaps, and opaque: the stretch was
        // neither work nor a wait, whatever the op was doing when it began.
        const sleepSpan: Span = {
          id: `sleep:${op.opId}:${i}`,
          phase: worktree,
          label: sleepLabel(sleep),
          startMs: op.startMs + sleep.startMs,
          durationMs: sleep.durationMs,
        };
        return (
          <Placed
            key={sleepSpan.id}
            title={sleepSpan.label}
            x={{
              start: pct(toLeftFraction(sleepSpan.startMs, totalMs)),
              size: pct(toWidthFraction(sleep.durationMs, totalMs)),
              minSize: minBarSize(sleep.durationMs),
            }}
            y="fill"
            className={cn(
              "rounded-sm bg-background",
              HATCH_CLASS,
              clickable && "cursor-pointer",
            )}
            style={HATCH_STYLE}
            onMouseEnter={() => setHovered(sleepSpan)}
            onMouseLeave={() => setHovered(null)}
            {...interactions}
          />
        );
      })}
    </>
  );
}
