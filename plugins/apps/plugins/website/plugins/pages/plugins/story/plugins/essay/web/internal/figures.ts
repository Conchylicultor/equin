import { createInViewWatcher } from "@plugins/primitives/plugins/dom/plugins/in-view/web";

/* The essay's three small scripted figures, ported verbatim from the prototype's inline script
   (`proto-1794207359-w7ez6h`): each owns the empty box React rendered for it (an `<AnimationHost>`) from
   mount on — its skeleton included, so React owns nothing inside it for the script to write into — runs
   only while on screen, and gets a still under reduced motion. Each mount answers its disposer. */

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** run `start` while at least 30% on screen, `stop` once it is not; answers the disposer */
function whileVisible(
  el: Element,
  start: () => void,
  stop: () => void,
): () => void {
  const io = createInViewWatcher(
    ([e]) => (e?.isIntersecting ? start() : stop()),
    { threshold: 0.3 },
  );
  io.observe(el);
  return () => io.disconnect();
}

/* The chain: clicking a friction makes it the next row's goal, with what I did about it;
   a moment later, that row's own friction shows up on its line. The last goal has no friction left:
   clicked, the stack unwinds one row at a time — each goal is reached, its row folds away under the
   row above, whose friction (that same goal) fades off its line, and so on up to the first. */
const STEPS = [
  {
    goal: "Working with agents",
    fix: "Building my self-reinforcement loop",
    friction: "Bad UX",
  },
  {
    goal: "Bad UX",
    fix: "Change the agent manager UI by injecting plugins",
    friction: "Iterating was painful",
  },
  {
    goal: "Iterating was painful",
    fix: "Create a gateway to test and auto-restart deployments",
    friction: "Too many sessions",
  },
  { goal: "Too many sessions", fix: "Design a queue system" },
];
export function mountFrictionChain(box: HTMLElement): () => void {
  const still = reducedMotion();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const wait = (ms: number) =>
    new Promise<void>((r) => later(r, still ? 0 : ms));
  let pending: ReturnType<typeof setTimeout> | undefined,
    run = 0,
    disposed = false;
  const text = (tag: string, cls: string, words: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.textContent = words;
    return e;
  };
  function step(i: number, delay: boolean): HTMLElement {
    const st = STEPS[i]!,
      last = i === STEPS.length - 1;
    const el = document.createElement("div");
    el.className = "step";
    const r = document.createElement("div");
    r.className = "r";
    const ln = document.createElement("div");
    ln.className = "ln";
    r.append(text("span", "", "Me"), ln, text("span", "", st.goal));
    el.append(r, text("span", "desc", st.fix));
    const arm = () => {
      if (last) {
        // the last fix clears the way: its goal pulses, and clicking it unwinds the stack
        const g = document.createElement("button");
        g.className = "goal pulse" + (delay ? " appear" : "");
        g.type = "button";
        g.textContent = st.goal;
        g.title = "Done";
        g.addEventListener("click", () => {
          g.disabled = true;
          g.classList.remove("pulse", "appear");
          void unwind();
        });
        r.lastElementChild!.replaceWith(g);
        return;
      }
      const b = document.createElement("button");
      b.className = "on pulse" + (delay ? " appear" : "");
      b.type = "button";
      b.textContent = st.friction!;
      b.addEventListener("click", () => {
        b.disabled = true;
        b.className = "on";
        box.append(step(i + 1, true));
      });
      ln.append(b);
    };
    if (delay && !still) pending = later(arm, 1400);
    else arm();
    return el;
  }
  const reach = (row: Element) => {
    const goal = row.querySelector(".r > :last-child")!;
    goal.classList.add("reached");
    goal.append(text("span", "tick", " ✓"));
  };
  async function unwind() {
    const id = ++run,
      rows = [...box.children];
    for (let k = rows.length - 1; k >= 0; k--) {
      reach(rows[k]!);
      await wait(750);
      if (id !== run || disposed) return;
      if (k === 0) break;
      rows[k]!.classList.add("unq"); // the row folds away under the one above…
      rows[k - 1]!.querySelector(".ln .on")?.classList.add("gone"); // …whose friction, now fixed, fades off its line
      await wait(480);
      if (id !== run || disposed) return;
      rows[k]!.remove();
      rows[k - 1]!.querySelector(".ln .on")?.remove();
    }
    box.append(again());
  }
  function again() {
    const b = document.createElement("button");
    b.className = "again";
    b.type = "button";
    b.textContent = "↺";
    b.title = "From the start";
    b.addEventListener("click", () => {
      if (pending !== undefined) clearTimeout(pending);
      run++;
      box.replaceChildren(step(0, false));
    });
    return b;
  }
  box.replaceChildren(step(0, false));
  return () => {
    disposed = true;
    for (const t of timers) clearTimeout(t);
    box.replaceChildren();
  };
}

