import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  useActivateApp,
  useSurfaceFocused,
} from "@plugins/apps-core/plugins/tabs/web";
import { useAppUsageSummary } from "@plugins/apps-core/plugins/app-usage/web";
import { useSetConfig } from "@plugins/config_v2/web";
import { AMBIENT_TRACKS } from "@plugins/music/plugins/ambient/core";
import { useAmbient } from "@plugins/music/plugins/ambient/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  activationHref,
  runActivation,
  type Gesture,
} from "@plugins/primitives/plugins/link-gesture/core";
import {
  activationProps,
  openInBrowserTab,
} from "@plugins/primitives/plugins/link-gesture/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { prefersReducedMotion } from "@plugins/primitives/plugins/css/plugins/motion/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  applyMove,
  residentOf,
  type MoveTarget,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import {
  movePlot,
  placementWrites,
} from "@plugins/apps/plugins/isle/plugins/plots/core";
import {
  IsleEngine,
  type ClickModifiers,
} from "@plugins/apps/plugins/isle/plugins/renderer/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { isleApp } from "@plugins/apps/plugins/isle/plugins/shell/core";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { DAY_PHASE_PHRASE, isleConfig, lifeOfSummary } from "../../core";
import { useTimeOfDay } from "../internal/time";
import { useIsleWorld, type Resident } from "../internal/use-isle-world";
import { useStageDeadline } from "../internal/stage-deadline";
import "./isle.css";

const playIcon = symbol("play-arrow");
const placeIcon = symbol("landscape");

/** Once Start was pressed in this page, coming back to the island skips the title card. */
let startedThisPage = false;

interface Entering {
  readonly r: Resident;
  /** The gesture that asked for it, run once the iris has opened. */
  readonly gesture: Gesture;
  readonly x: number;
  readonly y: number;
  on: boolean;
}

/**
 * The island: the canvas engine (`IsleEngine`, mounted once), and over it the
 * title card (Start, held back — a rendered loading state — until the world is
 * read and the home island drawn), the where-chip, the prompt card for the
 * building at the hero's door, the iris an app opens through, and a visually
 * hidden list of links mirroring the buildings.
 */
