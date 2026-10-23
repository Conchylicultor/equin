import {
  COUNT_PICTURES,
  ENTRANCES,
  hueOf,
  INSTRUMENTS,
  LETTER_WORDS,
  NUMBER_WORDS,
  pentatonicHz,
  type Direction,
  type Entrance,
  type KeyEffect,
} from "../../core";
import { say, type PartyAudio } from "./audio";

/**
 * The party's effects layer: every key spawns short-lived DOM nodes animated by
 * the Web Animations API, each removing itself when its animation finishes. It
 * is imperative on purpose — the layer is a drawing surface (a canvas in all but
 * name), and a React render per particle would cost far more than it buys.
 *
 * Every staged beat (a burst after a letter lands, the rockets of a firework) is
 * an animation `delay` or an audio `at`, never a timer.
 */

export interface PartyOptions {
  readonly calm: boolean;
  readonly voice: "word" | "letter" | "off";
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** The node budget: past it, the oldest effects make way for new ones. */
const MAX_NODES = { lively: 420, calm: 160 };

const rand = (a: number, b: number) => a + Math.random() * (b - a);
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}
const color = (hue: number, light = 60) => `hsl(${hue} 90% ${light}%)`;

const ENTRANCE_FRAMES: Record<Entrance, Keyframe[]> = {
  pop: [
    { transform: "translate(-50%,-50%) scale(0)", opacity: 0 },
    { transform: "translate(-50%,-50%) scale(1.25)", opacity: 1, offset: 0.25 },
    { transform: "translate(-50%,-50%) scale(1)", offset: 0.4 },
    { transform: "translate(-50%,-50%) scale(1)", opacity: 1, offset: 0.82 },
    { transform: "translate(-50%,-50%) scale(1.4)", opacity: 0 },
  ],
  spin: [
    { transform: "translate(-50%,-50%) rotate(-540deg) scale(.1)", opacity: 0 },
    {
      transform: "translate(-50%,-50%) rotate(15deg) scale(1.1)",
      opacity: 1,
      offset: 0.35,
    },
    { transform: "translate(-50%,-50%) rotate(0deg) scale(1)", offset: 0.45 },
    {
      transform: "translate(-50%,-50%) rotate(0deg) scale(1)",
      opacity: 1,
      offset: 0.82,
    },
    { transform: "translate(-50%,-50%) rotate(180deg) scale(0)", opacity: 0 },
  ],
  bounce: [
    { transform: "translate(-50%,-260%) scale(1,1)", opacity: 0 },
    {
      transform: "translate(-50%,-50%) scale(1.3,.7)",
      opacity: 1,
      offset: 0.2,
    },
    { transform: "translate(-50%,-90%) scale(.9,1.1)", offset: 0.3 },
    { transform: "translate(-50%,-50%) scale(1.15,.85)", offset: 0.38 },
    { transform: "translate(-50%,-62%) scale(1)", offset: 0.45 },
    { transform: "translate(-50%,-50%) scale(1)", opacity: 1, offset: 0.82 },
    { transform: "translate(-50%,200%) scale(1)", opacity: 0 },
  ],
  wobble: [
    { transform: "translate(-50%,-50%) scale(.3) rotate(0)", opacity: 0 },
    {
      transform: "translate(-50%,-50%) scale(1) rotate(-14deg)",
      opacity: 1,
      offset: 0.15,
    },
    { transform: "translate(-50%,-50%) rotate(12deg)", offset: 0.28 },
    { transform: "translate(-50%,-50%) rotate(-8deg)", offset: 0.4 },
    { transform: "translate(-50%,-50%) rotate(5deg)", offset: 0.52 },
    { transform: "translate(-50%,-50%) rotate(0)", opacity: 1, offset: 0.82 },
    { transform: "translate(-50%,-50%) scale(.2) rotate(0)", opacity: 0 },
  ],
  zoom: [
    {
      transform: "translate(-50%,-50%) scale(6)",
      opacity: 0,
      filter: "blur(12px)",
    },
    {
      transform: "translate(-50%,-50%) scale(.9)",
      opacity: 1,
      filter: "blur(0)",
      offset: 0.25,
    },
    { transform: "translate(-50%,-50%) scale(1)", offset: 0.35 },
    { transform: "translate(-50%,-50%) scale(1)", opacity: 1, offset: 0.82 },
    { transform: "translate(-50%,-50%) scale(.1)", opacity: 0 },
  ],
  jelly: [
    { transform: "translate(-50%,-50%) scale(0,0)", opacity: 0 },
    {
      transform: "translate(-50%,-50%) scale(1.4,.6)",
      opacity: 1,
      offset: 0.14,
    },
    { transform: "translate(-50%,-50%) scale(.7,1.3)", offset: 0.26 },
    { transform: "translate(-50%,-50%) scale(1.15,.9)", offset: 0.36 },
    { transform: "translate(-50%,-50%) scale(.95,1.05)", offset: 0.46 },
    { transform: "translate(-50%,-50%) scale(1)", opacity: 1, offset: 0.82 },
    { transform: "translate(-50%,-50%) scale(1.6,0)", opacity: 0 },
  ],
};

