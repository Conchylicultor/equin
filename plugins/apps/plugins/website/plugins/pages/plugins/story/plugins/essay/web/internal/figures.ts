import { createInViewWatcher } from "@plugins/primitives/plugins/dom/plugins/in-view/web";

/* The essay's three small scripted figures, ported verbatim from the prototype's inline script
   (`proto-1794207359-w7ez6h`): each owns the box React rendered for it from mount on, runs only while on
   screen, and gets a still under reduced motion. Each mount answers its disposer. */

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
  const add = () => {
    if (fig.querySelector(".on")) return;
    const t = document.createElement("span");
    t.className = "on appear";
    t.textContent = "New friction";
    fig.querySelector(".ln")!.append(t);
  };
  if (reducedMotion()) {
    add();
    return () => {};
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
export function mountBacklog(fig: HTMLElement): () => void {
  const [L, R] = fig.querySelectorAll<HTMLElement>(".side") as unknown as [
    HTMLElement,
    HTMLElement,
  ];
  const SHOWN = 5,
    DAYS_PER_SEC = 3;
  const lList = L.querySelector<HTMLElement>("[data-list]")!,
    rList = R.querySelector<HTMLElement>("[data-list]")!;
  const more = L.querySelector<HTMLElement>("[data-more]")!;
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
  function count(side: HTMLElement, n: number) {
    side.querySelector("[data-n]")!.textContent = n + " open";
  }
  function arrive() {
    const title = POOL[k++ % POOL.length]!;
    // left: on top of the pile; the one pushed past the fold folds into "+ N more"
    const t = { title, born: now(), el: row(title, "new") };
    open.unshift(t);
    enter(lList, t.el);
    if (open.length > SHOWN) exit(open[SHOWN]!.el);
    count(L, open.length);
    more.hidden = open.length <= SHOWN;
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
  function tickAges() {
    const t = now();
    open.slice(0, SHOWN).forEach((x) => {
      x.el.lastElementChild!.textContent = age((t - x.born) * DAYS_PER_SEC);
    });
    ageTimer = setTimeout(tickAges, 250);
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
    more.hidden = false;
    more.textContent = `+ ${14 - SHOWN} more`;
    return () => {};
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
    lList.replaceChildren();
    rList.replaceChildren();
    more.hidden = true;
  };
}
