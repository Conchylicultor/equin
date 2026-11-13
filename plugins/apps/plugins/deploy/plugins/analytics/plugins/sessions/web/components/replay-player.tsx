import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  REPLAY_PROTOCOL,
  ReplayFrameMessageSchema,
  type LoadTiming,
  type ReplayCommand,
  type Session,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { AppFrame } from "@plugins/primitives/plugins/embed/plugins/frame/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Placed,
  pct,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  SegmentedControl,
  ToggleChip,
} from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { presentEvent, propsText } from "../internal/events";
import { sourceOf } from "../internal/facts";
import { clock, countryName, span, timeOfDay } from "../internal/format";
import { journeyOf } from "../internal/journey";
import { loadPhases, seconds, visitLoad } from "../internal/load";
import {
  currentStep,
  frameStateAt,
  recentActions,
  replayScriptOf,
  skipAway,
  viewportAt,
  type ReplayScript,
  type ReplayStep,
} from "../internal/replay";
import { GAP_FILL, GAP_LABEL, GapSwatch } from "./gap-look";

/** Where the site is served on this computer: what the replay frames. */
export interface ReplayTarget {
  namespace: Namespace;
  /** `website.localhost:9000` — shown in the frame's address bar. */
  host: string;
  /** The namespace's origin. */
  url: string;
  /** Rebuild the local serve (one predating the replay channel never says it is ready). */
  rebuild: () => void;
}

const SPEEDS = ["1", "2", "4", "8"] as const;
type Speed = (typeof SPEEDS)[number];
const SPEED_OPTIONS = SPEEDS.map((id) => ({ id, label: `${id}×` }));

/** The address bar over the frame, in px: part of the box that is scaled to fit. */
const BAR_PX = 28;
/** Room kept around the device on the stage, each side. */
const STAGE_PAD_PX = 24;
/** After an in-app navigation, how long the new page gets to mount its sections before a scroll aims at one. */
const SETTLE_MS = 600;

const playIcon = symbol("play-arrow");
const pauseIcon = symbol("pause");
const restartIcon = symbol("replay");
const skipIcon = symbol("skip-next");

/**
 * One visit played on the site's local serve, at the visitor's viewport: the
 * page load as long as it took them (a veil over the frame, its phases
 * filling in), each page opened as they opened it (in-app, no reload), each
 * section they reached scrolled into view when they reached it, their actions
 * as toasts, and the stretches they were away dimmed — or skipped. Not a
 * pixel replay: the feel of the visit, on today's build of the site.
 */
