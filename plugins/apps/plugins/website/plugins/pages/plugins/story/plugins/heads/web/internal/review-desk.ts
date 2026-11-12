import {
  FRAME,
  HEAD,
  LOUD,
  DONE,
  Thought,
  botScale,
  clamp,
  figureCss,
  go,
  headGeom,
  headHeight,
  headSVG,
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
  type Pt,
} from "./kit";

/* <review-desk>, ported from the prototype's `heads.js` (`proto-1794207359-w7ez6h`): ideas leave my head as
   agents that work in the background, come back to wait in a line in front of me, and are reviewed one at a
   time: closed, or sent back to work. */

/* ================================================================== the logic
   No drawing here: one attention (a review or an idea, never both), agents working in the back, and the
   line in front of me. Runs of attention — a sprint of quick reviews, a burst of ideas, or a steady mix —
   are drawn from weights that lean against the line's length, so it wanders between 2 and 7 and empties as
   often as it grows (simulated over 4 h: mean ≈ 4.6, every length 2–7 visited, 2→7 rises and 7→2 drains alike in number and pace). A
   finished agent joins the line only while there is room; otherwise it keeps working. */
const MAX_LINE = 7,
  MIN_WAIT = 2;
const WALK_IN = 1.5,
  IDEA_T = 1.7,
  STEP_T = 0.5,
  SEND_T = 0.8,
  REPLY_T = 0.75;