/* "Me → Friction": once on screen, a new friction lands on the line. */
export function mountNewFriction(fig: HTMLElement): () => void {
  const r = document.createElement("div");
  r.className = "r";
  const me = document.createElement("span");
  me.textContent = "Me";
  const ln = document.createElement("div");
  ln.className = "ln";
  const friction = document.createElement("span");
  friction.className = "hl";
  friction.textContent = "Friction";
  r.append(me, ln, friction);
  fig.replaceChildren(r);
  const add = () => {
    if (ln.querySelector(".on")) return;
    const t = document.createElement("span");
    t.className = "on appear";
    t.textContent = "New friction";
    ln.append(t);
  };
  if (reducedMotion()) {
    add();
    return () => fig.replaceChildren();
  }
  let t: ReturnType<typeof setTimeout> | undefined;
  const stop = whileVisible(
    fig,
    () => {
      t = setTimeout(add, 1200);
    },
    () => clearTimeout(t),
  );
  return () => {
    stop();
    clearTimeout(t);
    fig.replaceChildren();
  };
}

/* The backlog: the same tasks arrive on both sides, irregularly, sometimes several at once.
   On the left they pile up and keep ageing; on the right an agent picks each one up,
   deploys it, and it is gone. */
const POOL = [
  "Add dark mode to Pages",
  "Fix scroll jump in sidebar",
  "Undo after deleting a block",
  "Sync settings across tabs",
  "Paste markdown as blocks",
  "Tooltip clipped on mobile",
  "Empty state for Places",
  "Drag to reorder favorites",
  "Show unread count in title",
  "Calendar week starts on Monday",
  "Faster search in Mail",
  "Keyboard shortcut for Wish",
  "Export a page as PDF",
  "Retry a failed build",
  "Group conversations by task",
  "Crash when a tab closes",
  "Pin a conversation",
  "Resize the sidebar",
  "Copy link to a block",
  "Offline banner",
];
/** One side of the backlog: its heading with the open count, and the box its rows land in. */
function backlogSide(heading: string, highlight: boolean) {
  const side = document.createElement("div");
  side.className = "side";
  const h = document.createElement("h4");
  const n = document.createElement("span");
  n.dataset.n = "";
  if (highlight) n.className = "hl";
  n.textContent = "0 open";
  h.append(heading + " ", n);
  const list = document.createElement("div");
  list.className = "rowsbox";
  side.append(h, list);
  return { side, n, list };
}
export function mountBacklog(fig: HTMLElement): () => void {
  const L = backlogSide("Task list", false),
    R = backlogSide("Agents + no friction", true);
  const more = document.createElement("div");
  // the "+ N more" line keeps its place while empty, so its arrival moves nothing below
  more.className = "more off";
  more.textContent = "+ 0 more";
  L.side.append(more);
  fig.replaceChildren(L.side, R.side);
  const SHOWN = 5,
    DAYS_PER_SEC = 3;
  const lList = L.list,
    rList = R.list;
  interface Open {
    title: string;
    born: number;
    el: HTMLElement;
  }
  let open: Open[] = [],
    k = Math.floor(Math.random() * POOL.length),
    timer: ReturnType<typeof setTimeout> | 0 = 0,
    ageTimer: ReturnType<typeof setTimeout> | undefined,
    clock = 0,
    last = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const now = () => clock + (last ? (performance.now() - last) / 1000 : 0);
  function age(d: number) {
    if (d < 1) return "new";
    if (d < 7) return Math.floor(d) + (d < 2 ? " day" : " days");
    if (d < 30) return Math.floor(d / 7) + (d < 14 ? " week" : " weeks");
    if (d < 365) return Math.floor(d / 30) + (d < 60 ? " month" : " months");
    return Math.floor(d / 365) + (d < 730 ? " year" : " years");
  }
  function row(title: string, meta: string, busy = false) {
    const el = document.createElement("div");
    el.className = "t enter";
    const a = document.createElement("span");
    a.textContent = title;
    const b = document.createElement("span");
    if (busy) {
      const s = document.createElement("span");
      s.className = "busy";
      s.textContent = meta;
      b.append(s);
    } else b.textContent = meta;
    el.append(a, b);
    return el;
  }
  function enter(list: HTMLElement, el: HTMLElement) {
    list.prepend(el);
    void el.offsetHeight;
    el.classList.remove("enter");
  }
  function exit(el: HTMLElement) {
    el.classList.add("exit");
    later(() => el.remove(), 480);
  }
  function count(side: { n: HTMLElement }, n: number) {
    side.n.textContent = n + " open";
  }
  function arrive() {
    const title = POOL[k++ % POOL.length]!;
    // left: on top of the pile; the one pushed past the fold folds into "+ N more"
    const t = { title, born: now(), el: row(title, "new") };
    open.unshift(t);
    enter(lList, t.el);
    if (open.length > SHOWN) exit(open[SHOWN]!.el);
    count(L, open.length);
    // a new row's age moves first: the age clock wakes for it (only while the figure runs)
    if (timer) tickAges();
    more.classList.toggle("off", open.length <= SHOWN);
    more.textContent = `+ ${open.length - SHOWN} more`;
    // right: an agent takes it, deploys it, and it leaves
    const el = row(title, "agent working", true);
    enter(rList, el);
    count(R, rList.querySelectorAll(".t:not(.done):not(.exit)").length);
    later(
      () => {
        el.classList.add("done");
        el.firstElementChild!.classList.add("x");
        el.lastElementChild!.textContent = "deployed";
        count(R, rList.querySelectorAll(".t:not(.done):not(.exit)").length);
        later(() => exit(el), 700);
      },
      1000 + Math.random() * 2000,
    );
  }
  // the age a label shows next, in days: where `age(d)` next reads differently
  function nextAge(d: number) {
    if (d < 1) return 1;
    if (d < 7) return Math.floor(d) + 1;
    if (d < 30) return Math.min((Math.floor(d / 7) + 1) * 7, 30);
    if (d < 365) return Math.min((Math.floor(d / 30) + 1) * 30, 365);
    return (Math.floor(d / 365) + 1) * 365;
  }
  // Each shown row's age, written only when its label changes, then asleep until the soonest one
  // changes next — a label rewritten with its own text is still a text node replaced every tick.
  function tickAges() {
    clearTimeout(ageTimer);
    const t = now();
    let soonest = Infinity;
    open.slice(0, SHOWN).forEach((x) => {
      const d = (t - x.born) * DAYS_PER_SEC;
      const label = age(d);
      const meta = x.el.lastElementChild!;
      if (meta.textContent !== label) meta.textContent = label;
      soonest = Math.min(soonest, (nextAge(d) - d) / DAYS_PER_SEC);
    });
    ageTimer =
      soonest === Infinity
        ? undefined
        : setTimeout(tickAges, Math.ceil(soonest * 1000) + 1);
  }
  function next() {
    const burst = Math.random() < 0.18 ? 2 + Math.floor(Math.random() * 2) : 1;
    for (let i = 0; i < burst; i++) later(arrive, i * 160);
    timer = setTimeout(next, 750 + Math.random() * 1700);
  }
  if (reducedMotion()) {
    for (let i = 0; i < 14; i++) {
      const x = { title: POOL[i]!, born: -i * 9, el: row(POOL[i]!, "") };
      x.el.classList.remove("enter");
      open.push(x);
    }
    open.slice(0, SHOWN).forEach((x) => lList.append(x.el));
    tickAges();
    clearTimeout(ageTimer);
    count(L, 14);
    more.classList.remove("off");
    more.textContent = `+ ${14 - SHOWN} more`;
    return () => fig.replaceChildren();
  }
  const stop = whileVisible(
    fig,
    () => {
      if (timer) return;
      last = performance.now();
      next();
      tickAges();
    },
    () => {
      clock = now();
      last = 0;
      if (timer) clearTimeout(timer);
      clearTimeout(ageTimer);
      timer = 0;
    },
  );
  return () => {
    stop();
    if (timer) clearTimeout(timer);
    clearTimeout(ageTimer);
    for (const t of timers) clearTimeout(t);
    open = [];
    fig.replaceChildren();
  };
}