export function ReplayPlayer({
  session,
  startPage,
  target,
}: {
  session: Session;
  startPage: number;
  target: ReplayTarget;
}): ReactNode {
  const script = useMemo(
    () => replayScriptOf(journeyOf(session), visitLoad(session)),
    [session],
  );
  const first = script.pages[startPage];
  if (first === undefined)
    throw new Error(
      `[sessions] replay: visit ${session.id} has no page ${startPage}`,
    );
  // One frame load: from the visit's start (its recorded load replayed), or
  // straight onto a later page (whose load is this computer's alone).
  const [run, setRun] = useState({
    id: 0,
    page: startPage,
    fromS: startPage === 0 ? 0 : first.startS,
  });
  const [ready, setReady] = useState(false);
  const [t, setT] = useState(run.fromS);
  const tRef = useRef(run.fromS);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<Speed>("1");
  const [skip, setSkip] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // The instant the frame must be up before the clock may pass it: the end of
  // the recorded load, or the later page this run opened on.
  const gateS = run.page === 0 ? script.loadS : run.fromS;

  const moveTo = useCallback((s: number) => {
    tRef.current = s;
    setT(s);
  }, []);

  const restart = useCallback(() => {
    setRun((r) => ({ id: r.id + 1, page: 0, fromS: 0 }));
    setReady(false);
    moveTo(0);
    setPlaying(true);
  }, [moveTo]);

  const seek = useCallback(
    (s: number) => {
      // Before this run's first frame there is nothing to seek in: the load
      // is replayed from the start.
      if (s < run.fromS || (run.page === 0 && s < script.loadS)) restart();
      else moveTo(Math.min(s, script.totalS));
    },
    [run, script, restart, moveTo],
  );

  // The frame says it is up (its tracker started: the app rendered its route).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      if (ReplayFrameMessageSchema.safeParse(e.data).success) setReady(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // The clock: one animation frame per tick while playing (rendering, not
  // polling — it stops with the pause), held at the gate until the frame is up.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * Number(speed);
      last = now;
      let next = Math.min(script.totalS, tRef.current + dt);
      if (!ready) next = Math.min(next, gateS);
      if (skip) next = skipAway(script, next);
      moveTo(next);
      if (next >= script.totalS) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, skip, ready, gateS, script, moveTo]);

  const state = frameStateAt(script, t);
  const page = script.pages[state.page]!;
  const pagePath = page.path;

  // Keep the frame on the page and section the visitor was at.
  const shownPage = useRef(run.page);
  useEffect(() => {
    shownPage.current = run.page;
  }, [run.id, run.page]);
  useEffect(() => {
    if (!ready || state.loading) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const origin = new URL(target.url).origin;
    const send = (command: ReplayCommand) => win.postMessage(command, origin);
    const scroll: ReplayCommand =
      state.section === null
        ? { protocol: REPLAY_PROTOCOL, kind: "scroll-top" }
        : {
            protocol: REPLAY_PROTOCOL,
            kind: "scroll-to",
            section: state.section,
          };
    if (shownPage.current === state.page) {
      send(scroll);
      return;
    }
    shownPage.current = state.page;
    send({ protocol: REPLAY_PROTOCOL, kind: "navigate", path: pagePath });
    if (state.section === null) return;
    // A new page mounts its sections after the navigation: aim once it has.
    const timer = setTimeout(() => send(scroll), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [ready, state.loading, state.page, state.section, pagePath, target.url]);

  const viewport = viewportAt(script, state.page, session.device);
  const away = state.away;

  return (
    <Stack gap="none" className="h-full">
      <Inset x="md" y="sm" className="border-b border-border">
        <Line className="gap-md">
          <Fill>
            <Facts session={session} />
          </Fill>
          <Text
            variant="caption"
            tone="muted"
            className={cn(
              "rounded-full px-sm py-2xs tabular-nums",
              viewport.estimated
                ? "border border-dashed border-border"
                : "bg-muted",
            )}
            title={
              viewport.estimated
                ? `Not recorded: a typical ${session.device.toLowerCase()} screen`
                : "The visitor's viewport"
            }
          >
            {viewport.estimated ? "~" : ""}
            {viewport.w} × {viewport.h}
          </Text>
          <IconButton
            icon={restartIcon}
            label="Replay from the start"
            onClick={restart}
          />
          <NewTabButton
            href={`${target.url}${pagePath}`}
            label="Open the local serve"
            tooltip={`Open ${target.host}${pagePath}`}
          />
        </Line>
      </Inset>
      <Fill axis="y">
        <Stack direction="row" gap="none" className="h-full">
          <Fill>
            <Stage
              viewport={viewport}
              host={target.host}
              path={pagePath}
              frame={
                <AppFrame
                  key={run.id}
                  ref={frameRef}
                  namespace={target.namespace}
                  path={script.pages[run.page]!.path}
                  title="Session replay"
                  className="h-full w-full border-0 bg-background"
                />
              }
            >
              {/* The replay drives the page: a click inside would leave the visit. */}
              <Layer aria-hidden />
              {away !== null && (
                <AwayScrim step={away} t={t} onSkip={() => seek(away.endS)} />
              )}
              <ActionToasts script={script} t={t} />
              {(state.loading || !ready) && (
                <LoadVeil
                  load={run.page === 0 ? script.load : null}
                  t={t}
                  loadS={script.loadS}
                  waiting={!ready && t >= gateS}
                  host={target.host}
                  onRebuild={target.rebuild}
                />
              )}
            </Stage>
          </Fill>
          <Scroll axis="y" className="w-[280px] border-l border-border">
            <Steps script={script} t={t} onSeek={seek} />
          </Scroll>
        </Stack>
      </Fill>
      <Inset x="md" y="sm" className="border-t border-border">
        <Line className="gap-md">
          <IconButton
            icon={playing ? pauseIcon : playIcon}
            label={playing ? "Pause" : "Play"}
            onClick={() => {
              if (!playing && t >= script.totalS) restart();
              else setPlaying((p) => !p);
            }}
          />
          <Text variant="caption" tone="muted" className="tabular-nums">
            <b className="font-semibold text-foreground">{clock(t)}</b> /{" "}
            {clock(script.totalS)}
          </Text>
          <Fill>
            <Scrubber script={script} t={t} onSeek={seek} />
          </Fill>
          <SegmentedControl
            label="Speed"
            options={SPEED_OPTIONS}
            value={speed}
            onChange={setSpeed}
          />
          <ToggleChip
            active={skip}
            icon={<Icon icon={skipIcon} />}
            onClick={() => setSkip((s) => !s)}
            tooltip="Skip the stretches the visitor was away"
          >
            Skip away
          </ToggleChip>
        </Line>
      </Inset>
    </Stack>
  );
}

function Facts({ session }: { session: Session }): ReactNode {
  return (
    <Cluster gap="md">
      <Text variant="label">Replay</Text>
      <Text variant="code" tone="muted">
        Visitor {session.visitor}
      </Text>
      <Text variant="caption" tone="muted">
        {new Date(session.startedAt).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        })}
        , {timeOfDay(session.startedAt)}
      </Text>
      <Text variant="caption" tone="muted">
        {countryName(session.country)}
      </Text>
      <Text variant="caption" tone="muted">
        {session.device} · {session.os} · {session.browser}
      </Text>
      <Text variant="caption" tone="muted">
        from {sourceOf(session)}
      </Text>
    </Cluster>
  );
}