type Verdict = "done" | "again";
interface Agent {
  id: number;
  st: "idea" | "back" | "line" | "gone";
  due?: number;
  ready?: number;
  arrive?: number;
}
interface Attention {
  kind: "idea" | "review";
  a: Agent;
  end: number;
  reply?: number;
  replyAt?: number;
  verdict?: Verdict;
}
interface Phase {
  kind: "sprint" | "ideas" | "steady";
  left: number;
}
interface DeskHandlers {
  toLine(a: Agent): void;
  shift(): void;
  review(a: Agent, send: number): void;
  reply(a: Agent, verdict: Verdict, dur: number): void;
  close(a: Agent): void;
  sendBack(a: Agent): void;
  idea(a: Agent, dur: number): void;
  working(a: Agent): void;
}
interface DeskModel {
  t: number;
  back: Agent[];
  line: Agent[];
  att: Attention | null;
  att0: Attention | null;
  next: number;
  phase: Phase | null;
  ids: number;
  cap: number;
  step(dt: number): void;
  seed(nBack: number, nLine: number): { back: Agent[]; line: Agent[] };
}
function deskModel(
  rand: () => number,
  cap: number,
  on: DeskHandlers,
): DeskModel {
  const R = (a: number, b: number) => a + rand() * (b - a),
    X = (mean: number) => -Math.log(1 - rand()) * mean;
  const m: DeskModel = {
    t: 0,
    back: [],
    line: [],
    att: null,
    att0: null,
    next: 0.6,
    phase: null,
    ids: 0,
    cap,
    step: () => {},
    seed: () => ({ back: [], line: [] }),
  };
  const L = () => m.line.length;
  const pace = () => Math.min(1, Math.max(0.55, m.cap / 9)); // fewer desks, shorter jobs: the same flow back to the line
  // what attention does next comes in runs: a sprint of quick reviews (the line empties fast), a burst
  // of ideas (the line grows a few seconds later, as the agents come back), or a steady mix. The run is
  // drawn from weights that lean against the line's length, so it wanders the whole 2–7 range.
  function choosePhase(): Phase {
    const l = L(),
      room = m.cap - m.back.length,
      u = (l - MIN_WAIT) / (MAX_LINE - MIN_WAIT);
    const wS = l <= MIN_WAIT ? 0 : 0.1 + 4.4 * u * u;
    const wI = room <= 0 ? 0 : 0.15 + 3.4 * (1 - u) * (1 - u);
    const wM = 0.7;
    let r = rand() * (wS + wI + wM);
    if ((r -= wS) < 0)
      return { kind: "sprint", left: 3 + Math.floor(rand() * 3) };
    if ((r -= wI) < 0)
      return { kind: "ideas", left: 1 + Math.floor(rand() * 2) };
    return { kind: "steady", left: 2 + Math.floor(rand() * 3) };
  }
  // a review leaves at least MIN_WAIT agents standing in the line (ones still walking in do not count)
  const canReview = () =>
    L() > MIN_WAIT &&
    m.line[0]!.ready! <= m.t &&
    m.line.filter((a, i) => i > 0 && (a.arrive ?? 0) <= m.t).length >= MIN_WAIT;
  const canIdea = () => m.back.length < m.cap;
  function pickNext() {
    if (!m.phase || m.phase.left <= 0) m.phase = choosePhase();
    const p = m.phase;
    let act: "fast" | "slow" | "idea" | null = null;
    if (p.kind === "sprint") act = canReview() ? "fast" : null;
    else if (p.kind === "ideas") act = canIdea() ? "idea" : null;
    else
      act =
        canReview() &&
        (!canIdea() ||
          rand() < 0.25 + 0.65 * ((L() - MIN_WAIT) / (MAX_LINE - MIN_WAIT)))
          ? "slow"
          : canIdea()
            ? "idea"
            : null;
    if (!act) {
      // the front agent is still walking up: wait for it rather than drop the run
      if (L() > MIN_WAIT && p.kind !== "ideas") {
        m.next = m.t + 0.15;
        return;
      }
      m.phase = null;
      m.next = m.t + R(0.2, 0.6);
      return;
    }
    p.left--;
    if (act === "idea") {
      const a: Agent = { id: ++m.ids, st: "idea" };
      m.att = { kind: "idea", a, end: m.t + IDEA_T };
      m.back.push(a); // holds its place at work from the moment it is thought of
      on.idea(a, IDEA_T);
    } else {
      // its thought travels to me, I think it over, and the verdict travels back to it
      const fast = act === "fast",
        send = fast ? SEND_T * 0.7 : SEND_T,
        reply = fast ? REPLY_T * 0.75 : REPLY_T;
      const a = m.line[0]!,
        d = fast ? R(0.2, 0.45) : R(1.1, 2.4);
      m.att = {
        kind: "review",
        a,
        reply,
        replyAt: m.t + send + d,
        end: m.t + send + d + reply,
      };
      on.review(a, send);
    }
  }
  function endAttention() {
    const att = (m.att0 = m.att!),
      { kind, a } = att;
    m.att = null;
    if (kind === "idea") {
      a.st = "back";
      a.due = m.t + (10 + X(12)) * pace();
      on.working(a);
      return;
    }
    m.line.shift();
    for (const b of m.line) b.ready = Math.max(b.ready ?? 0, m.t + STEP_T);
    if (att.verdict === "done") {
      a.st = "gone";
      on.close(a);
    } else {
      a.st = "back";
      a.due = m.t + (9 + X(10)) * pace();
      m.back.push(a);
      on.sendBack(a);
    }
    on.shift();
  }
  m.step = (dt) => {
    m.t += dt;
    for (const a of [...m.back])
      if (a.st === "back" && m.t >= a.due!) {
        if (L() >= MAX_LINE) {
          a.due = m.t + R(0.6, 1.6);
          continue;
        }
        m.back.splice(m.back.indexOf(a), 1);
        a.st = "line";
        a.ready = a.arrive = m.t + WALK_IN;
        m.line.push(a);
        on.toLine(a);
      }
    if (m.att?.kind === "review" && !m.att.verdict && m.t >= m.att.replyAt!) {
      m.att.verdict =
        m.back.length >= m.cap || rand() < 0.66 ? "done" : "again";
      on.reply(m.att.a, m.att.verdict, m.att.reply!);
    }
    if (m.att && m.t >= m.att.end) {
      const fast = m.phase?.kind === "sprint";
      endAttention();
      m.next = m.t + (fast ? R(0.1, 0.3) : R(0.4, 1.1));
    }
    if (!m.att && m.t >= m.next) pickNext();
  };
  m.seed = (nBack, nLine) => {
    const made: { back: Agent[]; line: Agent[] } = { back: [], line: [] };
    for (let i = 0; i < nBack; i++) {
      const a: Agent = { id: ++m.ids, st: "back", due: R(2, 16) };
      m.back.push(a);
      made.back.push(a);
    }
    for (let i = 0; i < nLine; i++) {
      const a: Agent = { id: ++m.ids, st: "line", ready: 0 };
      m.line.push(a);
      made.line.push(a);
    }
    return made;
  };
  return m;
}