const FLIERS: Record<
  Direction,
  { emoji: string; hue: number; vector: [number, number]; turn: string }
> = {
  up: { emoji: "🚀", hue: 200, vector: [0, -1], turn: " rotate(-45deg)" },
  down: { emoji: "🪂", hue: 140, vector: [0, 1], turn: "" },
  left: { emoji: "🐠", hue: 30, vector: [-1, 0], turn: "" },
  right: { emoji: "🚂", hue: 320, vector: [1, 0], turn: " scaleX(-1)" },
};

const MODIFIER_HUES: Record<string, number> = {
  Shift: 50,
  Control: 190,
  Alt: 110,
  Meta: 270,
  Tab: 15,
  CapsLock: 330,
};

const RAINBOW = [
  "#ff4d6d",
  "#ff9f1c",
  "#ffd60a",
  "#3ccf91",
  "#3a86ff",
  "#8338ec",
];
const CONFETTI_SHAPES = ["▲", "■", "●", "★", "♥", "◆", "✿"];

export class PartyEffects {
  private recentSpots: Point[] = [];

  constructor(
    private readonly layer: HTMLElement,
    private readonly audio: PartyAudio,
  ) {}

  /** Plays one key's effect; `at` places a letter (a tap) instead of a free spot. */
  play(effect: KeyEffect, opts: PartyOptions, at?: Point): void {
    switch (effect.kind) {
      case "letter":
        return this.letter(effect.letter, effect.index, opts, at);
      case "digit":
        return this.digit(effect.digit, opts);
      case "fireworks":
        return this.fireworks(opts);
      case "rainbow":
        return this.rainbow(opts);
      case "flier":
        return this.flier(effect.direction, opts);
      case "sweep":
        return this.sweep(opts);
      case "boing":
        return this.boing(effect.modifier, opts);
      case "confetti":
        return this.confetti(effect.key, effect.seed, opts);
    }
  }

  /** The hue a key's bead is painted in — the same hue its effect uses. */
  static beadHue(effect: KeyEffect): number {
    switch (effect.kind) {
      case "letter":
        return hueOf(effect.index, 26);
      case "digit":
        return hueOf(effect.digit, 10);
      case "fireworks":
        return 45;
      case "rainbow":
        return 280;
      case "flier":
        return FLIERS[effect.direction].hue;
      case "confetti":
        return (effect.seed * 47) % 360;
      case "sweep":
      case "boing":
        return 0;
    }
  }

  // ---------- helpers ----------

  private get w() {
    return this.layer.clientWidth;
  }
  private get h() {
    return this.layer.clientHeight;
  }

  private node(
    className: string,
    styles: Partial<CSSStyleDeclaration>,
    text: string | null,
    opts: PartyOptions,
  ): HTMLDivElement {
    const max = opts.calm ? MAX_NODES.calm : MAX_NODES.lively;
    while (this.layer.childElementCount >= max)
      this.layer.firstElementChild?.remove();
    const el = document.createElement("div");
    el.className = className;
    Object.assign(el.style, styles);
    if (text != null) el.textContent = text;
    this.layer.append(el);
    return el;
  }

  private animate(
    el: HTMLElement,
    frames: Keyframe[],
    timing: KeyframeAnimationOptions,
  ) {
    const anim = el.animate(frames, { fill: "both", ...timing });
    anim.onfinish = () => el.remove();
    // a cancel (the sweep) removes the node itself
    return anim;
  }

  private dur(ms: number, opts: PartyOptions) {
    return opts.calm ? ms * 1.35 : ms;
  }
  private count(n: number, opts: PartyOptions) {
    return opts.calm ? Math.ceil(n / 3) : n;
  }