/**
 * The device on the stage: the frame laid out at the visitor's viewport and
 * scaled down to fit (never up), under an address bar naming the page.
 */
function Stage({
  viewport,
  host,
  path,
  frame,
  children,
}: {
  viewport: { w: number; h: number };
  host: string;
  path: string;
  frame: ReactNode;
  children: ReactNode;
}): ReactNode {
  const [ref, room] = useElementSize<HTMLDivElement>();
  const scale = Math.max(
    0.05,
    Math.min(
      1,
      (room.width - 2 * STAGE_PAD_PX) / viewport.w,
      (room.height - 2 * STAGE_PAD_PX - BAR_PX) / viewport.h,
    ),
  );
  const w = viewport.w * scale;
  const h = viewport.h * scale;
  return (
    <Center
      ref={ref}
      axis="both"
      className="h-full bg-muted/40 bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-[length:16px_16px]"
    >
      {room.width > 0 && (
        <Clip
          axis="both"
          fill={false}
          className="rounded-lg bg-background shadow-[0_0_0_1px_var(--border),0_18px_50px_-12px_rgb(0_0_0/0.25)]"
          style={{ width: w }}
        >
          <Inset x="sm" className="border-b border-border bg-muted/50">
            <Line className="gap-sm" style={{ height: BAR_PX }}>
              <span aria-hidden className="size-1.5 rounded-full bg-success" />
              <Fill>
                <Text variant="code" tone="muted" className="truncate">
                  <span className="text-faint-foreground">{host}</span>
                  {path}
                </Text>
              </Fill>
              <Text variant="caption" tone="faint" className="tabular-nums">
                {Math.round(scale * 100)}%
              </Text>
            </Line>
          </Inset>
          <div className="relative" style={{ width: w, height: h }}>
            <div
              style={{
                width: viewport.w,
                height: viewport.h,
                transform: `scale(${scale})`,
                transformOrigin: "0 0",
              }}
            >
              {frame}
            </div>
            {children}
          </div>
        </Clip>
      )}
    </Center>
  );
}

