import {
  FRAME,
  HEAD,
  LOUD,
  DONE,
  botScale,
  clamp,
  figureCss,
  fitInHead,
  go,
  headGeom,
  headHeight,
  headSVG,
  idle,
  loop,
  makeBot,
  phrase,
  phraseFont,
  pick,
  place,
  rnd,
  stepTween,
  whileVisible,
  type HeadFigure,
  type HeadGeom,
  type Mover,
  type Pose,
  type Pt,
} from "./kit";

/* <mind-overload>, ported from the prototype's `heads.js` (`proto-1794207359-w7ez6h`).
   Agents come at my head from behind, from above and from the front, each crowding in for attention. As one
   arrives its conversation travels from it into my head, and the newest is the loud one; there it jostles
   with everyone else's — several at once, overlapping, never still. In time my head sends an answer back out
   to the agent (a ✓ and it is done and gone, or a word it takes back to work), and its words fade from my
   head. The same travel as <review-desk>, but the head is never clear. */
const WORDS = [
  ["auth", "waiting", "approved"],
  ["ci", "failed", "rerun"],
  ["docs", "done?", "ship it"],
  ["perf", "running", "go on"],
  ["ui", "review?", "tighten"],
  ["db", "which?", "postgres"],
  ["deps", "bump?", "not yet"],
  ["search", "stuck", "try fts"],
] as const;
const MAX_CROWD = 6,
  FLY_T = 0.9,
  BACK_T = 0.8;

type Side = "back" | "top" | "front";
interface Spot {
  side: Side;
  x: number;
  y: number;
  i: number;
  v: Bot | null;
}
interface Word {
  html: string;
  ans: string;
  busy: boolean;
}
interface Bot extends Mover {
  sp: Spot;
  word: Word;
  ph: number;
  state: "in" | "call" | "heard" | "out";
  since: number;
  loud: boolean;
  answerAt: number;
  wd: Phrase | null;
  P?: Pose;
}
interface Phrase extends Mover {
  v: Bot;
  vx: number;
  vy: number;
  a: number;
  l: number;
  die: boolean;
  loud: boolean;
  wpx: number;
  hpx: number;
  tx: number;
  ty: number;
  retarget: number;
}

/* a phrase in my head always fits inside the skull: drifting, it is held there (sideways, and shrunk if it must);
   flying in, it already has the size it will have where it lands */
const drawPhrase = (w: Phrase, g: HeadGeom) => {
  const sc = 0.8 + 0.2 * w.a + (LOUD - 1) * w.l;
  let s2;
  if (w.tw) s2 = fitInHead(g, w.tw.to, w.wpx, w.hpx, sc, true).sc;
  else {
    const F = fitInHead(g, [w.x, w.y], w.wpx, w.hpx, sc, true);
    if (F.p[0] !== w.x) {
      w.x = F.p[0];
      w.vx = 0;
    }
    s2 = F.sc;
  }
  w.el.style.opacity = w.a.toFixed(3);
  w.el.style.transform = `translate(${w.x.toFixed(2)}px, ${w.y.toFixed(2)}px) scale(${s2.toFixed(3)})`;
};
const drawWord = (a: Mover) => {
  a.el.style.transform = `translate(${a.x.toFixed(2)}px, ${a.y.toFixed(2)}px) translate(-50%, -50%) scale(${a.sc.toFixed(3)})`;
};

class MindOverload implements HeadFigure {
  box: HTMLDivElement;
  t = 0;
  W = 0;
  s = 1;
  fs = 12;
  next = 0;
  loudSince = 0;
  g!: HeadGeom;
  bots: Bot[] = [];
  inHead: Phrase[] = [];
  answers = new Set<Mover>();
  loud: Bot | null = null;
  pool: Word[] = WORDS.map(([a, b, ans]) => ({
    html: phrase(a, b),
    ans,
    busy: false,
  }));
  spots: Spot[] = [];
  timers = new Set<ReturnType<typeof setTimeout>>();
  loop: ReturnType<typeof loop> | null = null;
  stopObs: (() => void) | null = null;

