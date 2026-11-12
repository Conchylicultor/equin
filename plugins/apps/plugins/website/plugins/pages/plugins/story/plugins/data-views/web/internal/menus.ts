import { esc, ic } from "./styles";

/* ============================== menus ==============================
   Ported verbatim from the prototype's `claude.js` (`proto-1794207359-w7ez6h`). A menu never moves once open;
   a submenu opens to the right of its parent if it fits, else to its left, else under it, its first item level
   with the row that opened it. */

/** items: {label, icon, value, kbd, check, count, badge, danger, keep, sub:()=>items, action} | {sep} | {header} | {input} */
export interface MenuItem {
  label?: string;
  icon?: string;
  value?: string | null;
  kbd?: string;
  check?: boolean;
  checkable?: 1;
  count?: number;
  badge?: string;
  danger?: boolean;
  keep?: 1;
  sub?: () => MenuItem[];
  action?: () => void;
  sep?: 1;
  header?: string;
  input?: 1;
  dv?: string;
  ph?: string;
  clear?: () => void;
}
export interface MenuLevel {
  build: () => MenuItem[];
  el: HTMLDivElement;
  lv: number;
  from?: number;
  items?: MenuItem[];
}
export interface OpenOpts {
  cls?: string;
  align?: "start" | "end";
  dx?: number;
  force?: 1;
  matchWidth?: boolean;
  beside?: Element | null;
}
/** what a menu stack draws in: the figure's frame (its bounds) and the layer menus are drawn on */
export interface MenuHost {
  frame: HTMLElement;
  layer: HTMLElement;
  $(s: string): HTMLElement | null;
}

