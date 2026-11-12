import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  SURFACE_LEVELS,
  cn,
  isPointerModality,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { PortalHost } from "@plugins/primitives/plugins/overlay/plugins/portal-host/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import {
  targetClaimsKey,
  usePlayPauseShortcut,
  useSurfaceShortcuts,
} from "@plugins/primitives/plugins/shortcuts/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  SLIM,
  TOUCH_HIDE_MS,
  TOUCH_QUERY,
  VOLUME_CLOSE_MS,
} from "../internal/geometry";
import {
  PLAYER_KEYS,
  matchesKeys,
  type PlayerAction,
} from "../internal/keymap";
import {
  RATE_KEY_STEP,
  VOLUME_KEY_STEP,
  VOLUME_STEP,
  audibleVolume,
  clampRate,
  digitTarget,
  rateShort,
  skipSeconds,
  skipTarget,
  snapRate,
} from "../internal/math";
import { mediaPlayerThemeScope } from "../internal/theme";
import { useIdle } from "../internal/use-idle";
import {
  playMedia,
  seekMedia,
  setMediaLoop,
  setMediaRate,
  setMediaVolume,
  toggleMediaMute,
  togglePlayback,
} from "../internal/media-ops";
import { useMediaState } from "../internal/use-media-state";
import { ControlPill } from "./control-pill";
import { SettingsPanel } from "./settings-panel";
import { VolumeCapsule } from "./volume-capsule";
import type { SetRate } from "./speed-dial";
import "../internal/media-player.css";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { useMediaQuery } from "@plugins/primitives/plugins/dom/plugins/render-mode/web";
import { TouchControls } from "./touch-controls";

const playIcon = symbol("play-arrow");
const pauseIcon = symbol("pause");
const backIcon = symbol("replay");
const forwardIcon = symbol("forward-media");
const loopIcon = symbol("repeat");

/** The centre flash and the big play button are float glass, like the pill. */
const FLASH_GLASS = SURFACE_LEVELS.float;

/** Marks a player root: a key from outside every player finds its player by it. */
const PLAYER_ATTR = "data-media-player";

export interface PlayerProps {
  kind: "video" | "audio";
  src: string;
  label: string;
  autoPlay: boolean;
  poster?: string;
  onError?(error: MediaError | null): void;
  onPlay?(): void;
  className?: string;
  /** Picture in picture, owned by `MediaPlayer` (it moves this whole tree). `null` = not offered. */
  pip: { open: boolean; toggle(): void } | null;
  /** The media element, for `MediaPlayer`'s picture-in-picture fallback. */
  mediaRef(el: HTMLMediaElement | null): void;
  /** The player's root element, which `MediaPlayer` measures for its window. */
  rootRef(el: HTMLElement | null): void;
}

/** The centre feedback: what just happened, flashed over the picture. */
interface Flash {
  n: number;
  content: ReactNode;
  wide: boolean;
}

/** Whether a keystroke landed inside this player (its root has focus within). */
function keyInside(root: HTMLElement | null, e: KeyboardEvent): boolean {
  return root !== null && e.target instanceof Node && root.contains(e.target);
}

/**
 * Whether Space is this player's. Space landing inside a player belongs to
 * it; from anywhere else on the surface (the link that opened a file, the
 * page around a block) it goes to the playing player there, else the first —
 * so two players on one page never both answer. Only Space reaches that far:
 * the player's other keys (arrows, digits, letters) are its own only while
 * focus is inside it, never a page's (a page editor walks its blocks with the
 * arrows).
 */
function spaceIsFor(root: HTMLElement | null, e: KeyboardEvent): boolean {
  if (root === null) return false;
  const target = e.target instanceof Element ? e.target : null;
  const owner = target?.closest(`[${PLAYER_ATTR}]`);
  if (owner) return owner === root;
  const surface = root.getAttribute("data-surface") ?? "";
  const peers = Array.from(
    root.ownerDocument.querySelectorAll<HTMLElement>(`[${PLAYER_ATTR}]`),
  ).filter((p) => (p.getAttribute("data-surface") ?? "") === surface);
  const pick = peers.find((p) => p.hasAttribute("data-playing")) ?? peers[0];
  return pick === root;
}

