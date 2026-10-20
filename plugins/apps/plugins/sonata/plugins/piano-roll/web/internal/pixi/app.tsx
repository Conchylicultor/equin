import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
/**
 * PianoRollCanvas — the React ↔ Pixi bridge. Owns the `Application` lifecycle
 * and forwards every prop change to the imperative {@link PianoRollScene}
 * handle through narrow, separately-keyed layout effects. The per-frame cursor
 * is NOT a prop: the parent subscribes to the cursor store and calls
 * `scene.setScroll` directly (see piano-roll.tsx `applyCursor`), so a frame
 * never re-renders this component. These effects fire only on real input
 * changes (resize, score, seek, labels, theme).
 *
 * LIFECYCLE (the #1 Pixi-v8-in-React footgun): `Application.init()` is async,
 * but StrictMode double-mounts effects synchronously — destroying the app
 * before init settles crashes inside Pixi, and destroying it never leaks a
 * WebGL context. The fix is the plan's disposed-flag pattern: cleanup flips
 * `disposed` immediately (so the init continuation becomes a no-op) and chains
 * the actual destroy AFTER the init promise settles.
 *
 * The canvas is transparent (`backgroundAlpha: 0` — the lane div's own ground
 * shows through, which is what lets the active LOOK paint the lane in CSS,
 * paper grain and all, without a Pixi layer under the notes) and inert
 * (`pointer-events: none`, all Pixi event features off) — drag-to-scrub and
 * every other interaction stays on the DOM lane wrapper.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Application, isWebGLSupported, isWebGPUSupported } from "pixi.js";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import type {
  Note,
  PitchGuide,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { SonataLook } from "@plugins/apps/plugins/sonata/plugins/look/core";
import type { NoteVisual } from "../../components/geometry";
import type { BarMarker } from "./grid";
import { createPianoRollScene, type PianoRollScene } from "./scene";
import { loadLabelFonts } from "./labels";
import { watchThemeColors } from "./css-color";

export interface PianoRollCanvasProps {
  /** Lane size in CSS px (from the lane's ResizeObserver). */
  width: number;
  height: number;
  /** The keys' part of the lane, from its left edge (≤ `width`): where notes,
   *  pitch rules and labels lay out. The bar rules run the whole `width`. */
  notesWidth: number;
  /** Cursor-invariant note geometry (authored space; see geometry.ts). */
  visuals: NoteVisual[];
  bars: BarMarker[];
  pitchLines: readonly PitchGuide[];
  /** Beat-domain notes for the onset tracker (see scene.ts bridge note). */
  scoreNotes: Note[];
  showLabels: boolean;
  tempoScale: number;
  /** Vertical zoom (1 = base). Pushed to the scene as one rescale. */
  spread: number;
  /** How the roll is drawn (see the look plugin). Pushed to the scene as one
   *  palette fan-out — never a rebuild. */
  look: SonataLook;
  /**
   * Fired with the live scene + app pair once init settles, and with null on
   * teardown. The app rides along because the FX context needs its ticker and
   * renderer (texture generation) — see fx-context.ts.
   */
  onSceneReady: (
    pixi: { scene: PianoRollScene; app: Application } | null,
  ) => void;
  /**
   * Fired when the GPU context/device is lost AFTER a successful init (a sleep/
   * wake, GPU-process reset, or driver hiccup on a long-lived tab). Pixi v8 does
   * not recover from a spontaneous loss on its own — the WebGPU device system
   * never subscribes to `device.lost`, and the WebGL system only auto-restores a
   * loss it forced — so the canvas would go permanently blank (the DOM overlays
   * keep rendering, hence "notes don't show"). The parent responds by remounting
   * this component (a fresh `key`), which tears the dead app down and rebuilds a
   * working one from the current props.
   */
  onContextLost: () => void;
  /**
   * Fired instead of `onSceneReady` when the browser offers neither WebGPU nor
   * WebGL (e.g. Chrome turned hardware acceleration off after GPU-process
   * crashes). No Pixi app is created: Pixi's last-resort 2D canvas renderer can
   * draw the note LETTERS but not the notes themselves (their mesh is a GPU
   * shader), so it is never a valid backend here — the parent renders a
   * "GPU unavailable" state instead of a roll with labels and no notes.
   */
  onGpuUnavailable: () => void;
}