export class Menus {
  levels: MenuLevel[] = [];
  anchor: HTMLElement | null = null;
  constructor(private app: MenuHost) {}
  get open() {
    return this.levels.length > 0;
  }
  html(items: MenuItem[]) {
    return items
      .map((it, i) => {
        if (it.sep) return '<div class="msep"></div>';
        if (it.header) return `<div class="mh">${esc(it.header)}</div>`;
        if (it.input)
          return (
            `<label class="msearch" data-i="${i}">${ic("search", 16)}<input data-dvq="${it.dv}" placeholder="${esc(it.ph)}" value="${esc(it.value)}" aria-label="${esc(it.ph)}">` +
            `<button class="x" data-mclear title="Clear search" aria-label="Clear search"${it.value ? "" : " hidden"}>${ic("close", 13)}</button></label>`
          );
        const right =
          (it.value != null ? `<span class="mv">${esc(it.value)}</span>` : "") +
          (it.count != null ? `<span class="mv">${it.count}</span>` : "") +
          (it.kbd ? `<span class="kb">${it.kbd}</span>` : "") +
          (it.sub ? ic("right", 14) : "") +
          (it.check
            ? `<span class="ck">${ic("check", 16)}</span>`
            : it.checkable
              ? '<span style="width:16px"></span>'
              : "");
        return `<button class="mi${it.danger ? " danger" : ""}" data-i="${i}">${it.icon ? ic(it.icon, 17) : ""}<span class="ml">${esc(it.label)}${it.badge ? `<span class="badge">${it.badge}</span>` : ""}</span>${right}</button>`;
      })
      .join("");
  }
  mk(lv: number) {
    const el = document.createElement("div");
    el.className = lv ? "menu sub" : "menu";
    el.dataset.lv = String(lv);
    el.setAttribute("role", "menu");
    this.app.layer.append(el);
    return el;
  }
  openAt(anchor: HTMLElement, build: () => MenuItem[], opts: OpenOpts = {}) {
    const same = this.anchor === anchor;
    this.close();
    if (same && !opts.force) return;
    this.anchor = anchor;
    anchor.classList.add("on");
    const row = anchor.closest(".sech");
    if (row) row.classList.add("mon");
    const L: MenuLevel = { build, el: this.mk(0), lv: 0 };
    this.levels = [L];
    if (opts.cls) L.el.classList.add(opts.cls);
    if (opts.matchWidth)
      L.el.style.minWidth = anchor.getBoundingClientRect().width + "px";
    this.paint(L);
    const F = this.app.frame.getBoundingClientRect(),
      r = anchor.getBoundingClientRect(),
      w = L.el.offsetWidth,
      h = L.el.offsetHeight;
    let x =
      opts.align === "start"
        ? r.left - F.left - (opts.dx || 0)
        : r.right - F.left - w;
    let y = r.bottom - F.top + 6;
    /* a sidebar header's menu opens beside the sidebar, level with the header (as on claude.ai) */
    let side = false;
    if (opts.beside) {
      const sb = opts.beside.getBoundingClientRect();
      if (sb.right - F.left + 12 + w <= F.width - 8) {
        side = true;
        x = sb.right - F.left + 12;
        y = r.top - F.top - 4;
      }
    }
    if (!side && y + h > F.height - 8 && r.top - F.top - h - 6 > 8)
      y = r.top - F.top - h - 6;
    /* a menu never moves once open, so its place is decided now for the whole tree: when its widest submenu would fit
       on neither side, it starts far enough left for that submenu to open on its right */
    const W = this.widestSub(L.items!),
      cx = Math.max(8, Math.min(x, F.width - w - 8));
    if (W && cx + w + 2 + W > F.width - 8 && cx - 2 - W < 8)
      x = Math.max(8, F.width - 8 - W - 2 - w);
    this.place(L.el, x, y);
  }
  /* how wide this menu's widest submenu draws (measured off-screen, never shown) */
  widestSub(items: MenuItem[]) {
    let W = 0;
    for (const it of items) {
      if (!it.sub) continue;
      const el = document.createElement("div");
      el.className = "menu sub";
      el.style.cssText = "visibility:hidden;left:-9999px;top:0;animation:none";
      el.innerHTML = this.html(it.sub());
      this.app.layer.append(el);
      W = Math.max(W, el.offsetWidth);
      el.remove();
    }
    return W;
  }
  /* open a menu and walk down its submenus by label: the whole tree shows, each parent with the item it opened marked
     (what a hovered feature line points at). Answers the deepest menu it reached. */
  openPath(
    anchor: HTMLElement,
    build: () => MenuItem[],
    path: string[],
    opts: OpenOpts = {},
  ) {
    this.openAt(anchor, build, { ...opts, force: 1 });
    path.forEach((label, lv) => {
      const L = this.levels[lv],
        i = L ? L.items!.findIndex((it) => it.label === label) : -1;
      if (L && i >= 0)
        this.sub(lv, i, L.el.querySelector<HTMLElement>(`.mi[data-i="${i}"]`)!);
    });
    return this.levels.length ? this.levels[this.levels.length - 1]!.el : null;
  }
  place(el: HTMLElement, x: number, y: number, clampY = true) {
    const F = this.app.frame.getBoundingClientRect(),
      w = el.offsetWidth,
      h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(x, F.width - w - 8)) + "px";
    el.style.top =
      (clampY ? Math.max(8, Math.min(y, F.height - h - 8)) : y) + "px";
  }
  paint(L: MenuLevel) {
    L.items = L.build();
    L.el.innerHTML = this.html(L.items);
  }
  sub(lv: number, i: number, itemEl: HTMLElement) {
    const P0 = this.levels[lv];
    if (!P0) return;
    if (this.levels[lv + 1] && this.levels[lv + 1]!.from === i) return;
    this.closeFrom(lv + 1);
    const it = P0.items![i];
    if (!it || !it.sub) return;
    P0.el
      .querySelectorAll(".mi")
      .forEach((m) => m.classList.toggle("hv", m === itemEl));
    const L: MenuLevel = {
      build: it.sub,
      el: this.mk(lv + 1),
      from: i,
      lv: lv + 1,
    };
    this.levels.push(L);
    this.paint(L);
    /* laid-out boxes (offsets), not painted ones: a menu still popping in is scaled and shifted for a few frames */
    const F = this.app.frame.getBoundingClientRect(),
      w = L.el.offsetWidth,
      h = L.el.offsetHeight,
      up = this.levels.slice(0, lv + 1);
    const box = (el: HTMLElement) => ({
      l: el.offsetLeft,
      t: el.offsetTop,
      r: el.offsetLeft + el.offsetWidth,
      b: el.offsetTop + el.offsetHeight,
    });
    const pr = box(P0.el),
      il = pr.l + itemEl.offsetLeft;
    /* where the submenu goes, first that fits and covers no menu of the tree: to the right of its parent, else to its
       left, else stacked under it. The parent itself never moves. Its first item sits level with the hovered row. */
    const first = L.el.querySelector<HTMLElement>(".mi, .msearch"),
      y = pr.t + itemEl.offsetTop - (first ? first.offsetTop : 0);
    const clear = (x0: number, y0: number) =>
      up.every((U) => {
        const r = box(U.el);
        return x0 >= r.r || x0 + w <= r.l || y0 >= r.b || y0 + h <= r.t;
      });
    let x = pr.r + 2;
    if (x + w <= F.width - 8 && clear(x, y)) {
      this.place(L.el, x, y);
      return;
    }
    x = pr.l - w - 2;
    if (x >= 8 && clear(x, y)) {
      this.place(L.el, x, y);
      return;
    }
    this.place(L.el, Math.min(il + 12, F.width - 8 - w), pr.b + 4, false);
  }
  closeFrom(lv: number) {
    while (this.levels.length > lv) this.levels.pop()!.el.remove();
    const P0 = this.levels[lv - 1];
    if (P0)
      P0.el.querySelectorAll(".mi.hv").forEach((m) => m.classList.remove("hv"));
  }
  repaint() {
    this.levels.forEach((L) => this.paint(L));
    const p = this.levels[0];
    const s = this.levels[1];
    if (p && s) {
      const m = p.el.querySelector(`.mi[data-i="${s.from}"]`);
      if (m) m.classList.add("hv");
    }
  }
  close() {
    this.levels.forEach((L) => L.el.remove());
    this.levels = [];
    if (this.anchor) {
      this.anchor.classList.remove("on");
      const row = this.anchor.closest(".sech");
      if (row) row.classList.remove("mon");
    }
    this.anchor = null;
  }
  click(e: Event, refocus: (el: HTMLElement | null) => void) {
    const t = e.target as Element;
    const x = t.closest<HTMLElement>("[data-mclear]");
    if (x) {
      e.preventDefault();
      const lv = +x.closest<HTMLElement>(".menu")!.dataset.lv!,
        it =
          this.levels[lv]!.items![
            +x.closest<HTMLElement>(".msearch")!.dataset.i!
          ]!;
      it.clear!();
      this.repaint();
      refocus(this.app.$(`.menu input[data-dvq]`));
      return;
    }
    const mi = t.closest<HTMLElement>(".mi");
    if (!mi) return;
    const lv = +mi.closest<HTMLElement>(".menu")!.dataset.lv!,
      L = this.levels[lv],
      it = L && L.items![+mi.dataset.i!];
    if (!it) return;
    if (it.sub) {
      this.sub(lv, +mi.dataset.i!, mi);
      return;
    }
    if (it.keep) {
      if (it.action) it.action();
      this.repaint();
      return;
    }
    this.close();
    if (it.action) it.action();
  }
  hover(e: Event) {
    const mi = (e.target as Element).closest<HTMLElement>(".mi");
    if (!mi) return;
    const lv = +mi.closest<HTMLElement>(".menu")!.dataset.lv!,
      L = this.levels[lv],
      i = +mi.dataset.i!,
      it = L && L.items![i];
    if (!it) return;
    if (it.sub) this.sub(lv, i, mi);
    else this.closeFrom(lv + 1);
  }
}
