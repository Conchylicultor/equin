import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useConfig } from "@plugins/config_v2/web";
import {
  beadLabel,
  classifyKey,
  partyConfig,
  type KeyEffect,
} from "../../core";
import { hush, PartyAudio } from "../internal/audio";
import { PartyEffects, type PartyOptions } from "../internal/effects";
import { PartyControls } from "./party-controls";
import "./party.css";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

interface Bead {
  readonly id: number;
  readonly label: string;
  readonly hue: number;
}

/** The night sky's stars, in % of the stage; `small` ones twinkle on their own beat. */
const STARS: readonly { x: number; y: number; small?: true }[] = [
  { x: 12, y: 18 },
  { x: 27, y: 62 },
  { x: 41, y: 9 },
  { x: 58, y: 44 },
  { x: 66, y: 23 },
  { x: 79, y: 71 },
  { x: 88, y: 12 },
  { x: 6, y: 79 },
  { x: 93, y: 48 },
  { x: 35, y: 33 },
  { x: 51, y: 83 },
  { x: 72, y: 56 },
  { x: 18, y: 41, small: true },
  { x: 33, y: 88, small: true },
  { x: 47, y: 57, small: true },
  { x: 62, y: 6, small: true },
  { x: 84, y: 34, small: true },
  { x: 9, y: 52, small: true },
  { x: 76, y: 91, small: true },
  { x: 97, y: 77, small: true },
];

/** A bead's width plus its gap, and the trail's side padding, in px. */
const BEAD_PITCH = 54;
const TRAIL_PADDING = 32;

const VOICES: readonly PartyOptions["voice"][] = ["word", "letter", "off"];
function asVoice(value: string): PartyOptions["voice"] {
  const voice = VOICES.find((v) => v === value);
  if (!voice) throw new Error(`Keyboard Party: unknown voice "${value}"`);
  return voice;
}

/**
 * The party: one focused stage where every key plays its effect.
 *
 * Keys are taken by the stage's own `onKeyDown`, which `preventDefault`s every
 * one — the shortcut registry yields any key an element already handled, so no
 * app shortcut fires while the toy has focus. The stage focuses itself on mount
 * and on every tap. A held key plays once (`repeat` is ignored).
 */
export function PartyStage() {
  const config = useConfig(partyConfig);
  const options: PartyOptions = {
    calm: config.motion === "calm",
    voice: asVoice(config.voice),
  };
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const effectsRef = useRef<PartyEffects | null>(null);
  const beadId = useRef(0);
  const [beads, setBeads] = useState<readonly Bead[]>([]);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) throw new Error("PartyStage: effects layer not mounted");
    const audio = new PartyAudio();
    effectsRef.current = new PartyEffects(layer, audio);
    focusElement(stageRef.current, { reveal: false });
    return () => {
      effectsRef.current = null;
      audio.dispose();
      hush();
      layer.replaceChildren();
    };
  }, []);

  function play(effect: KeyEffect, at?: { x: number; y: number }) {
    const effects = effectsRef.current;
    if (!effects) return;
    setStarted(true);
    effects.play(effect, options, at);
    if (effect.kind === "sweep") {
      setBeads([]);
      return;
    }
    const label = beadLabel(effect);
    if (label == null) return;
    const bead = {
      id: beadId.current++,
      label,
      hue: PartyEffects.beadHue(effect),
    };
    // keep as many beads as fit across the stage, dropping the oldest
    const fit = Math.max(
      1,
      Math.floor(
        ((stageRef.current?.clientWidth ?? 0) - TRAIL_PADDING) / BEAD_PITCH,
      ),
    );
    setBeads((prev) => [...prev, bead].slice(-fit));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.preventDefault();
    if (e.repeat) return;
    play(classifyKey(e.key, e.code));
  }

  // little hands on a touchscreen get a letter where they tap
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    focusElement(stageRef.current, { reveal: false });
    const rect = e.currentTarget.getBoundingClientRect();
    const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    play(classifyKey(letter), {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }

  return (
    <div className="kp-root" data-scene={config.scene}>
      <div
        ref={stageRef}
        className="kp-stage"
        tabIndex={0}
        role="application"
        aria-label="Tap Tap Party"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {config.scene === "night" ? (
          <div className="kp-stars" aria-hidden>
            {STARS.map((s) => (
              <i
                key={`${s.x},${s.y}`}
                className={s.small ? "kp-star kp-star-small" : "kp-star"}
                style={{ left: `${s.x}%`, top: `${s.y}%` }}
              />
            ))}
          </div>
        ) : null}
        <div
          className={started ? "kp-hello kp-hello-gone" : "kp-hello"}
          aria-hidden
        >
          <div className="kp-hello-key" style={{ ["--kp-hue" as string]: 340 }}>
            A
          </div>
          <div className="kp-hello-key" style={{ ["--kp-hue" as string]: 35 }}>
            B
          </div>
          <div className="kp-hello-key" style={{ ["--kp-hue" as string]: 155 }}>
            C
          </div>
        </div>
        <div ref={layerRef} className="kp-layer" aria-hidden />
        {config.trail ? (
          <div className="kp-trail" aria-hidden>
            {beads.map((b) => (
              <div
                key={b.id}
                className="kp-bead"
                style={{ ["--kp-hue" as string]: b.hue }}
              >
                {b.label}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <PartyControls stageRef={stageRef} />
    </div>
  );
}