export function IsleView() {
  const world = useIsleWorld();
  const time = useTimeOfDay(world.kind === "ready" ? world.time : "auto");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [measure, size] = useElementSize<HTMLDivElement>();
  const engineRef = useRef<IsleEngine | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [started, setStarted] = useState(startedThisPage);
  const [near, setNear] = useState<string | null>(null);
  const [where, setWhere] = useState<{
    island: string;
    district: string | null;
  } | null>(null);
  const [entering, setEntering] = useState<Entering | null>(null);
  const activate = useActivateApp();
  const setConfig = useSetConfig(isleConfig);
  const focused = useSurfaceFocused();
  const usage = useAppUsageSummary();
  const move = useEndpointMutation(movePlot);
  const ready = world.kind === "ready";
  const residents = ready ? world.residents : [];
  const residentOfId = (id: string) =>
    residents.find((r) => r.app.id === id) ?? null;
  const canStart = ready && drawn;
  const playing = started && canStart;
  // the stage the title card waits on, failed once it outlasts its deadline
  const waitingOn =
    canStart || world.kind === "error"
      ? null
      : world.kind === "loading"
        ? world.what
        : "Drawing the island";
  const stuck = useStageDeadline(waitingOn, focused);
  // the island's music: unlocked by Start (a user gesture), playing while the
  // config says so and this tab is the one on screen
  const ambient = useAmbient({
    mood: ready ? world.mood : "lofi",
    on: playing && focused && ready && world.music,
  });
  const unlockSound = () => ambient.unlock();
  const toggleMusic = () => {
    if (world.kind !== "ready") return;
    ambient.unlock();
    if (ambient.status === "locked" && world.music) return;
    setConfig("music", !world.music);
  };
  const sfx = ambient.sfx;

  const enter = useEventCallback(
    (
      appId: string,
      at: { x: number; y: number } | null,
      click: ClickModifiers,
    ) => {
      const r = residentOfId(appId);
      if (!r || entering) return;
      const activation = activate(r.entry);
      if (click.elsewhere) {
        const href = activationHref(activation);
        if (href) openInBrowserTab(href());
        return;
      }
      const gesture: Gesture = { keepOthers: click.keepOthers };
      sfx.enter();
      if (prefersReducedMotion()) {
        runActivation(activation, gesture);
        return;
      }
      setEntering({
        r,
        gesture,
        x: at?.x ?? size.width / 2,
        y: at?.y ?? size.height / 2,
        on: false,
      });
    },
  );

  const near_ = useEventCallback((id: string | null) => {
    setNear(id);
    if (id) sfx.blip(true);
  });

  const onMove = useEventCallback((appId: string, target: MoveTarget) => {
    if (world.kind !== "ready") return;
    const rs = world.residents.map((r) => residentOf(r.app, r.app.spec));
    const next = applyMove(world.model, world.placement, rs, appId, target);
    move.mutate(
      {
        body: {
          world: world.world,
          writes: placementWrites(world.placement, next),
        },
      },
      {
        onSuccess: (res) => {
          if (res.outcome === "stale") engineRef.current?.cancelMove();
        },
        onError: () => engineRef.current?.cancelMove(),
      },
    );
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) throw new Error("IsleView: stage not mounted");
    const engine = new IsleEngine(
      stage,
      {
        onReady: () => setDrawn(true),
        onNear: (id) => near_(id),
        onStep: () => sfx.step(),
        onHover: (id) => {
          if (id) sfx.blip(false);
        },
        onEnter: (id, at, click) => enter(id, at, click),
        onMove: (id, target) => onMove(id, target),
        onWhere: (island, district) => setWhere({ island, district }),
      },
      { reducedMotion: prefersReducedMotion(), workers: true },
    );
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, [enter, onMove, near_, sfx]);

  useEffect(() => {
    if (world.kind !== "ready") return;
    engineRef.current?.setWorld(
      world.model,
      world.placement,
      world.residents.map((r) => r.app),
    );
  }, [world]);

  useEffect(() => engineRef.current?.setTime(time), [time]);
  // signs of life from app usage — none while it is not known yet
  if (usage.status === "error") throw usage.error;
  const usageRows = usage.status === "ready" ? usage.data : null;
  useEffect(() => {
    engineRef.current?.setLife(
      usageRows ? lifeOfSummary(usageRows, new Date()) : null,
    );
  }, [usageRows]);
  // the music ducks under an app opening
  const isEntering = entering !== null;
  useEffect(() => ambient.duck(isEntering), [ambient, isEntering]);
  useEffect(() => engineRef.current?.resize(size.width, size.height), [size]);

  useEffect(() => {
    if (!started || !canStart) return;
    startedThisPage = true;
    engineRef.current?.start();
    focusElement(stageRef.current, { reveal: false });
  }, [started, canStart]);

  // the iris opens on the next frame, so its transition runs
  useEffect(() => {
    if (!entering || entering.on) return;
    const id = requestAnimationFrame(() =>
      setEntering({ ...entering, on: true }),
    );
    return () => cancelAnimationFrame(id);
  }, [entering]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!started) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        unlockSound();
        setStarted(true);
      }
      return;
    }
    if (
      (e.key === "m" || e.key === "M") &&
      !e.repeat &&
      !e.metaKey &&
      !e.ctrlKey
    ) {
      e.preventDefault();
      toggleMusic();
      return;
    }
    if (
      (e.key === "e" || e.key === "E" || e.key === "Enter") &&
      near &&
      !e.repeat
    ) {
      e.preventDefault();
      enter(near, engineRef.current?.anchor(near) ?? null, {
        elsewhere: false,
        keepOthers: e.altKey,
      });
    }
  }

  if (world.kind === "error") throw world.error;
  if (stuck) throw stuck;
  const nearR = near ? residentOfId(near) : null;
  const showTitle = !(started && canStart);
  return (
    <div className="isle-root" data-time={time}>
      <div
        ref={(el) => {
          stageRef.current = el;
          measure(el);
        }}
        className="isle-stage"
        tabIndex={0}
        role="application"
        aria-label={`${isleApp.name}: walk with the arrow keys, press E at a door to open its app`}
        onKeyDown={onKeyDown}
      />
      {started && where ? (
        <div className="isle-hud isle-where">
          <div className="isle-where-dot">
            <Icon icon={placeIcon} />
          </div>
          <div>
            <b>{where.island}</b>
            <small>
              {where.district
                ? `${where.district} · ${DAY_PHASE_PHRASE[time]}`
                : DAY_PHASE_PHRASE[time]}
            </small>
          </div>
        </div>
      ) : null}
      {started && ready ? (
        <button
          type="button"
          className={
            ambient.status === "playing"
              ? "isle-hud isle-radio"
              : "isle-hud isle-radio isle-off"
          }
          title="Music (M)"
          aria-pressed={ambient.status === "playing"}
          onClick={toggleMusic}
        >
          <span className="isle-radio-disc" />
          <span className="isle-radio-eq" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="isle-radio-track">
            {ambient.status === "playing"
              ? AMBIENT_TRACKS[world.mood]
              : world.music && ambient.status === "locked"
                ? "music"
                : "muted"}
          </span>
        </button>
      ) : null}
      <div
        className={
          nearR && started
            ? "isle-hud isle-prompt isle-on"
            : "isle-hud isle-prompt"
        }
        aria-hidden={!nearR}
      >
        {nearR ? (
          <button
            type="button"
            className="isle-card"
            onClick={(e) =>
              enter(
                nearR.app.id,
                engineRef.current?.anchor(nearR.app.id) ?? null,
                {
                  elsewhere: e.metaKey || e.ctrlKey,
                  keepOthers: e.altKey,
                },
              )
            }
          >
            <span
              className="isle-prompt-icon"
              style={{ "--isle-hue": nearR.app.hue } as CSSProperties}
            >
              <Icon icon={nearR.entry.app.icon} />
            </span>
            <span className="isle-prompt-text">
              <b>{nearR.app.name}</b>
              <small>Open</small>
            </span>
            <kbd>E</kbd>
          </button>
        ) : null}
      </div>
      {entering ? (
        <div
          className={entering.on ? "isle-iris isle-on" : "isle-iris"}
          style={
            {
              "--isle-hue": entering.r.app.hue,
              "--ix": `${entering.x}px`,
              "--iy": `${entering.y}px`,
            } as CSSProperties
          }
          onTransitionEnd={(e) => {
            if (e.target !== e.currentTarget || !entering.on) return;
            runActivation(activate(entering.r.entry), entering.gesture);
          }}
        >
          <div className="isle-iris-app">
            <Icon icon={entering.r.entry.app.icon} />
            <b>{entering.r.app.name}</b>
          </div>
        </div>
      ) : null}
      {showTitle ? (
        <div
          className={canStart ? "isle-title" : "isle-title isle-wait"}
          onClick={() => {
            unlockSound();
            setStarted(true);
          }}
        >
          <div className="isle-title-inner">
            <h1>{PRODUCT_NAME}</h1>
            <p>a small world of apps</p>
            {/* the stage it waits on is the button's tooltip; its words stay Start */}
            <button
              type="button"
              disabled={!canStart}
              aria-busy={!canStart}
              title={waitingOn ?? undefined}
            >
              <Icon icon={playIcon} />
              Start
            </button>
          </div>
        </div>
      ) : null}
      <nav className="isle-sr" aria-label="Buildings on the island">
        <ul>
          {residents.map((r) => (
            <li key={r.app.id}>
              <a
                href={r.entry.app.basePath}
                {...activationProps(activate(r.entry))}
              >
                {r.app.name}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