/* ================================================================== the drawing */
const TASKS = [
  "login",
  "theme",
  "flaky",
  "boot",
  "undo",
  "search",
  "export",
  "retry",
  "empty",
  "api",
  "intro",
  "hints",
  "query",
  "a11y",
  "sync",
  "share",
  "cache",
  "db",
  "icons",
  "pay",
];
// what an agent coming back to the line asks, and what I reply when I send it back to work. Names (TASKS,
// WORDS) and questions are kept short, so `name · question` reads at full size even in a phone-sized head.
const ASKS = [
  ["review?", "tighten"],
  ["done?", "ship it"],
  ["failed", "rerun"],
  ["stuck", "dig in"],
  ["waiting", "approved"],
  ["which?", "the first"],
  ["bump?", "not yet"],
  ["ready?", "go on"],
] as const;

interface Spot {
  x: number;
  y: number;
  v: View | null;
  sc?: number;
}
interface View extends Mover {
  a: Agent;
  name: string;
  spot: Spot | null;
  ph: number;
  base: string;
  hold?: number | null;
  pending?: () => void;
  moveAt?: number;
  ask?: (typeof ASKS)[number];
  bob?: number;
  rot?: number;
}

class ReviewDesk implements HeadFigure {
  box: HTMLDivElement;
  deskEl: HTMLDivElement;
  thought: Thought;
  views = new Map<number, View>();
  t = 0;
  W = 0;
  s = 1;
  step = 0;
  frontX = 0;
  deskY = 0;
  cap = 4;
  g!: HeadGeom;
  spots: Spot[] = [];
  model: DeskModel | null = null;
  timers = new Set<ReturnType<typeof setTimeout>>();
  loop: ReturnType<typeof loop> | null = null;
  stopObs: (() => void) | null = null;