/**
 * Space on one of the player's own buttons the user navigated to by keyboard
 * is that button's (it activates on Space). A button merely focused by a
 * click — Full screen, say — does not keep Space: it plays / pauses.
 */
function spaceOnOwnButton(root: HTMLElement | null, e: KeyboardEvent): boolean {
  const target = e.target instanceof Element ? e.target : null;
  const button = target?.closest("button, [role=button], [role=switch]");
  return (
    root !== null &&
    button !== null &&
    button !== undefined &&
    root.contains(button) &&
    !isPointerModality(root.ownerDocument)
  );
}

/**
 * Whether the player's root is in full screen — asked of the document the
 * player is in now (the page, or its own picture-in-picture window), and
 * re-subscribed when it moves.
 */
function useFullscreenOf(
  root: HTMLElement | null,
  doc: Document | null,
): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (doc === null) return () => undefined;
      doc.addEventListener("fullscreenchange", notify);
      return () => doc.removeEventListener("fullscreenchange", notify);
    },
    [doc],
  );
  // Reads only the elements handed in — none in a server render, which no
  // fullscreen can hold — so it serves a server render too.
  const read = () => root !== null && doc?.fullscreenElement === root;
  return useSyncExternalStore(subscribe, read, read);
}

/** The focusable controls of the pill, in tab order. */
const FOCUSABLE = 'button:not([disabled]), [tabindex="0"], input';

/** Where a floating panel sits: above the pill, by the given gap. */
function placeAbove(
  root: HTMLElement,
  pill: HTMLElement,
  anchor: HTMLElement,
  align: "center" | "right",
  width: number,
): CSSProperties {
  const p = root.getBoundingClientRect();
  const b = anchor.getBoundingClientRect();
  const top = pill.getBoundingClientRect().top;
  const bottom = p.bottom - top + SLIM.gap;
  if (align === "center")
    return { bottom, left: b.left - p.left + b.width / 2 - width / 2 };
  return { bottom, right: Math.max(10, p.right - b.right - 8) };
}