/**
 * Watch a live Pixi app for a spontaneous GPU context/device loss and invoke
 * `onLost` exactly once. Both backends are covered:
 *  - WebGL — the canvas fires `webglcontextlost`; we `preventDefault()` (so the
 *    browser keeps the canvas around) and rebuild rather than hoping for an
 *    auto-restore Pixi only performs for losses it forced itself.
 *  - WebGPU — the device exposes a `lost` promise Pixi never listens to; a
 *    `reason` of `"destroyed"` is our own teardown (`app.destroy`) and is
 *    ignored, anything else is a real loss.
 * Returns a detach function for the WebGL listener (the WebGPU promise can't be
 * un-awaited, so the guard below de-dupes and the disposed flag drops late ones).
 */
function watchContextLoss(
  app: Application,
  scene: PianoRollScene,
  onLost: () => void,
): () => void {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    // Halt the scene's scheduler before anything else: rendering a frame against the dead
    // context throws inside Pixi's render loop (it would keep firing until React
    // unmounts us). Halting it makes the rebuild clean.
    scene.halt();
    onLost();
  };

  const canvas = app.canvas;
  const onGlLost = (e: Event): void => {
    e.preventDefault();
    fire();
  };
  canvas.addEventListener("webglcontextlost", onGlLost);

  // WebGPU device-loss: `renderer.gpu` holds `{ adapter, device }` on the WebGPU
  // backend and is undefined on WebGL — the optional chain guards both.
  const device = (
    app.renderer as {
      gpu?: { device?: { lost?: Promise<{ reason: string }> } };
    }
  ).gpu?.device;
  if (device?.lost) {
    void device.lost.then((info) => {
      if (info.reason !== "destroyed") fire();
    });
  }

  return () => canvas.removeEventListener("webglcontextlost", onGlLost);
}