/** The recorded page load, replayed: a blank page, the phases filling in as the visitor saw them. */
function LoadVeil({
  load,
  t,
  loadS,
  waiting,
  host,
  onRebuild,
}: {
  load: LoadTiming | null;
  t: number;
  loadS: number;
  waiting: boolean;
  host: string;
  onRebuild: () => void;
}): ReactNode {
  const phases = load ? loadPhases(load) : [];
  const ms = t * 1000;
  return (
    <Layer className="bg-background">
      {loadS > 0 && load && (
        <Placed
          decorative
          x={{ start: 0, size: pct(Math.min(1, t / loadS)) }}
          y={{ start: 0, size: 3 }}
          className="bg-primary"
        />
      )}
      <Center axis="both" className="h-full">
        <Stack gap="xs" align="center" className="text-center">
          {waiting ? (
            <>
              <Text variant="body" tone="muted">
                Waiting for {host}…
              </Text>
              <Button variant="ghost" onClick={onRebuild}>
                Rebuild the local serve
              </Button>
            </>
          ) : load ? (
            <>
              <Text variant="title" className="tabular-nums">
                {seconds(Math.min(ms, loadS * 1000), 2)}
              </Text>
              <Cluster gap="sm">
                {phases.map((p) => (
                  <Text
                    key={p.key}
                    variant="caption"
                    tone={ms >= p.endMs ? "strong" : "faint"}
                    className="tabular-nums"
                  >
                    {p.key === "server"
                      ? `server ${p.endMs} ms`
                      : `${p.key === "paint" ? "first paint" : "ready"} ${seconds(p.endMs, 2)}`}
                  </Text>
                ))}
              </Cluster>
            </>
          ) : (
            <Text variant="body" tone="muted">
              Opening the page…
            </Text>
          )}
        </Stack>
      </Center>
    </Layer>
  );
}

/** A stretch the visitor was away: the page dimmed, how long, and a way past it. */
function AwayScrim({
  step,
  t,
  onSkip,
}: {
  step: Extract<ReplayStep, { kind: "away" }>;
  t: number;
  onSkip: () => void;
}): ReactNode {
  return (
    <Layer className="bg-black/55 text-white backdrop-grayscale">
      <Center axis="both" className="h-full">
        <Stack gap="xs" align="center" className="text-center">
          <Text variant="heading">{GAP_LABEL[step.gap].label}</Text>
          <Text variant="caption" className="tabular-nums text-white/80">
            {span(step.endS - t)} left of {span(step.endS - step.atS)}
          </Text>
          <Button variant="outline" onClick={onSkip}>
            Skip ahead
          </Button>
        </Stack>
      </Center>
    </Layer>
  );
}

/** The actions fired a moment ago, as toasts at the foot of the page. */
function ActionToasts({
  script,
  t,
}: {
  script: ReplayScript;
  t: number;
}): ReactNode {
  const shown = recentActions(script, t);
  if (shown.length === 0) return null;
  return (
    <Pin to="bottom" offset="md" decorative>
      <Stack gap="xs" align="center">
        {shown.map((s) => {
          const ev = presentEvent(s.action.name);
          const props = propsText(s.action.props);
          return (
            <Line
              key={`${s.atS}/${s.action.name}`}
              className="animate-in fade-in slide-in-from-bottom-2 gap-sm rounded-full bg-foreground/90 py-xs pr-md pl-xs text-background shadow-lg"
            >
              <Center
                axis="both"
                className="size-5 rounded-sm bg-primary text-primary-foreground"
              >
                <Icon icon={ev.icon} className="size-3" />
              </Center>
              <Text variant="caption">{ev.label}</Text>
              {props && (
                <Text variant="code" className="text-background/70">
                  {props}
                </Text>
              )}
            </Line>
          );
        })}
      </Stack>
    </Pin>
  );
}

/** Every step of the visit, the one playing marked; a click plays from there. */
function Steps({
  script,
  t,
  onSeek,
}: {
  script: ReplayScript;
  t: number;
  onSeek: (s: number) => void;
}): ReactNode {
  const now = currentStep(script, t);
  return (
    <Inset y="sm">
      <Stack gap="none">
        {script.steps.map((step, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSeek(step.atS)}
            className={cn(
              "w-full px-md py-2xs text-left hover:bg-accent",
              i === now && "bg-primary/10",
              step.kind === "page" && i > 0 && "pt-sm",
            )}
          >
            <Line className="gap-sm">
              <Text
                variant="caption"
                tone="faint"
                className="w-11 text-right tabular-nums"
              >
                {clock(step.atS)}
              </Text>
              <StepMark step={step} />
              <Text variant="caption" tone={i < now ? "faint" : "default"}>
                <StepLabel step={step} script={script} />
              </Text>
            </Line>
          </button>
        ))}
      </Stack>
    </Inset>
  );
}