  constructor(
    private host: HTMLElement,
    private reduced: boolean,
  ) {
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${figureCss()}</style><div class="box"></div>`;
    this.box = root.querySelector<HTMLDivElement>(".box")!;
    this.layout();
    if (reduced) return;
    const lp = (this.loop = loop((dt) => this.tick(dt)));
    this.stopObs = whileVisible(
      host,
      () => lp.start(),
      () => lp.stop(),
    );
  }
  dispose() {
    this.stopObs?.();
    this.loop?.stop();
    for (const t of this.timers) clearTimeout(t);
  }
  later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  layout() {
    const W = Math.max(this.host.clientWidth || 300, 240);
    if (this.W === W) return;
    const old = this.W ? this.g : null,
      oldS = this.s;
    this.W = W;
    const H = headHeight(W),
      s = (this.s = botScale(W)),
      hw = (FRAME.w * H) / FRAME.h;
    const top = Math.round(58 * s + 10);
    const g = (this.g = headGeom(H, Math.round((W - hw) / 2), top));
    this.box.style.height = top + H + 6 + "px";
    this.box.querySelector(".head")?.remove();
    this.box.insertAdjacentHTML("afterbegin", headSVG(g));
    this.fs = phraseFont(W);
    // where the robots crowd: behind my head, on top of it, in front of my face (feet positions)
    const left = g.ox,
      right = g.X(HEAD.face),
      R = W - right;
    // a clear gap between me and them: the robots keep at least `gap` off my outline
    const gap = 14 * s,
      backX = (i: number) =>
        Math.max(
          16 * s,
          left - 15 * s - gap - (i === 1 ? 0 : clamp(left * 0.2, 0, 16 * s)),
        );
    this.spots = [
      ...[0.3, 0.58, 0.86].map((f, i) => ({
        side: "back" as const,
        x: backX(i),
        y: top + H * f,
      })),
      ...[0.3, 0.52, 0.74].map((f) => {
        const x = g.X(FRAME.x + FRAME.w * f);
        return {
          side: "top" as const,
          x,
          y: Math.min(g.top(x - 13 * s), g.top(x + 13 * s)) - gap,
        };
      }),
      ...[0.22, 0.48, 0.74, 0.98].map((f, i) => ({
        side: "front" as const,
        x: Math.min(
          W - 16 * s,
          right +
            15 * s +
            gap +
            clamp(R * (i % 2 ? 0.25 : 0.08), 0, (i % 2 ? 40 : 14) * s),
        ),
        y: top + H * f,
      })),
    ].map((p, i) => ({ ...p, i, v: null }));
    if (!old) {
      this.next = 0.4;
      if (this.reduced) this.still();
      else this.seed();
      return;
    }
    this.reflow(old, oldS);
  }
  /* a resize keeps everything where it is relative to my head (no restart, no teleport): positions and arcs
     in flight are carried into the new frame, and a robot standing at its spot walks over to the new one */
  reflow(old: HeadGeom, oldS: number) {
    const g = this.g,
      s = this.s,
      r = s / oldS;
    const map = ([x, y]: Pt): Pt => [
      g.X(FRAME.x + (x - old.ox) / old.k),
      g.Y(FRAME.y + (y - old.oy) / old.k),
    ];
    const carry = (o: Mover) => {
      [o.x, o.y] = map([o.x, o.y]);
      if (o.tw) {
        o.tw.from = map(o.tw.from);
        o.tw.mid = map(o.tw.mid);
        o.tw.to = map(o.tw.to);
      }
    };
    for (const v of this.bots) {
      carry(v);
      v.sc *= r;
      if (v.tw) {
        v.tw.sc0 *= r;
        v.tw.sc1 *= r;
      }
      if (v.state === "out") continue;
      const sp = (v.sp = this.spots[v.sp.i]!);
      sp.v = v;
      if (v.tw) v.tw.to = [sp.x, sp.y];
      else
        go(v, this.t, [sp.x, sp.y], {
          dur: 0.45,
          hop: 0,
          mid: [(v.x + sp.x) / 2, (v.y + sp.y) / 2],
        });
    }
    for (const w of this.inHead) {
      carry(w);
      [w.tx, w.ty] = map([w.tx, w.ty]);
      w.el.style.fontSize = this.fs + "px";
      w.wpx = w.el.offsetWidth;
      w.hpx = w.el.offsetHeight;
    }
    for (const a of this.answers) {
      carry(a);
      a.el.style.fontSize = this.fs + "px";
    }
  }
  face(sp: Spot) {
    return sp.side === "back"
      ? "look-r"
      : sp.side === "front"
        ? "look-l"
        : sp.x < this.g.brain[0]
          ? "look-r"
          : "look-l";
  }
  above(v: Bot): Pt {
    return [v.x, v.y - 48 * this.s];
  }
  away(sp: Spot): Pt {
    const s = this.s;
    return sp.side === "back"
      ? [-40 * s, sp.y + rnd(-30, 20)]
      : sp.side === "front"
        ? [this.W + 40 * s, sp.y + rnd(-30, 20)]
        : [sp.x + rnd(-80, 80), -50];
  }
  // keep a phrase of half-width `half` inside the figure
  inX(p: Pt, half: number): Pt {
    return [clamp(p[0], half, this.W - half), p[1]];
  }
  // a fresh place in my head for a phrase to drift to, leaning towards the side its agent calls from
  drift(w: Phrase) {
    const g = this.g,
      lean =
        w.v.sp.side === "back" ? -0.35 : w.v.sp.side === "front" ? 0.35 : 0;
    w.tx = g.brain[0] + (lean + rnd(-0.55, 0.55)) * g.brainR[0];
    w.ty = g.brain[1] + rnd(-1, 1) * g.brainR[1];
    w.retarget = this.t + rnd(0.7, 1.8);
  }

  // the agent's phrase: an element of its own, from its arrival until it has faded from my head
  phrase(v: Bot, at: Pt): Phrase {
    const el = document.createElement("span");
    el.className = "w";
    el.innerHTML = `<span class="in">${v.word.html}</span>`;
    el.style.fontSize = this.fs + "px";
    this.box.appendChild(el);
    const w: Phrase = {
      v,
      el,
      x: at[0],
      y: at[1],
      sc: 1,
      vx: 0,
      vy: 0,
      tw: null,
      a: 0,
      l: 0,
      die: false,
      loud: false,
      wpx: el.offsetWidth,
      hpx: el.offsetHeight,
      tx: 0,
      ty: 0,
      retarget: 0,
    };
    this.drift(w);
    v.wd = w;
    this.inHead.push(w);
    return w;
  }
  spawn(sp: Spot, word: Word): Bot {
    const s = this.s;
    const v: Bot = {
      el: makeBot(this.box),
      sp,
      word,
      x: 0,
      y: 0,
      sc: s,
      tw: null,
      ph: rnd(0, 6.3),
      state: "in",
      since: 0,
      loud: false,
      answerAt: 0,
      wd: null,
    };
    sp.v = v;
    word.busy = true;
    v.el.className = `ag wait ${this.face(sp)}`;
    // walk in from off the figure, on its own side
    if (sp.side === "back") {
      v.x = -30 * s;
      v.y = sp.y + rnd(-30, 30);
    } else if (sp.side === "front") {
      v.x = this.W + 30 * s;
      v.y = sp.y + rnd(-30, 30);
    } else {
      v.x = sp.x + rnd(-60, 60);
      v.y = -8;
    }
    go(v, this.t, [v.sp.x, v.sp.y], {
      dur: rnd(0.9, 1.5),
      sc: s,
      hop: sp.side === "top" ? 0 : 3 * s,
      mid: [
        (v.x + sp.x) / 2,
        Math.min(v.y, sp.y) - (sp.side === "top" ? 18 : rnd(10, 40)),
      ],
      done: () => this.arrive(v),
    });
    place(v);
    this.bots.push(v);
    return v;
  }
  // there: its phrase rises off it and travels along an arc into my head, and it is the loud one now
  arrive(v: Bot) {
    const t = this.t;
    v.state = "call";
    v.since = t;
    v.answerAt = t + FLY_T + rnd(2.2, 5.5);
    const w = this.phrase(v, this.above(v));
    const half = w.el.offsetWidth / 2 + 4;
    [w.x, w.y] = this.inX(this.above(v), half);
    // it lands where it fits in my skull, at its loud size
    [w.tx] = fitInHead(this.g, [w.tx, w.ty], w.wpx, w.hpx, LOUD, true).p;
    go(w, t, [w.tx, w.ty], {
      dur: FLY_T,
      hop: 0,
      mid: [(w.x + w.tx) / 2, Math.min(w.y, w.ty) - 14 * this.s],
      done: () => {
        w.vx = w.vy = 0;
      },
    });
    this.loud = v;
    this.loudSince = t;
  }
  // my head answers: the answer leaves from where its phrase sits and travels out to the agent, the phrase fades
  answer(v: Bot) {
    const t = this.t,
      w = v.wd!;
    v.state = "heard";
    w.die = true;
    if (this.loud === v) this.passLoud();
    const verdict = Math.random() < 0.55 ? "done" : "again";
    const el = document.createElement("span");
    el.className = "word";
    el.innerHTML = verdict === "done" ? DONE : v.word.ans;
    el.style.fontSize = this.fs + "px";
    this.box.appendChild(el);
    // it leaves from where the phrase sits, fitted inside my skull, and grows to its full size on the way out
    const half = el.offsetWidth / 2 + 4,
      F = fitInHead(
        this.g,
        [w.x, w.y],
        el.offsetWidth,
        el.offsetHeight,
        1,
        true,
      );
    const a: Mover = { el, x: F.p[0], y: F.p[1], sc: F.sc, tw: null };
    const to = this.inX(this.above(v), half);
    go(a, t, to, {
      dur: BACK_T,
      hop: 0,
      sc: 1,
      mid: [
        (a.x + to[0]) / 2,
        Math.min(a.y, to[1]) - (verdict === "done" ? 6 : 30) * this.s,
      ],
      done: () => {
        el.classList.remove("on");
        this.later(() => el.remove(), 450);
        this.answers.delete(a);
        this.leave(v, verdict);
      },
    });
    this.answers.add(a);
    drawWord(a);
    el.getBoundingClientRect();
    el.classList.add("on");
  }
  leave(v: Bot, how: "done" | "again") {
    const s = this.s;
    v.state = "out";
    v.sp.v = null;
    const gone = () => {
      v.el.remove();
      this.bots.splice(this.bots.indexOf(v), 1);
    };
    if (how === "done") {
      // done: it rises with its tick and fades
      v.el.className = "ag close";
      v.el.style.opacity = "0";
      go(v, this.t, [v.x + 8 * s, v.y - 26 * s], {
        dur: 0.9,
        sc: s * 0.9,
        hop: 0,
        done: gone,
      });
    } else {
      // an answer: it takes it back to work, off its own side
      const to = this.away(v.sp);
      v.el.className = `ag work ${to[0] < v.x ? "look-l" : "look-r"}`;
      go(v, this.t, to, {
        dur: rnd(1, 1.4),
        sc: s,
        hop: v.sp.side === "top" ? 0 : 3 * s,
        done: gone,
      });
    }
  }
  // attention jumps to someone else still calling (the most recent, give or take)
  passLoud(not?: Bot) {
    const c = this.bots.filter(
      (b) => b.state === "call" && b !== not && b.wd && !b.wd.tw,
    );
    this.loud = c.length
      ? c.sort((a, b) => b.since - a.since + rnd(-1, 1))[0]!
      : null;
    this.loudSince = this.t;
  }
  // already crowded when it comes into view: robots at their spots, their phrases jumbled in my head
  seed() {
    for (const side of ["back", "top", "front", null] as const) {
      const v = this.spawn(
        pick(this.spots.filter((p) => !p.v && (!side || p.side === side))),
        pick(this.pool.filter((w) => !w.busy)),
      );
      v.tw = null;
      v.x = v.sp.x;
      v.y = v.sp.y;
      place(v);
      v.state = "call";
      v.since = -rnd(0, 4);
      v.answerAt = rnd(0.8, 4.5);
      const w = this.phrase(v, [0, 0]);
      w.x = w.tx;
      w.y = w.ty;
      this.drift(w);
      w.a = 1;
      drawPhrase(w, this.g);
    }
    this.loud = this.bots[this.bots.length - 1]!;
    this.loudSince = 0;
  }
  still() {
    (
      [
        [0, 1],
        [4, 3],
        [7, 0],
        [8, 4],
      ] as const
    ).forEach(([si, wi], n) => {
      const v = this.spawn(this.spots[si]!, this.pool[wi]!);
      v.tw = null;
      v.x = v.sp.x;
      v.y = v.sp.y;
      v.state = "call";
      place(v);
      const w = this.phrase(v, [0, 0]);
      w.a = 1;
      w.x = this.g.brain[0] + [-0.5, 0.3, 0.1, -0.2][n]! * this.g.brainR[0];
      w.y = this.g.brain[1] + [-0.8, -0.2, 0.4, 0.95][n]! * this.g.brainR[1];
      if (n === 2) {
        this.loud = v;
        v.el.classList.add("loud");
        w.el.classList.add("loud");
        w.l = 1;
      }
      drawPhrase(w, this.g);
    });
  }

  tick(dt: number) {
    const t = (this.t += dt),
      s = this.s;
    // arrivals: a steady patter with sudden pile-ups, never fewer than 3 for long
    const live = this.bots.filter((b) => b.state !== "out");
    if (t >= this.next) {
      const free = this.spots.filter((p) => !p.v),
        words = this.pool.filter((w) => !w.busy);
      if (live.length < MAX_CROWD && free.length && words.length) {
        // prefer a side that is not already crowded, so they come from all around
        const count = (side: Side) =>
          live.filter((b) => b.sp.side === side).length;
        this.spawn(
          free.sort(
            (a, b) => count(a.side) - count(b.side) + rnd(-0.9, 0.9),
          )[0]!,
          pick(words),
        );
      }
      this.next =
        t +
        (live.length < 3
          ? rnd(0.3, 0.8)
          : Math.random() < 0.35
            ? rnd(0.2, 0.5)
            : rnd(0.9, 2.4));
    }
    // attention snaps away from a loud one that has had its moment
    if (this.loud && t - this.loudSince > 1.8 && Math.random() < dt * 1.4)
      this.passLoud(this.loud);
    if (!this.loud && Math.random() < dt * 2) this.passLoud();

    for (const v of [...this.bots]) {
      if (v.state === "call" && t >= v.answerAt) this.answer(v);
      const bob = stepTween(v, t),
        loud = this.loud === v;
      if (v.loud !== loud) {
        v.loud = loud;
        v.el.classList.toggle("loud", loud);
      }
      // calling: hopping and swaying for attention, harder the longer it waits and while it is the loud one;
      // heard: a quiet bob while its answer comes; nothing while it moves
      const u = clamp((t - v.since) / 6, 0, 1);
      const P =
        v.tw || v.state === "out" || v.state === "in"
          ? idle(v, dt, {})
          : v.state === "heard"
            ? idle(v, dt, { hop: 1.2 * s, hopF: 2.6 })
            : idle(
                v,
                dt,
                loud
                  ? {
                      hop: 5 * s,
                      hopF: 7.5,
                      sway: 7,
                      swayF: 3.1,
                      shuffle: 3 * s,
                    }
                  : {
                      hop: (1.8 + 2 * u) * s,
                      hopF: 4.2 + 2 * u,
                      sway: 2 + 3 * u,
                      swayF: 3.1,
                      shuffle: 3 * s,
                    },
              );
      place(v, bob + P.bob, P.rot, P.dx);
    }

    // the phrases in my head: travelling in, then drifting (a soft spring to a target that keeps moving)
    const fs = this.fs;
    for (const w of [...this.inHead]) {
      if (w.tw) stepTween(w, t);
      else {
        if (!w.die && t >= w.retarget) this.drift(w);
        // phrases jostle: each pushes the others a little apart, so they overlap but rarely cover each other whole
        let px = 0,
          py = 0;
        for (const o of this.inHead)
          if (o !== w && !o.tw && o.a > 0.2) {
            const dx = w.x - o.x,
              dy = w.y - o.y,
              lap = fs * 1.5 - Math.abs(dy);
            if (lap > 0 && Math.abs(dx) < fs * 7) {
              py += Math.sign(dy || rnd(-1, 1)) * lap * 9;
              px += Math.sign(dx || 1) * 6;
            }
          }
        w.vx += ((w.tx - w.x) * 3.2 - w.vx * 2.4 + px) * dt;
        w.vy += ((w.ty - w.y) * 3.2 - w.vy * 2.4 + py) * dt;
        w.x += w.vx * dt;
        w.y += w.vy * dt;
        // never pushed out of my brain's height (where drawPhrase fits it inside the skull)
        const [, by] = this.g.brain,
          bry = this.g.brainR[1] * 1.1;
        if (w.y < by - bry || w.y > by + bry) {
          w.y = clamp(w.y, by - bry, by + bry);
          w.vy = 0;
        }
      }
      const loud = !w.die && this.loud === w.v;
      if (w.loud !== loud) {
        w.loud = loud;
        w.el.classList.toggle("loud", loud);
      }
      w.a += ((w.die ? 0 : 1) - w.a) * Math.min(1, dt * (w.die ? 3.2 : 5));
      w.l += ((loud ? 1 : 0) - w.l) * Math.min(1, dt * 5);
      drawPhrase(w, this.g);
      if (w.die && w.a < 0.02) {
        w.el.remove();
        this.inHead.splice(this.inHead.indexOf(w), 1);
        w.v.wd = null;
        w.v.word.busy = false;
      }
    }
    for (const a of this.answers) {
      stepTween(a, t);
      drawWord(a);
    }
  }
}

/** Draw the head full of agents into `host` and run it while on screen (a still under reduced motion). */
export function mountMindOverload(host: HTMLElement): HeadFigure {
  return new MindOverload(
    host,
    matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
}