  /** A free spot, as far as possible from the last few keys' spots. */
  private spot(margin = 0.2): Point {
    let best: Point = { x: this.w / 2, y: this.h / 2 };
    let bestDistance = -1;
    for (let k = 0; k < 8; k++) {
      const p = {
        x: rand(this.w * margin, this.w * (1 - margin)),
        y: rand(this.h * margin, this.h * (1 - margin) - 40),
      };
      const d = Math.min(
        ...this.recentSpots.map((q) => Math.hypot(q.x - p.x, q.y - p.y)),
        1e9,
      );
      if (d > bestDistance) {
        bestDistance = d;
        best = p;
      }
    }
    this.recentSpots = [best, ...this.recentSpots].slice(0, 4);
    return best;
  }

  private burst(
    p: Point,
    hue: number,
    n: number,
    opts: PartyOptions,
    {
      shapes = ["●", "★", "◆", "♥"],
      spread = 260,
      size = [14, 28],
      delay = 0,
    }: {
      shapes?: string[];
      spread?: number;
      size?: [number, number];
      delay?: number;
    } = {},
  ) {
    for (let i = 0; i < this.count(n, opts); i++) {
      const angle = rand(0, Math.PI * 2);
      const dist = rand(spread * 0.35, spread);
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const el = this.node(
        "kp-particle",
        {
          left: `${p.x}px`,
          top: `${p.y}px`,
          fontSize: `${rand(size[0], size[1])}px`,
          color: color((hue + rand(-40, 40) + 360) % 360, rand(55, 72)),
        },
        pick(shapes),
        opts,
      );
      this.animate(
        el,
        [
          { transform: "translate(-50%,-50%) scale(.2)", opacity: 0 },
          {
            transform: "translate(-50%,-50%) scale(.3)",
            opacity: 1,
            offset: 0.04,
          },
          {
            transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${rand(-360, 360)}deg) scale(1)`,
            opacity: 1,
            offset: 0.7,
          },
          {
            transform: `translate(calc(-50% + ${dx * 1.1}px), calc(-50% + ${dy + 80}px)) scale(.6)`,
            opacity: 0,
          },
        ],
        {
          duration: this.dur(rand(900, 1500), opts),
          delay,
          easing: "cubic-bezier(.15,.7,.3,1)",
        },
      );
    }
  }

  // ---------- effects ----------

  private letter(L: string, index: number, opts: PartyOptions, at?: Point) {
    const hue = hueOf(index, 26);
    const entrance = ENTRANCES[index % ENTRANCES.length] ?? "pop";
    const picture = LETTER_WORDS[L];
    const size = Math.min(this.w, this.h) * (opts.calm ? 0.32 : 0.38);
    const raw = at ?? this.spot();
    // keep the letter, its picture and its word on screen
    const p = {
      x: Math.min(Math.max(raw.x, size * 1.1), this.w - size * 1.1),
      y: Math.min(Math.max(raw.y, size * 0.6), this.h - size * 0.85 - 80),
    };
    const duration = this.dur(2600, opts);
    this.audio.play(
      INSTRUMENTS[index % INSTRUMENTS.length] ?? "bell",
      pentatonicHz(index),
    );

    const glyph = this.node(
      "kp-glyph",
      {
        left: `${p.x}px`,
        top: `${p.y}px`,
        fontSize: `${size}px`,
        color: color(hue),
        webkitTextStroke: `${Math.max(3, size / 40)}px ${color(hue, 38)}`,
      },
      L,
      opts,
    );
    this.animate(glyph, ENTRANCE_FRAMES[entrance], {
      duration,
      easing: "ease-out",
    });

    if (picture) {
      // the picture peeks out beside the letter and floats up
      const side = p.x > this.w / 2 ? -1 : 1;
      const pic = this.node(
        "kp-picture",
        {
          left: `${p.x + side * size * 0.62}px`,
          top: `${p.y - size * 0.1}px`,
          fontSize: `${size * 0.55}px`,
        },
        picture.emoji,
        opts,
      );
      this.animate(
        pic,
        [
          {
            transform: "translate(-50%,-50%) scale(0) rotate(-30deg)",
            opacity: 0,
          },
          {
            transform: "translate(-50%,-50%) scale(0) rotate(-30deg)",
            opacity: 0,
            offset: 0.12,
          },
          {
            transform: "translate(-50%,-60%) scale(1.15) rotate(8deg)",
            opacity: 1,
            offset: 0.3,
          },
          {
            transform: "translate(-50%,-55%) scale(1) rotate(0)",
            opacity: 1,
            offset: 0.4,
          },
          {
            transform: "translate(-50%,-80%) scale(1) rotate(-6deg)",
            opacity: 1,
            offset: 0.82,
          },
          {
            transform: "translate(-50%,-160%) scale(.7) rotate(10deg)",
            opacity: 0,
          },
        ],
        { duration, easing: "ease-out" },
      );

      if (opts.voice === "word") {
        const word = this.node(
          "kp-word",
          {
            left: `${p.x}px`,
            top: `${p.y + size * 0.62}px`,
            fontSize: `${Math.max(22, size * 0.16)}px`,
          },
          null,
          opts,
        );
        const initial = document.createElement("b");
        initial.textContent = picture.word.slice(0, 1);
        initial.style.color = color(hue);
        word.append(initial, picture.word.slice(1));
        this.animate(
          word,
          [
            { transform: "translate(-50%,20px)", opacity: 0 },
            { transform: "translate(-50%,20px)", opacity: 0, offset: 0.2 },
            { transform: "translate(-50%,0)", opacity: 1, offset: 0.32 },
            { transform: "translate(-50%,0)", opacity: 1, offset: 0.82 },
            { transform: "translate(-50%,10px)", opacity: 0 },
          ],
          { duration },
        );
        say(`${L}! ${picture.word}`);
      }
    }
    if (opts.voice === "letter") say(L);

    this.burst(p, hue, 18, opts, {
      spread: size * 0.9,
      delay: this.dur(260, opts),
    });
  }

  private digit(n: number, opts: PartyOptions) {
    const hue = hueOf(n, 10);
    const items = n === 0 ? 1 : n;
    const sz = Math.min((this.w / Math.max(n, 3)) * 0.8, this.h * 0.22);
    const y = this.h * 0.42;
    const tail = 2200;

    const num = this.node(
      "kp-glyph",
      {
        left: `${this.w / 2}px`,
        top: `${y - sz * 1.1}px`,
        fontSize: `${sz * 1.3}px`,
        color: color(hue),
      },
      String(n),
      opts,
    );
    this.animate(num, ENTRANCE_FRAMES.pop, {
      duration: this.dur(900 + n * 260 + 1400, opts),
    });

    for (let k = 0; k < items; k++) {
      const x = this.w / 2 + (k - (items - 1) / 2) * sz * 1.05;
      const delay = 250 + k * 260;
      const total = delay + tail;
      const el = this.node(
        "kp-picture",
        {
          left: `${x}px`,
          top: `${y + sz * 0.35}px`,
          fontSize: `${n === 0 ? sz * 1.6 : sz}px`,
        },
        COUNT_PICTURES[n] ?? "🎈",
        opts,
      );
      this.animate(
        el,
        [
          { transform: "translate(-50%,-50%) scale(0)", opacity: 0 },
          {
            transform: "translate(-50%,-50%) scale(0)",
            opacity: 0,
            offset: delay / total,
          },
          {
            transform: "translate(-50%,-70%) scale(1.25)",
            opacity: 1,
            offset: (delay + 200) / total,
          },
          {
            transform: "translate(-50%,-50%) scale(1)",
            opacity: 1,
            offset: (delay + 380) / total,
          },
          {
            transform: "translate(-50%,-50%) scale(1)",
            opacity: 1,
            offset: 0.85,
          },
          { transform: "translate(-50%,40%) scale(.8)", opacity: 0 },
        ],
        { duration: this.dur(total, opts), easing: "ease-out" },
      );
      if (n > 0)
        this.audio.tone(pentatonicHz(k + 3), {
          dur: 0.35,
          vol: 0.3,
          at: delay / 1000,
        });
    }
    if (n === 0) this.audio.tone(196, { dur: 0.8, vol: 0.35, slideTo: 98 });
    if (opts.voice !== "off") say(NUMBER_WORDS[n] ?? String(n));
  }

  private fireworks(opts: PartyOptions) {
    const shots = opts.calm ? 1 : 3;
    for (let s = 0; s < shots; s++) {
      const x = rand(this.w * 0.2, this.w * 0.8);
      const top = rand(this.h * 0.15, this.h * 0.45);
      const hue = rand(0, 360);
      const launch = s * 280;
      const rise = 500;
      this.audio.noise({
        dur: 0.5,
        vol: 0.15,
        filter: 600,
        sweepTo: 4000,
        q: 3,
        at: launch / 1000,
      });
      const rocket = this.node(
        "kp-rocket",
        {
          left: `${x}px`,
          top: `${this.h}px`,
          background: `linear-gradient(${color(hue, 80)}, transparent)`,
        },
        null,
        opts,
      );
      this.animate(
        rocket,
        [
          { transform: "translateY(0)" },
          { transform: `translateY(${top - this.h}px)` },
        ],
        {
          duration: rise,
          delay: launch,
          easing: "ease-out",
          fill: "backwards",
        },
      );
      const bang = (launch + rise) / 1000;
      this.audio.noise({
        dur: 0.7,
        vol: 0.35,
        filter: 900,
        type: "lowpass",
        at: bang,
      });
      for (let k = 0; k < 6; k++) {
        this.audio.noise({
          dur: 0.05,
          vol: 0.12,
          filter: rand(3000, 7000),
          at: bang + 0.25 + k * 0.07,
          q: 8,
        });
      }
      this.burst({ x, y: top }, hue, 40, opts, {
        shapes: ["✦", "•", "✧"],
        spread: Math.min(this.w, this.h) * 0.3,
        size: [10, 22],
        delay: launch + rise,
      });
    }
  }

  private rainbow(opts: PartyOptions) {
    const r = Math.min(this.w, this.h * 1.4) * 0.45;
    RAINBOW.forEach((c, k) => {
      const rr = r - k * r * 0.09;
      const band = this.node(
        "kp-band",
        {
          left: `${this.w / 2 - rr}px`,
          top: `${this.h * 0.78 - rr}px`,
          width: `${rr * 2}px`,
          height: `${rr * 2}px`,
          borderWidth: `${r * 0.09}px`,
          borderColor: c,
        },
        null,
        opts,
      );
      this.animate(
        band,
        [
          { transform: "rotate(-180deg)", opacity: 0 },
          { transform: "rotate(0deg)", opacity: 1, offset: 0.3 },
          { transform: "rotate(0deg)", opacity: 1, offset: 0.8 },
          { transform: "rotate(0deg) translateY(-20px)", opacity: 0 },
        ],
        {
          duration: this.dur(2400, opts),
          easing: "cubic-bezier(.2,.8,.2,1)",
          delay: k * 60,
        },
      );
      this.audio.tone(pentatonicHz(5 + k), {
        type: "triangle",
        dur: 0.5,
        vol: 0.25,
        at: k * 0.07,
      });
    });
    if (opts.voice !== "off") say("Hooray!");
  }

  private flier(direction: Direction, opts: PartyOptions) {
    const { emoji, hue, vector, turn } = FLIERS[direction];
    const [vx, vy] = vector;
    const start = {
      x: vx ? (vx > 0 ? -80 : this.w + 80) : rand(this.w * 0.2, this.w * 0.8),
      y: vy ? (vy > 0 ? -80 : this.h + 80) : rand(this.h * 0.2, this.h * 0.7),
    };
    const dist = vx ? this.w + 160 : this.h + 160;
    const duration = this.dur(1300, opts);
    const el = this.node(
      "kp-picture",
      { left: `${start.x}px`, top: `${start.y}px`, fontSize: "80px" },
      emoji,
      opts,
    );
    this.animate(
      el,
      [
        { transform: `translate(-50%,-50%)${turn}` },
        {
          transform: `translate(calc(-50% + ${vx * dist}px), calc(-50% + ${vy * dist}px))${turn}`,
        },
      ],
      { duration, easing: "ease-in-out" },
    );
    // a sparkle trail behind it
    const steps = this.count(14, opts);
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      this.burst(
        { x: start.x + vx * dist * t, y: start.y + vy * dist * t },
        hue,
        3,
        { ...opts, calm: false },
        {
          shapes: ["✦", "•"],
          spread: 50,
          size: [10, 18],
          delay: duration * t,
        },
      );
    }
    const rising = direction === "up" || direction === "right";
    this.audio.tone(rising ? 300 : 900, {
      dur: 0.9,
      vol: 0.25,
      slideTo: rising ? 900 : 300,
    });
  }

  private sweep(opts: PartyOptions) {
    // everything on screen pops like a bubble
    const live = [
      ...this.layer.querySelectorAll<HTMLElement>(
        ".kp-glyph, .kp-picture, .kp-word",
      ),
    ];
    live.forEach((el, k) => {
      el.getAnimations().forEach((a) => a.cancel());
      this.animate(
        el,
        [
          { transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
          { transform: "translate(-50%,-50%) scale(1.6)", opacity: 0 },
        ],
        { duration: 260, delay: k * 40 },
      );
      this.audio.tone(rand(500, 900), {
        dur: 0.08,
        vol: 0.2,
        at: k * 0.04,
        slideTo: 1600,
      });
    });
    if (live.length > 0) return;
    // an empty screen gets bubbles of its own to pop
    for (let k = 0; k < this.count(9, opts); k++) {
      const s = rand(40, 110);
      const bubble = this.node(
        "kp-bubble",
        {
          left: `${rand(this.w * 0.1, this.w * 0.9)}px`,
          top: `${rand(this.h * 0.1, this.h * 0.8)}px`,
          width: `${s}px`,
          height: `${s}px`,
        },
        null,
        opts,
      );
      const duration = 500 + k * 90;
      this.animate(
        bubble,
        [
          { transform: "translate(-50%,-50%) scale(0)", opacity: 0 },
          {
            transform: "translate(-50%,-50%) scale(1)",
            opacity: 1,
            offset: 0.5,
          },
          { transform: "translate(-50%,-50%) scale(1.3)", opacity: 0 },
        ],
        { duration },
      );
      this.audio.tone(rand(500, 900), {
        dur: 0.08,
        vol: 0.2,
        at: (duration - 50) / 1000,
        slideTo: 1600,
      });
    }
  }

  private boing(modifier: string, opts: PartyOptions) {
    const hue = MODIFIER_HUES[modifier] ?? 0;
    const blob = this.node(
      "kp-blob",
      {
        left: `${rand(this.w * 0.2, this.w * 0.8)}px`,
        top: `${this.h + 60}px`,
        background: color(hue, 62),
        boxShadow: `inset -14px -18px 0 ${color(hue, 48)}`,
      },
      null,
      opts,
    );
    for (const part of ["eye-l", "eye-r", "pupil-l", "pupil-r", "mouth"]) {
      const el = document.createElement("div");
      el.className = `kp-blob-${part}`;
      blob.append(el);
    }
    this.animate(
      blob,
      [
        { transform: "translate(-50%,0) scale(1,1)" },
        { transform: "translate(-50%,-300px) scale(.9,1.15)", offset: 0.3 },
        { transform: "translate(-50%,-260px) scale(1.1,.9)", offset: 0.42 },
        { transform: "translate(-50%,-290px) scale(1)", offset: 0.55 },
        { transform: "translate(-50%,-290px) scale(1)", offset: 0.75 },
        { transform: "translate(-50%,0) scale(1)" },
      ],
      { duration: this.dur(1800, opts), easing: "ease-in-out" },
    );
    this.audio.tone(160, { dur: 0.5, vol: 0.35, slideTo: 420 });
    this.audio.tone(420, { dur: 0.35, vol: 0.2, at: 0.5, slideTo: 140 });
  }

  private confetti(key: string, seed: number, opts: PartyOptions) {
    const hue = (seed * 47) % 360;
    const p = this.spot(0.25);
    this.burst(p, hue, 30, opts, {
      shapes: [
        CONFETTI_SHAPES[seed % CONFETTI_SHAPES.length] ?? "●",
        CONFETTI_SHAPES[(seed + 3) % CONFETTI_SHAPES.length] ?? "★",
      ],
      spread: Math.min(this.w, this.h) * 0.3,
    });
    const glyph = this.node(
      "kp-glyph",
      {
        left: `${p.x}px`,
        top: `${p.y}px`,
        fontSize: `${Math.min(this.w, this.h) * 0.22}px`,
        color: color(hue),
      },
      key.length === 1 ? key : "✨",
      opts,
    );
    this.animate(
      glyph,
      ENTRANCE_FRAMES[ENTRANCES[seed % ENTRANCES.length] ?? "pop"],
      {
        duration: this.dur(1800, opts),
      },
    );
    // a little drum
    this.audio.tone(110 + (seed % 7) * 20, {
      dur: 0.25,
      vol: 0.45,
      slideTo: 50,
    });
    this.audio.noise({
      dur: 0.12,
      vol: 0.15,
      filter: 3000 + (seed % 5) * 1000,
    });
  }
}