function StepMark({ step }: { step: ReplayStep }): ReactNode {
  switch (step.kind) {
    case "page":
      return (
        <Center
          axis="both"
          className="size-[18px] rounded-sm bg-primary text-primary-foreground"
        >
          <Icon icon={playIcon} className="size-3" />
        </Center>
      );
    case "section":
      return (
        <Center axis="both" className="size-[18px]">
          <span className="block h-[5px] w-3 rounded-full bg-primary/70" />
        </Center>
      );
    case "action":
      return (
        <Center
          axis="both"
          className="size-[18px] rounded-sm bg-primary/15 text-primary-text"
        >
          <Icon icon={presentEvent(step.action.name).icon} className="size-3" />
        </Center>
      );
    case "away":
      return <GapSwatch kind={step.gap} className="size-[18px] rounded-sm" />;
    case "end":
      return (
        <Center axis="both" className="size-[18px]">
          <span className="block size-2.5 rounded-full bg-faint-foreground/60" />
        </Center>
      );
  }
}

function StepLabel({
  step,
  script,
}: {
  step: ReplayStep;
  script: ReplayScript;
}): ReactNode {
  switch (step.kind) {
    case "page":
      return (
        <>
          <span className="font-mono font-semibold">{step.path}</span>
          {step.page === 0 && script.load !== null && script.loadS > 0 && (
            <span className="text-faint-foreground">
              {" "}
              · loaded in {seconds(script.loadS * 1000, 2)}
            </span>
          )}
        </>
      );
    case "section":
      return step.section;
    case "action": {
      const props = propsText(step.action.props);
      return (
        <>
          {presentEvent(step.action.name).label}
          {props && (
            <span className="font-mono text-faint-foreground"> {props}</span>
          )}
        </>
      );
    }
    case "away":
      return (
        <span className="italic">
          {GAP_LABEL[step.gap].label} · {span(step.endS - step.atS)}
        </span>
      );
    case "end":
      return "Left";
  }
}

/**
 * The visit on one linear axis: each page a segment, the load at its head,
 * stretches away hatched, section ticks above, action dots below, the played
 * part tinted and the playhead. Press or drag to seek.
 */
function Scrubber({
  script,
  t,
  onSeek,
}: {
  script: ReplayScript;
  t: number;
  onSeek: (s: number) => void;
}): ReactNode {
  const total = Math.max(script.totalS, 0.001);
  const f = (s: number) => pct(Math.min(1, Math.max(0, s / total)));
  const seekAt = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - box.left) / box.width) * total);
  };
  return (
    <div
      role="slider"
      aria-label="Replay position"
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(t)}
      tabIndex={0}
      className="relative h-9 cursor-pointer touch-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seekAt(e);
      }}
    >
      {script.loadS > 0 && (
        <Placed
          decorative
          x={{ start: 0, size: f(script.loadS) }}
          y={{ start: 14, size: 8 }}
          className="rounded-l-sm bg-primary"
        />
      )}
      {script.pages.map((p, i) => (
        <Placed
          key={i}
          decorative
          x={{ start: f(p.startS), size: f(p.endS - p.startS) }}
          y={{ start: 14, size: 8 }}
          className={cn(
            "border-l-2 border-background",
            i % 2 === 0 ? "bg-primary/25" : "bg-primary/40",
          )}
          title={p.path}
        />
      ))}
      {script.steps.map((s, i) => {
        switch (s.kind) {
          case "away":
            return (
              <Placed
                key={i}
                decorative
                x={{ start: f(s.atS), size: f(s.endS - s.atS) }}
                y={{ start: 14, size: 8 }}
                className={GAP_FILL[s.gap]}
              />
            );
          case "section":
            return (
              <Placed
                key={i}
                decorative
                x={{ start: f(s.atS), size: 2 }}
                y={{ start: 11, size: 14 }}
                className="rounded-full bg-primary"
              />
            );
          case "action":
            return (
              <Placed
                key={i}
                decorative
                x={{ start: f(s.atS), size: 7, shift: -3.5 }}
                y={{ start: 26, size: 7 }}
                className="rounded-full bg-success"
              />
            );
          case "page":
          case "end":
            return null;
        }
      })}
      <Placed
        decorative
        x={{ start: 0, size: f(t) }}
        y={{ start: 14, size: 8 }}
        className="rounded-l-sm bg-foreground/15"
      />
      <Placed
        decorative
        x={{ start: f(t), size: 2, shift: -1 }}
        y={{ start: 6, size: 24 }}
        className="rounded-full bg-foreground"
      />
    </div>
  );
}