  constructor(
    private host: HTMLElement,
    reduced: boolean,
  ) {
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${figureCss(`
        .desk { position: absolute; height: 0; border-top: 1px solid var(--fg3); opacity: .5; }
        .ag.review, .ag.close { z-index: 3; }`)}</style><div class="box"><div class="desk"></div><span class="word"></span><span class="word"></span></div>`;
    this.box = root.querySelector<HTMLDivElement>(".box")!;
    this.deskEl = root.querySelector<HTMLDivElement>(".desk")!;
    this.thought = new Thought(this, [
      ...root.querySelectorAll<HTMLElement>(".word"),
    ]);
    this.layout();
    const model = (this.model = deskModel(
      Math.random,
      this.cap,
      this.handlers(),
    ));
    const seed = model.seed(Math.min(6, this.cap), 4);
    for (const a of seed.back) {
      const v = this.make(a);
      const s = this.takeSpot(v);
      v.x = s.x;
      v.y = s.y;
      v.sc = s.sc ?? this.s;
      this.toWork(v);
    }
    seed.line.forEach((a, i) => {
      const v = this.make(a);
      [v.x, v.y] = this.linePos(i);
      this.cls(v, "wait look-l");
    });
    for (const v of this.views.values()) place(v);
    if (reduced) {
      this.still();
      return;
    }
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

  /* ---------- layout: everything derives from the width */
  layout() {
    const W = Math.max(this.host.clientWidth || 300, 240);
    if (this.W === W) return;
    this.W = W;
    const H = headHeight(W),
      s = (this.s = botScale(W)),
      k = H / FRAME.h;
    // room above the head for the ideas leaving it; on a narrow figure, more, for a taller work floor
    const P = Math.round(30 + 0.1 * H + (W < 520 ? 44 : 0));
    // the line stands on the desk in front of me, a clear step ahead of my chin; one fixed step, so it never
    // breathes with its length. On a narrow figure the back of my head slides out of the frame to make room.
    const off = clamp((W - 600) / 4, 0, 28);
    const front0 = (HEAD.chin - FRAME.x) * k + 15 * s + 14 * s + off,
      end = W - 15 * s - 6;
    const want = 40 * s,
      least = 31 * s;
    let shift = 0,
      step = Math.min(want, (end - front0) / (MAX_LINE - 1));
    if (step < least) {
      shift = Math.min(
        0.28 * FRAME.w * k,
        least * (MAX_LINE - 1) - (end - front0),
      );
      step = (end - front0 + shift) / (MAX_LINE - 1);
    }
    const sceneR = W - 6;
    const g = (this.g = headGeom(H, off - shift, P));
    this.step = step;
    this.frontX = front0 - shift;
    this.deskY = P + H;
    this.box.style.height = this.deskY + 10 + "px";
    this.box.querySelector(".head")?.remove();
    this.box.insertAdjacentHTML("afterbegin", headSVG(g));
    this.deskEl.style.cssText = `left:${(g.X(HEAD.neck) + 4).toFixed(1)}px;width:${(sceneR - g.X(HEAD.neck) - 4).toFixed(1)}px;top:${this.deskY}px`;
    for (const el of this.thought.els) el.style.fontSize = phraseFont(W) + "px";
    // the work floor: over on the right, well away from my face, above the line (and beside its far end)
    const x1 = W - 34 * s,
      x0 = Math.max(g.X(HEAD.face) + 80 * s, x1 - 290 * s),
      y0 = 18 + 36 * s,
      y1 = this.deskY - 36 * s - 30 * s; // 34: room for a hammer or a screen
    const lineEnd = this.frontX + (MAX_LINE - 1) * step + 34 * s;
    const spots: Spot[] = [],
      d = 46 * s;
    for (let tries = 0; tries < 900 && spots.length < 24; tries++) {
      const x = rnd(x0, x1),
        y = rnd(y0, x > lineEnd ? this.deskY - 4 : y1);
      if (y > y1 && x <= lineEnd) continue;
      // farther up the floor is farther away: a touch smaller
      if (spots.every((p) => Math.hypot(p.x - x, (p.y - y) * 1.25) > d))
        spots.push({
          x,
          y,
          v: null,
          sc: s * (0.84 + 0.16 * clamp((y - y0) / (y1 - y0), 0, 1)),
        });
    }
    this.spots = spots;
    this.cap = clamp(spots.length - 1, 4, 9);
    if (this.model) {
      this.model.cap = this.cap;
      this.reseat();
    }
  }
  reseat() {
    // a resize re-seats everyone at once
    for (const v of this.views.values()) {
      v.tw = null;
      if (v.spot) {
        v.spot = null;
        const s = this.takeSpot(v);
        v.x = s.x;
        v.y = s.y;
        v.sc = s.sc ?? this.s;
      }
    }
    this.model!.line.forEach((a, i) => {
      const v = this.views.get(a.id)!;
      [v.x, v.y] = this.linePos(i);
      v.sc = this.s * (v.el.classList.contains("review") ? 1.18 : 1);
    });
    for (const v of this.views.values()) place(v);
  }
  linePos(i: number): Pt {
    return [this.frontX + i * this.step, this.deskY - 0.5];
  }
  takeSpot(v: View, near?: Pt): { x: number; y: number; sc?: number } {
    const free = this.spots.filter((s) => !s.v);
    if (!free.length) return { x: v.x, y: v.y };
    const used = this.spots.filter((s) => s.v);
    // any free spot with elbow room (scattered, not packed at the edges); a mover keeps to its neighbourhood
    const room = (s: Spot) =>
      Math.min(110, ...used.map((u) => Math.hypot(u.x - s.x, u.y - s.y)));
    const best = Math.max(...free.map(room)),
      ok = free.filter((s) => room(s) >= Math.min(best, 75 * this.s));
    const s = near
      ? ok.sort(
          (a, b) =>
            Math.hypot(near[0] - a.x, near[1] - a.y) -
            Math.hypot(near[0] - b.x, near[1] - b.y),
        )[Math.floor(Math.random() * Math.min(3, ok.length))]!
      : pick(ok);
    s.v = v;
    v.spot = s;
    return s;
  }
  freeSpot(v: View) {
    if (v.spot) {
      v.spot.v = null;
      v.spot = null;
    }
  }

  /* ---------- agents */
  make(a: Agent): View {
    const el = makeBot(this.box, this.thought.els[0]);
    const name = pick(
      TASKS.filter((n) => ![...this.views.values()].some((v) => v.name === n)),
    );
    const v: View = {
      a,
      el,
      name,
      x: 0,
      y: 0,
      sc: this.s,
      tw: null,
      spot: null,
      ph: rnd(0, 6.3),
      base: "",
    };
    this.views.set(a.id, v);
    return v;
  }
  cls(v: View, c: string) {
    v.base = c;
    v.el.className = "ag " + c;
  }
  toWork(v: View) {
    // settle in and get busy: a hammer or a screen, facing either way; now and then move to another spot
    const flip = Math.random() < 0.5;
    this.cls(
      v,
      `work busy ${Math.random() < 0.5 ? "hammer" : "screen"}${flip ? " flip" : ""}`,
    );
    v.moveAt = this.t + rnd(3, 8);
  }
  thoughtAbove(v: View): Pt {
    return [v.x, v.y - 48 * this.s];
  }

  handlers(): DeskHandlers {
    const s = () => this.s;
    const view = (a: Agent) => this.views.get(a.id)!;
    return {
      toLine: (a) => {
        const v = view(a);
        this.freeSpot(v);
        this.cls(v, "done look-l");
        v.tw = null;
        // a little "!" jump where it worked, then off to the end of the line
        v.hold = this.t + 0.35;
        v.pending = () => {
          const to = this.linePos(this.model!.line.indexOf(a));
          this.cls(v, "wait look-l");
          go(v, this.t, to, {
            dur: WALK_IN - 0.35,
            sc: s(),
            mid: [(v.x + to[0]) / 2, Math.min(v.y, to[1]) - 24 * s()],
            hop: 3 * s(),
          });
        };
      },
      shift: () => {
        this.model!.line.forEach((a, i) => {
          const v = view(a),
            p = this.linePos(i);
          // still walking in: it heads for its new place from where it is now (moving the old tween's end would
          // snap it forward by a whole step near the end of its walk)
          if (v.tw && v.tw.t0 <= this.t) {
            const tw = v.tw;
            go(v, this.t, p, {
              dur: Math.max(STEP_T, tw.t0 + tw.dur - this.t),
              sc: tw.sc1,
              mid: [(v.x + p[0]) / 2, Math.min(v.y, p[1]) - 6 * s()],
              hop: tw.hop,
              ...(tw.done ? { done: tw.done } : {}),
            });
          } else if (v.tw)
            v.tw.to = p; // not started yet: nothing has moved
          else if (!v.hold)
            go(v, this.t + 0.12 + i * 0.05, p, {
              dur: STEP_T,
              mid: [(v.x + p[0]) / 2, p[1] - 4 * s()],
              hop: 2 * s(),
            });
        });
      },
      review: (a, send) => {
        const v = view(a),
          g = this.g;
        this.cls(v, "review look-l");
        go(v, this.t, [v.x, v.y], { dur: 0.3, sc: s() * 1.18, hop: 0 });
        // its question rises off it and travels into my head, loud while I think it over
        v.ask = pick(ASKS);
        this.thought.say(
          phrase(v.name, v.ask[0]),
          this.thoughtAbove(v),
          g.brain,
          send,
          { lift: 10, sc: LOUD, swap: true },
        );
      },
      reply: (a, verdict, dur) => {
        const v = view(a),
          g = this.g;
        // my answer travels back to the agent while its question fades from my head: a tick (done), or a reply
        // it takes back to work
        if (verdict === "done")
          this.thought.say(DONE, g.brain, this.thoughtAbove(v), dur, {
            lift: 6,
            swap: true,
            done: () => this.cls(v, "review close look-l"),
          });
        else
          this.thought.say(v.ask![1], g.brain, this.thoughtAbove(v), dur, {
            lift: 34 * s(),
            swap: true,
            done: () => this.cls(v, "wait look-l"),
          });
      },
      close: (a) => {
        const v = view(a);
        this.thought.hush();
        this.cls(v, "close");
        go(v, this.t, [v.x + 8 * s(), v.y - 26 * s()], {
          dur: 0.9,
          sc: s() * 0.9,
          hop: 0,
          done: () => {
            v.el.remove();
            this.views.delete(a.id);
          },
        });
        this.later(() => (v.el.style.opacity = "0"), 350);
      },
      sendBack: (a) => {
        const v = view(a),
          sp = this.takeSpot(v);
        this.thought.hush();
        this.cls(v, "work look-r");
        // up and over the line, back to the work floor
        go(v, this.t, [sp.x, sp.y], {
          dur: 1.2,
          sc: sp.sc ?? s(),
          mid: [v.x + (sp.x - v.x) * 0.7, Math.min(v.y, sp.y) - 50 * s()],
          hop: 0,
          done: () => this.toWork(v),
        });
      },
      idea: (a, dur) => {
        const g = this.g,
          v = this.make(a),
          sp = this.takeSpot(v);
        const [bx, by] = g.brain;
        // a thought forms in my head and leaves it in a cloud that floats up off my crown, then turns into an
        // agent that runs off to work — so nothing is left in my head
        const cx = g.X(FRAME.x + FRAME.w * 0.62),
          cy = g.top(cx) - 2;
        this.thought.say(v.name, [bx, by + 6], [bx, by], 0.3, {
          done: () =>
            this.thought.say(
              v.name,
              [bx, by],
              [cx + 10 * s(), cy - 40 * s()],
              0.45,
            ),
        });
        this.cls(v, "idea");
        v.x = cx;
        v.y = cy + 6;
        v.sc = 0.2;
        place(v);
        go(v, this.t, [cx + 10 * s(), cy - 8 * s()], {
          dur: 0.7,
          sc: s() * 0.95,
          hop: 0,
        });
        v.hold = this.t + 0.8;
        v.pending = () => {
          this.thought.hush();
          this.cls(v, "idea look-r");
          this.later(() => this.cls(v, "work look-r"), 180);
          go(v, this.t, [sp.x, sp.y], {
            dur: dur - 0.8,
            sc: sp.sc ?? s(),
            mid: [(v.x + sp.x) / 2, Math.min(v.y, sp.y) - 30 * s()],
            hop: 0,
            done: () => this.toWork(v),
          });
        };
      },
      working: () => this.thought.hush(),
    };
  }

  still() {
    const v = this.views.get(this.model!.line[0]!.id)!;
    this.cls(v, "review look-l");
    v.sc = this.s * 1.18;
    place(v);
    this.thought.say(
      phrase(v.name, pick(ASKS)[0]),
      this.g.brain,
      this.g.brain,
      1,
      { sc: LOUD },
    );
    this.thought.tw = null;
  }

  tick(dt: number) {
    const t = (this.t += dt),
      s = this.s;
    this.model!.step(dt);
    for (const v of [...this.views.values()]) {
      if (v.hold != null && t >= v.hold) {
        v.hold = null;
        v.pending!();
      }
      // the tween may start a beat late (the line steps up one after another)
      let bob = v.tw && t < v.tw.t0 ? 0 : stepTween(v, t),
        rot = 0;
      const c = v.base;
      if (!v.tw) {
        if (c.startsWith("work")) {
          // busy: quick bobs in time with the work, a shimmy, and now and then a move to another spot
          bob = -Math.abs(Math.sin(t * 9 + v.ph)) * 1.6 * s;
          rot = Math.sin(t * 4.5 + v.ph) * 3;
          if (v.spot && t >= v.moveAt! && this.spots.some((p) => !p.v)) {
            const from: Pt = [v.x, v.y],
              old = v.spot,
              sp = this.takeSpot(v, from);
            old.v = null;
            this.cls(v, `work ${sp.x < v.x ? "look-l" : "look-r"}`);
            go(v, t, [sp.x, sp.y], {
              sc: sp.sc ?? s,
              dur: clamp(
                Math.hypot(sp.x - v.x, sp.y - v.y) / (110 * s),
                0.6,
                1.6,
              ),
              hop: 3 * s,
              done: () => this.toWork(v),
            });
            v.moveAt = Infinity;
          }
        } else if (c.startsWith("done"))
          bob = -Math.abs(Math.sin(t * 14)) * 5 * s;
        else if (c.startsWith("wait")) bob = Math.sin(t * 1.6 + v.ph) * 0.5;
        else if (c.startsWith("review"))
          bob = -Math.abs(Math.sin(t * 2.6)) * 1.2 * s;
        else if (c.startsWith("idea")) bob = Math.sin(t * 5 + v.ph) * 1.5;
      }
      // the pose follows through a short low-pass, so a change of state (or a walk re-aimed mid-hop) bends it
      // rather than snapping it
      const k = Math.min(1, dt * 30);
      v.bob = (v.bob ?? bob) + (bob - (v.bob ?? bob)) * k;
      v.rot = (v.rot ?? rot) + (rot - (v.rot ?? rot)) * k;
      place(v, v.bob, v.rot);
    }
    this.thought.step(t);
  }
}

/** Draw the review desk into `host` and run it while on screen (a still under reduced motion). */
export function mountReviewDesk(host: HTMLElement): HeadFigure {
  return new ReviewDesk(
    host,
    matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
}