export function PianoRollCanvas(props: PianoRollCanvasProps) {
  const {
    width,
    height,
    notesWidth,
    visuals,
    bars,
    pitchLines,
    scoreNotes,
    showLabels,
    tempoScale,
    spread,
    look,
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  // The scene lives in STATE (not just a ref) so the prop-forwarding effects
  // below re-fire once init settles and push the then-current props.
  const [scene, setScene] = useState<PianoRollScene | null>(null);
  // Latest callbacks without retriggering the init effect.
  const onSceneReadyRef = useLatestRef(props.onSceneReady);
  const onContextLostRef = useLatestRef(props.onContextLost);
  const onGpuUnavailableRef = useLatestRef(props.onGpuUnavailable);

  useEffect(() => {
    let disposed = false;
    let liveScene: PianoRollScene | null = null;
    let detachLoss = (): void => {};
    const app = new Application();
    // Resolves true once the app initialized, false when there is no GPU
    // backend (no app to tear down then).
    const ready = (async (): Promise<boolean> => {
      // The same probes Pixi's auto-detect runs (WebGL with our relaxed
      // performance-caveat flag; Pixi caches that answer per page, so init
      // below sees the same one). Neither ⇒ the GPU-unavailable state.
      const hasGpu = (await isWebGPUSupported()) || isWebGLSupported(false);
      if (!hasGpu) {
        if (!disposed) {
          clientLog("piano-roll", "pixi backend: none (gpu unavailable)");
          onGpuUnavailableRef.current();
        }
        return false;
      }
      await app.init({
        // GPU backends only — NOT Pixi's default trailing "canvas" fallback,
        // which silently draws labels without notes. Should the probe above
        // and init ever disagree, init throws "No available renderer" (loud).
        // Render on demand: the ticker starts stopped; the scene's scheduler
        // runs it only while something changes (render-scheduler.ts).
        autoStart: false,
        preference: ["webgpu", "webgl"],
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio,
        // Round every sprite/text quad to the device-pixel grid in the vertex
        // shader, so a label at a fractional authored offset is drawn 1:1 from
        // its glyph atlas instead of bilinear-resampled (blurry). The note mesh
        // is an analytic SDF and is unaffected.
        roundPixels: true,
        // Accept a software WebGL context as a last resort: on a machine with no
        // WebGPU and no hardware WebGL, a slow canvas WITH notes beats Pixi's
        // default of bailing out (failIfMajorPerformanceCaveat = true) and
        // falling to the GPU-unavailable state. Auto-detect still prefers
        // WebGPU → hardware WebGL first; this only relaxes the final fallback.
        failIfMajorPerformanceCaveat: false,
        eventFeatures: {
          move: false,
          globalMove: false,
          click: false,
          wheel: false,
        },
      });
      // The label atlas is baked once from the note-name face — wait for it.
      await loadLabelFonts();
      if (disposed) return true;
      const host = hostRef.current;
      if (!host) {
        throw new Error(
          "PianoRollCanvas: host div vanished before init settled",
        );
      }
      // Backend visibility: headless e2e exercises the WebGL fallback, real
      // Chrome should pick WebGPU — log which one actually initialized.
      console.info(`[piano-roll] pixi backend: ${app.renderer.name}`);
      clientLog("piano-roll", `pixi backend: ${app.renderer.name}`);
      app.canvas.style.pointerEvents = "none";
      host.appendChild(app.canvas);
      liveScene = createPianoRollScene(app);
      setScene(liveScene);
      onSceneReadyRef.current({ scene: liveScene, app });
      // Self-heal a spontaneous GPU loss: Pixi won't, so we ask the parent to
      // remount us and rebuild the app from the current props.
      detachLoss = watchContextLoss(app, liveScene, () => {
        clientLog("piano-roll", "gpu context lost — reinitializing canvas");
        onContextLostRef.current();
      });
      return true;
    })();
    return () => {
      disposed = true;
      detachLoss();
      // Destroy only after init settles — tearing down mid-init crashes Pixi.
      void ready.then((initialized) => {
        if (!initialized) return;
        // Signal null only if WE published a scene: a StrictMode-killed first
        // instance never published (disposed flag), and its late cleanup must
        // not clobber the second instance's live handle.
        if (liveScene) {
          // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional latest-value read at teardown: onSceneReadyRef (a useLatestRef) must signal the CURRENT parent callback that the scene is gone, not one snapshotted at mount.
          onSceneReadyRef.current(null);
          setScene(null);
          liveScene.destroy();
        }
        app.destroy(true, { children: true });
      });
    };
    // Mount-once: the app lifecycle owns init/teardown. The callbacks are read
    // off their stable useLatestRef handles, so they never re-run this effect.
  }, []);

  // Each concern is its own effect so a change touches exactly one scene call.
  // Declaration order matters on the first scene-ready pass: size before score
  // (label layout needs the lane size) before the parent's scroll re-sync.
  useLayoutEffect(() => {
    if (!scene || width <= 0 || notesWidth <= 0 || height <= 0) return;
    // Re-read DPR every resize: a window move across monitors changes it
    // without any React prop changing size.
    scene.resize(width, notesWidth, height, window.devicePixelRatio);
  }, [scene, width, notesWidth, height]);

  // The look. After resize so the grid's screen-space rules redraw at the real
  // lane size; before the score, whose layers then paint with the stored ink.
  useLayoutEffect(() => {
    if (!scene) return;
    scene.setLook(look);
  }, [scene, look]);

  useLayoutEffect(() => {
    if (!scene) return;
    scene.setScore({
      notes: visuals,
      bars,
      pitchLines,
      scoreNotes,
      tempoScale,
    });
  }, [scene, visuals, bars, pitchLines, scoreNotes, tempoScale]);

  // No per-frame cursor effect and no seek-reset effect here: the parent
  // subscribes to the cursor store and calls `scene.setScroll` imperatively
  // (piano-roll.tsx `applyCursor`), re-anchoring the onset tracker via
  // `scene.reset()` when the store flags the change a seek. So a playback frame
  // never re-renders this component; on scene-ready the parent re-syncs once via
  // its own layout effect.

  useLayoutEffect(() => {
    if (!scene) return;
    scene.setShowLabels(showLabels);
  }, [scene, showLabels]);

  // Vertical zoom. Runs after resize (which seeds the lane size the rescale
  // reads); the parent's cursor re-sync layout effect then re-glues the scroll.
  useLayoutEffect(() => {
    if (!scene) return;
    scene.setSpread(spread);
  }, [scene, spread]);

  useEffect(() => {
    if (!scene) return;
    return watchThemeColors(() => scene.refreshColors());
  }, [scene]);

  return (
    // Pixi canvas host: the full-bleed inert layer the appended <canvas> fills.
    // The lane bg shows through (the canvas is transparent).
    <Layer ref={hostRef} decorative />
  );
}