export function Player({
  kind,
  src,
  label,
  autoPlay,
  poster,
  onError,
  onPlay,
  className,
  pip,
  mediaRef,
  rootRef,
}: PlayerProps) {
  const [el, setEl] = useState<HTMLMediaElement | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const speakerRef = useRef<HTMLSpanElement>(null);
  const gearRef = useRef<HTMLSpanElement>(null);
  const volumeRef = useRef<HTMLElement>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const volumeSliderRef = useRef<HTMLInputElement>(null);
  const resumeAfterSeek = useRef(false);

  const media = useMediaState(el);
  const volume = audibleVolume(media.volume, media.muted);
  const [rate, setRateState] = useState(1);
  const [settle, setSettle] = useState(false);
  const [loop, setLoop] = useState(false);
  const [remaining, setRemaining] = useState(true);
  const [settings, setSettings] = useState<CSSProperties | null>(null);
  const [volumeAt, setVolumeAt] = useState<CSSProperties | null>(null);
  const [seeking, setSeeking] = useState(false);
  const [volumeDragging, setVolumeDragging] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  // The document the player is in now: the page, or its own window.
  const doc = root?.ownerDocument ?? null;
  const nativeFullscreen = useFullscreenOf(root, doc);
  // Where the browser cannot put an element in full screen (an iPhone: only a
  // <video> itself, with the browser's own controls), the player fills the
  // window instead, its controls with it.
  const [filling, setFilling] = useState(false);
  const fullscreen = nativeFullscreen || filling;
  const surface = useSurfaceTabId();
  // A touch screen gets the touch controls (`TouchControls`): a tap shows
  // them rather than playing. Audio keeps its bar — it has no picture to tap.
  const touch = useMediaQuery(TOUCH_QUERY, false) && kind === "video";

  // Moving between the page and the picture-in-picture window closes the
  // panels: each was placed, and listens, in the document it opened in.
  // (Adjusted during render — React's pattern for state that follows a value.)
  const pipOpen = pip?.open === true;
  const [wasPip, setWasPip] = useState(pipOpen);
  if (wasPip !== pipOpen) {
    setWasPip(pipOpen);
    setSettings(null);
    setVolumeAt(null);
  }
  // Fetch the whole file only once it is wanted: on autoplay, or from the
  // first play. Until then the metadata (length, first frame) is enough.
  const [played, setPlayed] = useState(false);
  if (!media.paused && !played) setPlayed(true);

  const settingsOpen = settings !== null;
  const volumeOpen = volumeAt !== null;
  // Touch: paused, no timer hides the controls (a paused picture is never left
  // bare on its own), but a tap still does; playing, they hide after a short
  // spell of no taps (TOUCH_HIDE_MS).
  const { idle, wake, rest } = useIdle({
    keepUp: touch
      ? settingsOpen || seeking
      : settingsOpen || volumeOpen || seeking,
    noTimer: touch && media.paused,
    enabled: kind === "video",
    quietMs: touch ? TOUCH_HIDE_MS : undefined,
  });

  useEffect(() => {
    if (el) setMediaLoop(el, loop);
  }, [el, loop]);

  const show = (content: ReactNode, wide = false) =>
    setFlash((f) => ({ n: (f?.n ?? 0) + 1, content, wide }));

  const setRate: SetRate = useCallback(
    (r, opts) => {
      const snap = opts?.snap ?? true;
      const next = snap ? snapRate(r) : clampRate(r);
      setRateState(next);
      setSettle(snap);
      if (el) setMediaRate(el, next);
    },
    [el],
  );

  const setVolume = (v: number) => {
    if (el) setMediaVolume(el, v);
  };

  const toggle = () => {
    if (el) togglePlayback(el);
  };

  const toggleFullscreen = () => {
    if (root === null || doc === null) return;
    if (filling) setFilling(false);
    else if (doc.fullscreenElement) void doc.exitFullscreen();
    else if (doc.fullscreenEnabled) void root.requestFullscreen();
    else setFilling(true);
  };

  const openSettings = (open: boolean) => {
    const pill = pillRef.current;
    const gear = gearRef.current;
    // The touch sheet sits at the bottom of the screen: nothing to place.
    if (open && touch) setSettings({});
    else if (open && root && pill && gear) {
      setSettings(placeAbove(root, pill, gear, "right", 0));
    } else setSettings(null);
    wake();
  };

  const volumeDraggingRef = useLatestRef(volumeDragging);
  const volumeClose = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const openVolume = (open: boolean) => {
    clearTimeout(volumeClose.current);
    const pill = pillRef.current;
    const speaker = speakerRef.current;
    if (open) {
      if (root && pill && speaker)
        setVolumeAt(placeAbove(root, pill, speaker, "center", 34));
    } else {
      volumeClose.current = setTimeout(() => {
        if (volumeDraggingRef.current) return;
        setVolumeAt(null);
      }, VOLUME_CLOSE_MS);
    }
    wake();
  };
  useEffect(() => () => clearTimeout(volumeClose.current), []);

  // Keyboard focus and the capsule: it is open while focus is on the
  // speaker or in the capsule, and sits right after the speaker in the tab
  // order although it is drawn outside the pill.
  const inVolumeControls = (node: EventTarget | null) =>
    node instanceof Node &&
    (speakerRef.current?.contains(node) === true ||
      volumeRef.current?.contains(node) === true);
  const onVolumeBlur = (e: ReactFocusEvent<HTMLElement>) => {
    if (!inVolumeControls(e.relatedTarget)) openVolume(false);
  };
  const tabFromCapsule = (back: boolean) => {
    const speaker = speakerRef.current?.querySelector("button");
    if (back || !speaker) {
      focusElement(speaker, { reveal: false });
      return;
    }
    const controls = Array.from(
      pillRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    focusElement(controls[controls.indexOf(speaker) + 1], { reveal: false });
  };

  // A press anywhere outside the panel and its gear closes the settings —
  // in whichever document the player is in (the page, or its own window).
  useEffect(() => {
    if (!settingsOpen || doc === null) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      if (
        t &&
        (settingsRef.current?.contains(t) || gearRef.current?.contains(t))
      )
        return;
      setSettings(null);
    };
    doc.addEventListener("pointerdown", onDown);
    return () => doc.removeEventListener("pointerdown", onDown);
  }, [settingsOpen, doc]);

  // The mouse wheel over the speaker or the capsule sets the volume, and
  // must not scroll the page — React's wheel handlers are passive.
  useEffect(() => {
    const targets = [speakerRef.current, volumeRef.current];
    const onWheel = (e: WheelEvent) => {
      if (!el) return;
      e.preventDefault();
      setMediaVolume(
        el,
        audibleVolume(el.volume, el.muted) - Math.sign(e.deltaY) * VOLUME_STEP,
      );
    };
    for (const t of targets)
      t?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      for (const t of targets) t?.removeEventListener("wheel", onWheel);
    };
  }, [el]);

  const run = useEventCallback((action: PlayerAction) => {
    if (!el) return;
    switch (action.kind) {
      case "toggle":
        toggle();
        show(<Icon icon={el.paused ? pauseIcon : playIcon} />);
        break;
      case "skip":
        seekMedia(
          el,
          skipTarget(
            el.currentTime,
            action.direction * skipSeconds(rate),
            el.duration,
          ),
        );
        show(<Icon icon={action.direction < 0 ? backIcon : forwardIcon} />);
        break;
      case "volume": {
        const base =
          action.delta > 0 ? audibleVolume(el.volume, el.muted) : el.volume;
        setVolume(base + action.delta * VOLUME_KEY_STEP);
        show(`${Math.round(el.volume * 100)}%`, true);
        break;
      }
      case "mute":
        toggleMediaMute(el);
        break;
      case "fullscreen":
        toggleFullscreen();
        break;
      case "pip":
        setSettings(null);
        pip?.toggle();
        break;
      case "loop":
        setLoop((l) => !l);
        show(<Icon icon={loopIcon} />);
        break;
      case "speed": {
        const next = snapRate(rate + action.delta * RATE_KEY_STEP);
        setRate(next);
        show(rateShort(next), true);
        break;
      }
      case "jump":
        seekMedia(el, digitTarget(action.digit, el.duration));
        break;
      case "close-settings": {
        setSettings(null);
        focusElement(gearRef.current?.querySelector("button"), {
          reveal: false,
        });
        break;
      }
    }
    wake();
  });

  // Keys: Space through the shared play/pause binding, the rest as surface
  // shortcuts — each eligible only when the key is this player's.
  const when = useEventCallback(
    (e: KeyboardEvent) => spaceIsFor(root, e) && !spaceOnOwnButton(root, e),
  );
  const onSpace = useEventCallback(() => run({ kind: "toggle" }));
  usePlayPauseShortcut(el === null ? null : onSpace, when);
  const settingsOpenNow = useEventCallback(() => settingsOpen);
  const descriptors = useMemo(
    () =>
      PLAYER_KEYS.filter((k) => kind === "video" || !k.videoOnly).map((k) => ({
        id: `media-player.${k.id}`,
        keys: k.keys,
        label: k.label,
        group: "Playback",
        when: (e: KeyboardEvent) =>
          keyInside(root, e) &&
          (k.action.kind !== "close-settings" || settingsOpenNow()),
        handler: () => run(k.action),
      })),
    [kind, root, run, settingsOpenNow],
  );
  useSurfaceShortcuts(descriptors);

  // In its own picture-in-picture window the page's shortcut listener does
  // not hear the keys, so the player answers them itself, from the same table.
  const inOwnWindow = pip?.open === true;
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!inOwnWindow || e.defaultPrevented) return;
    const native = e.nativeEvent;
    if (targetClaimsKey(native)) return;
    if (e.key === " ") {
      if (spaceOnOwnButton(root, native)) return;
      e.preventDefault();
      run({ kind: "toggle" });
      return;
    }
    const hit = PLAYER_KEYS.find(
      (k) =>
        (kind === "video" || !k.videoOnly) &&
        matchesKeys(k.keys, native) &&
        (k.action.kind !== "close-settings" || settingsOpen),
    );
    if (!hit) return;
    e.preventDefault();
    run(hit.action);
  };

  // A seek-bar drag pauses the media and resumes it after.
  const onSeekDrag = (dragging: boolean) => {
    if (!el) return;
    if (dragging) {
      resumeAfterSeek.current = !el.paused;
      el.pause();
    } else if (resumeAfterSeek.current) playMedia(el);
    setSeeking(dragging);
    wake();
  };

  const setRootRef = (node: HTMLElement | null) => {
    setRoot(node);
    rootRef(node);
  };
  const setMediaRef = (node: HTMLMediaElement | null) => {
    setEl(node);
    mediaRef(node);
  };

  const common = {
    ref: setMediaRef,
    className: "mp-media",
    src,
    autoPlay,
    preload: autoPlay || played ? "auto" : "metadata",
    onError: (e: SyntheticEvent<HTMLMediaElement>) =>
      onError?.(e.currentTarget.error),
    onPlay: () => onPlay?.(),
  } as const;

  return (
    <Theme
      name={mediaPlayerThemeScope}
      surface="none"
      ref={setRootRef}
      tabIndex={0}
      role="group"
      aria-label={label}
      {...{ [PLAYER_ATTR]: "" }}
      data-kind={kind}
      data-surface={surface ?? ""}
      // Scrubbing pauses the media, but the player is not paused: no big
      // play button over the frame being scrubbed to.
      data-paused={(media.paused && !seeking) || undefined}
      // Never played yet: the big play button is the poster's call to start;
      // once it has played, a pause leaves the picture clear.
      data-unplayed={!played || undefined}
      data-playing={!media.paused || undefined}
      data-idle={idle || undefined}
      data-settings-open={settingsOpen || undefined}
      data-volume-open={volumeOpen || undefined}
      data-touch={touch || undefined}
      data-filling={filling || undefined}
      className={cn(
        "mp",
        kind === "video" && "rounded-xl bg-background shadow-lg",
        className,
      )}
      // Touch has no resting pointer: taps show and hide the controls.
      onPointerMove={touch ? undefined : wake}
      onPointerLeave={touch ? undefined : rest}
      onKeyDown={onKeyDown}
    >
      <PortalHost>
        {kind === "video" ? (
          <video
            {...common}
            poster={poster}
            playsInline
            onClick={
              touch
                ? undefined
                : () => {
                    if (settingsOpen) return openSettings(false);
                    run({ kind: "toggle" });
                  }
            }
            onDoubleClick={touch ? undefined : toggleFullscreen}
          />
        ) : (
          <audio {...common} />
        )}
        {kind === "video" && <CenterFlash flash={flash} />}
        {touch ? (
          <>
            <TouchControls
              el={el}
              label={label}
              shown={!idle}
              paused={media.paused && !seeking}
              ended={media.ended}
              duration={media.duration}
              volume={volume}
              rate={rate}
              remaining={remaining}
              fullscreen={fullscreen}
              settingsOpen={settingsOpen}
              onTap={() => (idle ? wake() : rest())}
              onWake={wake}
              onPlay={toggle}
              onSkip={(seconds) => {
                if (el)
                  seekMedia(
                    el,
                    skipTarget(el.currentTime, seconds, el.duration),
                  );
              }}
              onMute={() => run({ kind: "mute" })}
              onToggleRemaining={() => setRemaining((r) => !r)}
              onSettings={() => openSettings(!settingsOpen)}
              onFullscreen={toggleFullscreen}
              onSeek={(t) => {
                if (el) seekMedia(el, t);
              }}
              onSeekDrag={onSeekDrag}
              gearRef={gearRef}
            />
            <div
              className="mp-t-scrim"
              data-open={settingsOpen || undefined}
              aria-hidden
            />
          </>
        ) : (
          <>
            {kind === "video" && <BigPlay onPlay={toggle} />}
        <ControlPill
          ref={pillRef}
          kind={kind}
          el={el}
          paused={media.paused && !seeking}
          duration={media.duration}
          volume={volume}
          rate={rate}
          remaining={remaining}
          settingsOpen={settingsOpen}
          volumeOpen={volumeOpen}
          fullscreen={fullscreen}
          onPlay={toggle}
          onMute={() => run({ kind: "mute" })}
          onSeek={(t) => {
            if (el) seekMedia(el, t);
          }}
              onSeekDrag={onSeekDrag}
          onToggleRemaining={() => setRemaining((r) => !r)}
          onSettings={() => openSettings(!settingsOpen)}
          onFullscreen={toggleFullscreen}
          speakerRef={speakerRef}
          onSpeakerEnter={() => openVolume(true)}
          onSpeakerLeave={() => openVolume(false)}
          onSpeakerFocus={() => openVolume(true)}
          onSpeakerBlur={onVolumeBlur}
          onSpeakerKeyDown={(e) => {
            if (e.key !== "Tab" || e.shiftKey || !volumeOpen) return;
            e.preventDefault();
            focusElement(volumeSliderRef.current, { reveal: false });
          }}
          gearRef={gearRef}
        />
        <VolumeCapsule
          ref={volumeRef}
          open={volumeOpen}
          place={volumeAt ?? {}}
          volume={volume}
          onVolume={setVolume}
          onPointerEnter={() => openVolume(true)}
          onPointerLeave={() => openVolume(false)}
          onBlur={onVolumeBlur}
          onTab={tabFromCapsule}
          sliderRef={volumeSliderRef}
          onDragChange={(dragging) => {
            setVolumeDragging(dragging);
            if (!dragging && !volumeRef.current?.matches(":hover"))
              openVolume(false);
          }}
        />
          </>
        )}
        <SettingsPanel
          ref={settingsRef}
          open={settingsOpen}
          place={settings ?? {}}
          rate={rate}
          settle={settle}
          setRate={setRate}
          loop={loop}
          onLoop={() => setLoop((l) => !l)}
          sheet={touch}
          pip={
            kind === "video" && pip
              ? { open: pip.open, onToggle: () => run({ kind: "pip" }) }
              : null
          }
        />
      </PortalHost>
    </Theme>
  );
}

/** The flash over the picture: an icon (or a figure, wide) that grows and fades once. */
function CenterFlash({ flash }: { flash: Flash | null }) {
  if (flash === null) return null;
  return (
    <div
      key={flash.n}
      className={cn("mp-flash rounded-full", FLASH_GLASS)}
      data-wide={flash.wide || undefined}
      data-go=""
      aria-hidden
    >
      {typeof flash.content === "string" ? (
        <Text variant="subheading" className="tabular-nums">
          {flash.content}
        </Text>
      ) : (
        flash.content
      )}
    </div>
  );
}

/** The big centre play button, until the first play. */
function BigPlay({ onPlay }: { onPlay(): void }) {
  return (
    <button
      type="button"
      aria-label="Play"
      className={cn("mp-big-play rounded-full", FLASH_GLASS)}
      onClick={onPlay}
    >
      <Icon icon={playIcon} />
    </button>
  );
}
