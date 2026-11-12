import {
  createInViewWatcher,
  type InViewWatcher,
} from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { restoreScrollOffset } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import {
  BUCKETS,
  DATES,
  MODELS,
  PROJECTS,
  RATINGS,
  SHELVES,
  STATES,
  TYPES,
  GENRES,
  artCard,
  artRow,
  bookCard,
  bookRow,
  bookTile,
  bucket,
  chatCard,
  cvRow,
  inDate,
  kindTile,
  shortAgo,
  type ItemOpts,
} from "./data";
import type { Menus, MenuItem } from "./menus";
import { EASE, esc, ic } from "./styles";

/* ============================== FLIP ============================== */
export const reduce = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;
export function flip(
  root: HTMLElement | null,
  mutate: () => void,
  anim = true,
) {
  if (!root) {
    mutate();
    return;
  }
  if (!anim || reduce()) {
    mutate();
    return;
  }
  const first = new Map<string, DOMRect>();
  root.querySelectorAll<HTMLElement>("[data-k]").forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.height) first.set(e.dataset.k!, r);
  });
  mutate();
  root.querySelectorAll<HTMLElement>("[data-k]").forEach((e) => {
    const b = e.getBoundingClientRect();
    if (!b.height) return;
    const a = first.get(e.dataset.k!);
    if (!a) {
      e.animate(
        [
          { opacity: 0, transform: "translateY(6px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 240, easing: EASE },
      );
      return;
    }
    const dx = a.left - b.left,
      dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    e.animate(
      [{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }],
      { duration: 340, easing: EASE },
    );
  });
}

/* ============================== THE primitive: DataView ==============================
   One implementation of saved views, search, filter, sort, group, sub-items, layouts and infinite scroll. A page draws
   it as the full bar (views as tabs, then search, filter, sort, view settings and New); a narrow list folds the same
   controls into two buttons: the view button (switch or add a view) and the settings button (search, filter, sort,
   view settings). A surface only supplies its rows, its fields, its views and how one item looks in each layout.
   Ported verbatim from the prototype's `claude.js` (`proto-1794207359-w7ez6h`). */

/** a record of the figure's invented data: chats, artifacts or books */
export type Rec = {
  id: string;
  title: string;
  hours: number;
  parent?: string;
} & Record<string, any>;
type FieldValue = string | number | boolean | null;
export interface Field {
  k: string;
  label: string;
  type: "text" | "enum" | "date" | "bool";
  get: (r: Rec) => FieldValue;
  options?: () => string[];
  filter?: 1;
  group?: 1;
  sort?: 1;
  yesNo?: [string, string];
}
type FilterValue = string[] | string | boolean | null;
interface Sort {
  k: string;
  dir: "asc" | "desc";
}
interface ViewSpec {
  name: string;
  icon?: string;
  filters?: Record<string, FilterValue>;
  group?: string | null;
  nest?: boolean;
  sort: Sort;
  layout: string;
}
interface View {
  name: string;
  icon: string;
  filters: Record<string, FilterValue>;
  group: string | null;
  nest: boolean;
  sort: Sort;
  layout: string;
  base: string;
}
interface Col {
  k: string;
  label: string;
  cls?: string;
  w?: string;
  cell: (r: Rec) => string;
}
export interface DvConfig {
  id: string;
  noun: string;
  title?: string;
  page: number;
  gridClass: string;
  rows: () => Rec[];
  inPage?: boolean;
  newLabel?: string;
  fields: Field[];
  views: ViewSpec[];
  list: (r: Rec, o: ItemOpts) => string;
  grid: (r: Rec, o: ItemOpts) => string;
  cols: Col[];
  parent?: boolean;
  extra?: string;
}
/** what a data view is drawn in: the figure's shadow root lookups, its menus, and the state the figure shares */
export interface DvHost {
  $(s: string): HTMLElement | null;
  menus: Menus;
  layer: HTMLElement;
  fresh: string | null;
  quietScroll: number;
  featSearch: boolean;
  sideRows(): Rec[];
  arts: Rec[];
  books: Rec[];
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const GROUP_PAGE = 8;
const LAYOUTS = [
  ["list", "List"],
  ["grid", "Grid"],
  ["table", "Table"],
] as const;
export class DataView {
  id: string;
  views: View[];
  q = "";
  loading = false;
  searching = false;
  vi = 0;
  filters: Record<string, FilterValue> = {};
  sort: Sort = { k: "hours", dir: "desc" };
  group: string | null = null;
  layout = "list";
  nest = false;
  shown = 0;
  collapsed = new Set<string>();
  more_g = new Map<string, number>();
  total = 0;
  io: InViewWatcher | null = null;
  ioRoot: HTMLElement | null = null;
  sent: HTMLElement | null = null;
  timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(
    private app: DvHost,
    readonly c: DvConfig,
  ) {
    this.id = c.id;
    this.views = c.views.map((v) => this.mkView(v));
    this.load(0);
  }
  dispose() {
    this.io?.disconnect();
    for (const t of this.timers) clearTimeout(t);
  }
  mkView(v: ViewSpec): View {
    const x = {
      icon: "layers",
      filters: {},
      group: null,
      nest: false,
      ...clone(v),
      base: "",
    } as View;
    x.base = JSON.stringify(this.snap(x));
    return x;
  }
  snap(x: {
    filters: Record<string, FilterValue>;
    sort: Sort;
    group: string | null;
    layout: string;
    nest: boolean;
  }) {
    return {
      filters: this.active(x.filters),
      sort: x.sort,
      group: x.group || null,
      layout: x.layout,
      nest: !!x.nest,
    };
  }
  get view() {
    return this.views[this.vi]!;
  }
  load(i: number) {
    const v = this.views[i]!;
    this.vi = i;
    this.filters = clone(v.filters);
    this.sort = { ...v.sort };
    this.group = v.group || null;
    this.layout = v.layout;
    this.nest = !!v.nest;
    this.shown = this.c.page;
    this.collapsed = new Set();
    this.more_g = new Map();
  }
  save() {
    Object.assign(this.view, {
      filters: clone(this.filters),
      sort: { ...this.sort },
      group: this.group,
      layout: this.layout,
      nest: this.nest,
    });
  }
  $(s: string) {
    return this.app.$(`[${s}="${this.id}"]`);
  }
  /* a new arrangement starts from its top, so the change is seen (and FLIP measures from there) */
  toTop() {
    const sc = this.app.$(`[data-scroll="${this.id}"]`);
    if (!sc || !sc.scrollTop) return;
    this.app.quietScroll = performance.now();
    restoreScrollOffset(sc, { top: 0 });
  }
  field(k: string) {
    return this.c.fields.find((f) => f.k === k)!;
  }
  isSet(f: Field, v: FilterValue | undefined) {
    return f.type === "enum"
      ? !!v && (v as string[]).length > 0
      : f.type === "date"
        ? !!v && v !== "Any time"
        : v != null;
  }
  active(fs: Record<string, FilterValue>) {
    const o: Record<string, FilterValue> = {};
    Object.keys(fs || {})
      .sort()
      .forEach((k) => {
        if (this.isSet(this.field(k), fs[k])) o[k] = fs[k]!;
      });
    return o;
  }
  /* what this view's settings changed on top of how the view was saved: lights the settings button */
  changed() {
    return (
      this.q.trim() !== "" || JSON.stringify(this.snap(this)) !== this.view.base
    );
  }
  match(r: Rec, skip?: string) {
    const q = this.q.trim().toLowerCase();
    if (q && r.title.toLowerCase().indexOf(q) < 0) return false;
    for (const k in this.filters) {
      if (k === skip) continue;
      const f = this.field(k),
        v = this.filters[k]!,
        x = f.get(r);
      if (!this.isSet(f, v)) continue;
      if (f.type === "enum" && !(v as string[]).includes(x as string))
        return false;
      if (f.type === "date" && !inDate(x as number, v as string)) return false;
      if (f.type === "bool" && !!x !== v) return false;
    }
    return true;
  }
  sv(f: Field, r: Rec): string | number {
    const x = f.get(r);
    return f.type === "date"
      ? -(x as number)
      : f.type === "enum"
        ? f.options!().indexOf(x as string)
        : f.type === "bool"
          ? +!!x
          : String(x).toLowerCase();
  }
  rows() {
    const f = this.field(this.sort.k),
      d = this.sort.dir === "desc" ? -1 : 1;
    return this.c
      .rows()
      .filter((r) => this.match(r))
      .sort((a, b) => {
        const x = this.sv(f, a),
          y = this.sv(f, b);
        return (
          (typeof x === "string"
            ? x.localeCompare(y as string)
            : x - (y as number)) * d || a.hours - b.hours
        );
      });
  }
  gkey(f: Field, r: Rec): string {
    const x = f.get(r);
    return f.type === "date"
      ? bucket(x as number)
      : f.type === "bool"
        ? (f.yesNo || ["Yes", "No"])[x ? 0 : 1]
        : (x as string);
  }
  groups(rs: Rec[]): { k: string | null; rows: Rec[] }[] {
    if (!this.group) return [{ k: null, rows: rs }];
    const f = this.field(this.group),
      keys =
        f.type === "date"
          ? BUCKETS
          : f.type === "bool"
            ? f.yesNo || ["Yes", "No"]
            : f.options!();
    const m = new Map<string, Rec[]>(keys.map((k) => [k, []]));
    rs.forEach((r) => {
      const k = this.gkey(f, r);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    });
    return [...m].filter(([, v]) => v.length).map(([k, v]) => ({ k, rows: v }));
  }
  /* optional columns only where the body has room for them */
  cols() {
    const b = this.$("data-body");
    const w = b ? b.clientWidth : 999;
    return this.c.cols.filter((c) => !c.cls || w > 460);
  }
  defDir(k: string): Sort["dir"] {
    return this.field(k).type === "date" ? "desc" : "asc";
  }
  nesting() {
    return this.nest && this.layout === "list" && !!this.c.parent;
  }

  /* ---- render ---- */
  renderAll(anim: boolean) {
    this.renderToolbar();
    this.renderBody(anim);
  }
  /* the two controls are drawn once and then only updated, so a menu hanging from one stays attached */
  renderToolbar() {
    const el = this.$("data-tb");
    if (!el) return;
    if (this.c.inPage) {
      this.renderBar(el);
      return;
    }
    if (!el.querySelector(".vrow")) {
      el.innerHTML =
        `<div class="vrow"><button class="vbtn" data-dvact="views" aria-haspopup="menu"><span class="vi"></span><span class="vn"></span><span class="vq"></span><span class="vc">${ic("chev", 14)}</span></button>` +
        (this.c.inPage ? '<span class="sp"></span>' : "") +
        `<button class="ib sbtn" data-dvact="settings" aria-haspopup="menu" title="Search, filter, sort and view settings" aria-label="Search, filter, sort and view settings">${ic("sliders")}</button>` +
        (this.c.extra || "") +
        `</div>`;
    }
    const v = this.view;
    el.querySelector(".vi")!.innerHTML = ic(v.icon);
    el.querySelector(".vn")!.textContent = v.name;
    el.querySelector(".vq")!.textContent = this.q.trim()
      ? `“${this.q.trim()}”`
      : "";
    el.querySelector(".sbtn")!.classList.toggle("has", this.changed());
  }
  /* what each control changed on top of how the view was saved: lights that control */
  dirty() {
    const b = JSON.parse(this.view.base) as ReturnType<DataView["snap"]>;
    return {
      filter:
        JSON.stringify(this.active(this.filters)) !== JSON.stringify(b.filters),
      sort: JSON.stringify(this.sort) !== JSON.stringify(b.sort),
      settings:
        this.layout !== b.layout ||
        (this.group || null) !== b.group ||
        this.nest !== b.nest,
    };
  }
  renderBar(el: HTMLElement) {
    if (!el.querySelector(".dvbar")) {
      el.innerHTML =
        `<div class="bar dvbar"><div class="tabs" role="tablist" aria-label="Views"><div class="vts"></div>` +
        `<button class="ib" data-dvact="addview" aria-haspopup="menu" title="Add a view" aria-label="Add a view">${ic("plus", 18)}</button></div>` +
        `<div class="tools"><span class="dsrch" style="display:contents"></span>` +
        `<button class="ib" data-dvact="filter" aria-haspopup="menu" title="Filter" aria-label="Filter">${ic("filter")}</button>` +
        `<button class="ib" data-dvact="sort" aria-haspopup="menu" title="Sort" aria-label="Sort">${ic("sort")}</button>` +
        `<button class="ib" data-dvact="vsettings" aria-haspopup="menu" title="View settings" aria-label="View settings">${ic("sliders")}</button>` +
        `<button class="ib" data-act="create" aria-haspopup="menu" title="${esc(this.c.newLabel)}" aria-label="${esc(this.c.newLabel)}">${ic("plus")}</button></div></div>`;
    }
    const ts = el.querySelector<HTMLElement>(".vts")!,
      sig = this.views.map((v) => v.name).join("|") + "#" + this.vi;
    if (ts.dataset.sig !== sig) {
      ts.dataset.sig = sig;
      ts.innerHTML = this.views
        .map(
          (v, i) =>
            `<button class="tab${i === this.vi ? " on" : ""}" role="tab" aria-selected="${i === this.vi}" data-dvact="tab" data-i="${i}">${esc(v.name)}</button>`,
        )
        .join("");
      /* the active tab is always in sight when the tabs scroll (a narrow page) */
      const on = ts.querySelector<HTMLElement>(".tab.on")!;
      if (on.offsetLeft < ts.scrollLeft)
        restoreScrollOffset(ts, { left: on.offsetLeft });
      else if (on.offsetLeft + on.offsetWidth > ts.scrollLeft + ts.clientWidth)
        restoreScrollOffset(ts, {
          left: on.offsetLeft + on.offsetWidth - ts.clientWidth,
        });
    }
    /* search: Claude's icon, opening into its field (drawn again only when it opens or closes, so typing keeps focus) */
    const sw = el.querySelector<HTMLElement>(".dsrch")!,
      open = this.searching || !!this.q;
    if (sw.dataset.open !== String(open)) {
      sw.dataset.open = String(open);
      sw.innerHTML = open
        ? `<label class="sfield">${ic("search", 16)}<input data-dvq="${this.id}" placeholder="Search ${this.c.noun}..." aria-label="Search ${this.c.noun}"><button class="x" data-dvact="qclose" title="Close search" aria-label="Close search">${ic("close", 13)}</button></label>`
        : `<button class="ib" data-dvact="qopen" title="Search" aria-label="Search">${ic("search")}</button>`;
    }
    const inp = sw.querySelector("input");
    if (inp && inp.value !== this.q) inp.value = this.q;
    const d = this.dirty();
    el.querySelector("[data-dvact=filter]")!.classList.toggle("has", d.filter);
    el.querySelector("[data-dvact=sort]")!.classList.toggle("has", d.sort);
    el.querySelector("[data-dvact=vsettings]")!.classList.toggle(
      "has",
      d.settings,
    );
  }
  setSearching(on: boolean, focus?: boolean) {
    this.searching = on;
    if (!on && this.q) this.setQ("");
    else this.renderToolbar();
    if (focus)
      focusElement(
        this.$("data-tb")!.querySelector<HTMLInputElement>("input[data-dvq]"),
        { reveal: false },
      );
  }
  barBtn(act: string) {
    return this.$("data-tb")!.querySelector<HTMLElement>(
      `[data-dvact="${act}"]`,
    )!;
  }
  /* the page bar's menus: each control opens its own list */
  barMenu(act: string): () => MenuItem[] {
    return act === "filter"
      ? () => this.filterMenu()
      : act === "sort"
        ? () => this.sortMenu()
        : act === "addview"
          ? () => this.addViewMenu()
          : () =>
              this.viewSettingsMenu().concat(
                this.changed()
                  ? [
                      { sep: 1 },
                      { label: "Reset view", action: () => this.reset() },
                    ]
                  : [],
              );
  }
  addViewMenu(): MenuItem[] {
    return [
      { header: "New view" },
      ...LAYOUTS.map(([k, l]) => ({
        label: l,
        icon: k,
        action: () => this.addView(k),
      })),
    ];
  }
  openBar(act: string, el: HTMLElement) {
    if (this.app.menus.anchor === el) {
      this.app.menus.close();
      return;
    }
    this.app.menus.openAt(el, this.barMenu(act), {
      cls: "wide",
      align: act === "addview" ? "start" : "end",
      force: 1,
    });
  }
  item(r: Rec, layout: "list" | "grid", depth?: number, kids?: number) {
    const o: ItemOpts = {
      k: layout[0] + ":" + r.id,
      depth,
      kids,
      fresh: this.app.fresh === r.id,
      time: this.field(this.sort.k).type === "date" ? this.sort.k : "hours",
    };
    return this.c[layout](r, o);
  }
  gh(g: { k: string | null }, n: number, table?: boolean) {
    const k = g.k!,
      c = this.collapsed.has(k);
    const h = `<div class="gh${c ? " col" : ""}"${table ? "" : ` data-k="g:${esc(k)}"`}><button class="ghb" data-dvact="gtoggle" data-g="${esc(k)}" aria-expanded="${!c}">${esc(k)}<span class="gn">${n}</span>${ic(c ? "right" : "chev", 12)}</button></div>`;
    return table
      ? `<tr class="gtr" data-k="g:${esc(k)}"><td colspan="${this.cols().length}">${h}</td></tr>`
      : h;
  }
  renderBody(anim: boolean) {
    const box = this.$("data-body");
    if (!box) return;
    const rs = this.rows(),
      L = this.layout,
      nest = this.nesting();
    /* sub-items: a row whose parent is on screen draws under it, one step in */
    const ids = new Set(rs.map((r) => r.id)),
      kids = new Map<string, Rec[]>();
    if (nest)
      rs.forEach((r) => {
        if (r.parent && ids.has(r.parent)) {
          if (!kids.has(r.parent)) kids.set(r.parent, []);
          kids.get(r.parent)!.push(r);
        }
      });
    const top = nest ? rs.filter((r) => !(r.parent && ids.has(r.parent))) : rs,
      gs = this.groups(top);
    const isCol = (k: string | null) => k !== null && this.collapsed.has(k);
    let total = gs.reduce(
      (n, g) =>
        n +
        (isCol(g.k)
          ? 0
          : g.rows.reduce((m, r) => m + 1 + (kids.get(r.id) || []).length, 0)),
      0,
    );
    /* every group but the last shows its first rows and a "more" row; the last one loads more as you scroll */
    let budget = this.shown,
      html = "",
      shown = 0;
    gs.forEach((g, gi) => {
      if (budget <= 0) return;
      const items: [Rec, number, number][] = [],
        last = gi === gs.length - 1,
        cap = last
          ? Infinity
          : (g.k !== null && this.more_g.get(g.k)) || GROUP_PAGE;
      let tops = 0;
      if (!isCol(g.k)) {
        for (const r of g.rows) {
          if (budget <= 0 || tops >= cap) break;
          tops++;
          const ks = kids.get(r.id) || [];
          items.push([r, 0, ks.length]);
          budget--;
          for (const c of ks) {
            if (budget <= 0) break;
            items.push([c, 1, 0]);
            budget--;
          }
        }
      }
      shown += items.length;
      const rest = isCol(g.k) || last ? 0 : g.rows.length - tops;
      if (!last && rest > 0)
        total -= g.rows
          .slice(tops)
          .reduce((m, r) => m + 1 + (kids.get(r.id) || []).length, 0);
      const moreRow =
        rest > 0
          ? `<button class="gmore" data-dvact="gmore" data-g="${esc(g.k)}" data-k="m:${esc(g.k)}">${rest} more</button>`
          : "";
      if (L === "table") {
        html +=
          (g.k !== null ? this.gh(g, g.rows.length, true) : "") +
          items.map(([r]) => this.trow(r)).join("") +
          (moreRow
            ? `<tr class="gtr"><td colspan="${this.cols().length}">${moreRow}</td></tr>`
            : "");
        return;
      }
      if (g.k !== null) html += this.gh(g, g.rows.length);
      if (items.length)
        html +=
          L === "grid"
            ? `<div class="${this.c.gridClass}">${items.map(([r]) => this.item(r, "grid")).join("")}</div>`
            : `<div class="al">${items.map(([r, d, n]) => this.item(r, "list", d, n)).join("")}</div>`;
      html += moreRow;
    });
    if (L === "table") html = this.thead() + `<tbody>${html}</tbody></table>`;
    if (!rs.length)
      html = `<div class="empty">No ${this.c.noun} match<button class="btn" data-dvact="clear">Clear search and filters</button></div>`;
    else if (shown < total)
      html += `<div class="more" data-sent>${this.loading ? '<span class="spin"></span>' : ""}</div>`;
    else if (total > this.c.page)
      html += `<div class="end">${total} ${this.c.noun}</div>`;
    flip(
      box,
      () => {
        box.innerHTML = html;
      },
      anim,
    );
    this.total = total;
    this.observe(box);
  }
  thead() {
    const s = this.sort;
    return `<table class="tbl"><thead><tr>${this.cols()
      .map(
        (c) =>
          `<th class="${c.cls || ""}"${c.w ? ` style="width:${c.w}"` : ""} data-dvact="thsort" data-sk="${c.k}"><span>${c.label}${s.k === c.k ? ic(s.dir === "desc" ? "down" : "up", 12) : ""}</span></th>`,
      )
      .join("")}</tr></thead>`;
  }
  trow(r: Rec) {
    return (
      `<tr data-k="t:${r.id}" data-id="${r.id}">` +
      this.cols()
        .map((c) => `<td class="${c.cls || ""}">${c.cell(r)}</td>`)
        .join("") +
      `</tr>`
    );
  }
  observe(box: HTMLElement) {
    const root = this.app.$(`[data-scroll="${this.id}"]`);
    if (!root) return;
    if (this.ioRoot !== root) {
      this.io?.disconnect();
      this.io = createInViewWatcher(
        (es) => {
          if (es.some((e) => e.isIntersecting)) this.more();
        },
        { root, rootMargin: "0px 0px 120px 0px" },
      );
      this.ioRoot = root;
    }
    this.sent = box.querySelector<HTMLElement>("[data-sent]");
    if (this.sent) this.io!.observe(this.sent);
  }
  more() {
    if (this.loading || !this.sent) return;
    this.loading = true;
    this.sent.innerHTML = '<span class="spin"></span>';
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.loading = false;
      this.shown += this.c.page;
      this.renderBody(true);
    }, 480);
    this.timers.add(t);
  }
  refresh(anim = true, resetPage = false) {
    if (resetPage) this.shown = this.c.page;
    this.save();
    this.toTop();
    this.renderToolbar();
    this.renderBody(anim);
  }

  /* ---- the view button's menu: the views, Add view, View settings… ---- */
  viewsMenu(): MenuItem[] {
    return [
      ...this.views.map((v, i): MenuItem => ({
        label: v.name,
        icon: v.icon,
        check: i === this.vi,
        checkable: 1,
        action: () => this.switchTo(i),
      })),
      { sep: 1 },
      {
        label: "Add view",
        icon: "plus",
        sub: () =>
          LAYOUTS.map(([k, l]) => ({
            label: l,
            icon: k,
            action: () => this.addView(k),
          })),
      },
      {
        label: "View settings…",
        icon: "gear",
        action: () => this.openSettings(false, ["View settings"]),
      },
    ];
  }
  switchTo(i: number) {
    this.save();
    this.load(i);
    this.toTop();
    this.renderToolbar();
    this.renderBody(true);
  }
  addView(layout: string) {
    const k = this.c.fields.find((f) => f.type === "date")!.k;
    this.views.push(
      this.mkView({
        name: "View " + (this.views.length + 1),
        icon: "layers",
        sort: { k, dir: "desc" },
        layout,
      }),
    );
    this.switchTo(this.views.length - 1);
  }
  /* ---- the settings button's menu: Search, Filter, Sort, View settings ---- */
  settingsMenu(): MenuItem[] {
    const n = Object.keys(this.active(this.filters)).length;
    return (
      [
        {
          input: 1,
          dv: this.id,
          ph: "Search…",
          value: this.q,
          clear: () => this.setQ(""),
        },
        {
          label: "Filter",
          icon: "filter",
          value: n ? n + " on" : null,
          sub: () => this.filterMenu(),
        },
        {
          label: "Sort",
          icon: "sort",
          value: this.field(this.sort.k).label,
          sub: () => this.sortMenu(),
        },
        {
          label: "View settings",
          icon: "sliders",
          sub: () => this.viewSettingsMenu(),
        },
      ] as MenuItem[]
    ).concat(
      this.changed()
        ? [{ sep: 1 }, { label: "Reset view", action: () => this.reset() }]
        : [],
    );
  }
  reset() {
    const b = JSON.parse(this.view.base) as Partial<View>;
    Object.assign(this.view, b);
    this.q = "";
    this.load(this.vi);
    this.refresh(true, true);
  }
  setQ(q: string) {
    const x = this.app.layer.querySelector<HTMLElement>("[data-mclear]");
    if (x) x.hidden = !q;
    this.q = q;
    this.shown = this.c.page;
    this.more_g = new Map();
    this.app.quietScroll = performance.now();
    this.renderToolbar();
    this.renderBody(true);
  }
  openSettings(focus: boolean, path: string[] = []) {
    const b = this.$("data-tb")!.querySelector<HTMLElement>(".sbtn")!;
    this.app.menus.openPath(b, () => this.settingsMenu(), path, {
      cls: "wide",
      align: this.c.inPage ? "end" : "start",
    });
    if (focus)
      focusElement(
        this.app.layer.querySelector<HTMLInputElement>("input[data-dvq]"),
        { reveal: false },
      );
  }
  openViews() {
    const b = this.$("data-tb")!.querySelector<HTMLElement>(".vbtn")!;
    this.app.menus.openAt(b, () => this.viewsMenu(), {
      align: "start",
      matchWidth: !this.c.inPage,
      cls: "wide",
      force: 1,
    });
  }
  flabel(f: Field): string {
    const v = this.filters[f.k];
    if (!this.isSet(f, v)) return f.type === "date" ? "Any time" : "Any";
    if (f.type === "enum") {
      const a = v as string[];
      return a.length === 1 ? a[0]! : a.length + " selected";
    }
    if (f.type === "bool")
      return v ? (f.yesNo || ["Yes"])[0] : (f.yesNo || [0, "No"])[1];
    return v as string;
  }
  filterMenu(): MenuItem[] {
    const fs = this.c.fields.filter((f) => f.filter),
      any = Object.keys(this.active(this.filters)).length > 0;
    return fs
      .map((f): MenuItem => ({
        label: f.label,
        value: this.flabel(f),
        sub: () => this.filterOpts(f.k),
      }))
      .concat(
        any
          ? [
              { sep: 1 },
              {
                label: "Clear filters",
                keep: 1,
                action: () => {
                  this.filters = {};
                  this.refresh(true, true);
                },
              },
            ]
          : [],
      );
  }
  filterOpts(k: string): MenuItem[] {
    const f = this.field(k),
      cur = this.filters[k],
      set = (v: FilterValue) => {
        this.filters[k] = v;
        this.refresh(true, true);
      };
    if (f.type === "enum") {
      const base = this.c.rows().filter((r) => this.match(r, k)),
        arr = (cur as string[] | undefined) ?? null;
      return f.options!().map((o) => ({
        label: o,
        count: base.filter((r) => f.get(r) === o).length,
        check: !!(arr && arr.includes(o)),
        checkable: 1,
        keep: 1,
        action: () => {
          const a = new Set(arr || []);
          if (a.has(o)) a.delete(o);
          else a.add(o);
          set([...a]);
        },
      }));
    }
    if (f.type === "date")
      return DATES.map((d) => ({
        label: d,
        check: ((cur as string | undefined) || "Any time") === d,
        checkable: 1,
        keep: 1,
        action: () => set(d),
      }));
    const yn = f.yesNo || ["Yes", "No"];
    return (
      [
        ["Any", null],
        [yn[0], true],
        [yn[1], false],
      ] as const
    ).map(([l, v]) => ({
      label: l,
      check: (cur == null ? null : cur) === v,
      checkable: 1,
      keep: 1,
      action: () => set(v),
    }));
  }
  sortMenu(): MenuItem[] {
    const f = this.field(this.sort.k),
      dirs =
        f.type === "date"
          ? ["Newest first", "Oldest first"]
          : ["A → Z", "Z → A"];
    return [
      ...this.c.fields
        .filter((x) => x.sort)
        .map((x): MenuItem => ({
          label: x.label,
          check: this.sort.k === x.k,
          checkable: 1,
          keep: 1,
          action: () => {
            this.sort = { k: x.k, dir: this.defDir(x.k) };
            this.refresh();
          },
        })),
      { sep: 1 },
      ...dirs.map((d, i): MenuItem => ({
        label: d,
        check:
          (this.sort.dir === "desc") ===
          (f.type === "date" ? i === 0 : i === 1),
        checkable: 1,
        keep: 1,
        action: () => {
          this.sort.dir = (f.type === "date" ? i === 0 : i === 1)
            ? "desc"
            : "asc";
          this.refresh();
        },
      })),
    ];
  }
  viewSettingsMenu(): MenuItem[] {
    const lay = LAYOUTS.find(([k]) => k === this.layout)!;
    return [
      {
        label: "Layout",
        icon: this.layout,
        value: lay[1],
        sub: () =>
          LAYOUTS.map(([k, l]) => ({
            label: l,
            icon: k,
            check: this.layout === k,
            checkable: 1,
            keep: 1,
            action: () => {
              this.layout = k;
              this.refresh();
            },
          })),
      },
      {
        label: "Group by",
        icon: "group",
        value: this.group ? this.field(this.group).label : "None",
        sub: () => this.groupMenu(),
      },
      ...(this.c.parent
        ? [
            {
              label: "Sub-items",
              icon: "nest",
              value: this.nest ? "Nested" : "Flat",
              sub: () =>
                (
                  [
                    ["Nested", true],
                    ["Flat", false],
                  ] as const
                ).map(([l, v]): MenuItem => ({
                  label: l,
                  check: this.nest === v,
                  checkable: 1,
                  keep: 1,
                  action: () => {
                    this.nest = v;
                    this.refresh();
                  },
                })),
            },
          ]
        : []),
    ];
  }
  groupMenu(): MenuItem[] {
    return [
      {
        label: "None",
        check: !this.group,
        checkable: 1,
        keep: 1,
        action: () => {
          this.group = null;
          this.refresh();
        },
      },
      ...this.c.fields
        .filter((f) => f.group)
        .map((f): MenuItem => ({
          label: f.label,
          check: this.group === f.k,
          checkable: 1,
          keep: 1,
          action: () => {
            this.group = f.k;
            this.collapsed.clear();
            this.more_g = new Map();
            this.refresh();
          },
        })),
    ];
  }
  handle(act: string, el: HTMLElement) {
    switch (act) {
      case "views":
        if (this.app.menus.anchor === el) this.app.menus.close();
        else this.openViews();
        break;
      case "settings":
        if (this.app.menus.anchor === el) this.app.menus.close();
        else this.openSettings(true);
        break;
      case "tab": {
        const i = +el.dataset.i!;
        if (i !== this.vi) this.switchTo(i);
        break;
      }
      case "addview":
      case "filter":
      case "sort":
      case "vsettings":
        this.openBar(act, el);
        break;
      case "qopen":
        this.setSearching(true, true);
        this.app.featSearch = false;
        break;
      case "qclose":
        this.setSearching(false);
        break;
      case "clear":
        this.filters = {};
        this.q = "";
        this.refresh(true, true);
        break;
      case "thsort": {
        const k = el.dataset.sk!;
        this.sort =
          this.sort.k === k
            ? { k, dir: this.sort.dir === "desc" ? "asc" : "desc" }
            : { k, dir: this.defDir(k) };
        this.refresh();
        break;
      }
      case "gmore": {
        const g = el.dataset.g!;
        this.more_g.set(g, (this.more_g.get(g) || GROUP_PAGE) + GROUP_PAGE * 2);
        this.renderBody(true);
        break;
      }
      case "gtoggle": {
        const g = el.dataset.g!;
        if (this.collapsed.has(g)) this.collapsed.delete(g);
        else this.collapsed.add(g);
        this.renderBody(true);
        break;
      }
    }
  }
}

/* ============================== the surfaces, declared for the data view ============================== */
const SIDE_BASE = { status: ["Active"], owner: ["Yours"] };
export function sideCfg(app: DvHost): DvConfig {
  return {
    id: "side",
    noun: "chats",
    page: 25,
    gridClass: "cg",
    rows: () => app.sideRows(),
    fields: [
      {
        k: "title",
        label: "Title",
        type: "text",
        get: (r) => r.title,
        sort: 1,
      },
      {
        k: "section",
        label: "Pinned",
        type: "enum",
        get: (r) => (r.pinned ? "Pinned" : "Recents"),
        options: () => ["Pinned", "Recents"],
        filter: 1,
        group: 1,
      },
      {
        k: "state",
        label: "State",
        type: "enum",
        get: (r) => r.state,
        options: () => STATES,
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "model",
        label: "Model",
        type: "enum",
        get: (r) => r.model,
        options: () => MODELS,
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "project",
        label: "Project",
        type: "enum",
        get: (r) => r.project || "No project",
        options: () => [...PROJECTS, "No project"],
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "status",
        label: "Status",
        type: "enum",
        get: (r) => (r.archived ? "Archived" : "Active"),
        options: () => ["Active", "Archived"],
        filter: 1,
        group: 1,
      },
      {
        k: "owner",
        label: "Owner",
        type: "enum",
        get: (r) => (r.owner === "You" ? "Yours" : "Shared with you"),
        options: () => ["Yours", "Shared with you"],
        filter: 1,
        group: 1,
      },
      {
        k: "hours",
        label: "Last activity",
        type: "date",
        get: (r) => r.hours,
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "created",
        label: "Date created",
        type: "date",
        get: (r) => r.created,
        filter: 1,
        group: 1,
        sort: 1,
      },
    ],
    /* every view lists the same chats as Claude's sidebar (active, yours); a view only arranges them */
    views: [
      {
        name: "By state",
        icon: "group",
        group: "state",
        filters: SIDE_BASE,
        sort: { k: "hours", dir: "desc" },
        layout: "list",
      },
      {
        name: "Models",
        icon: "brain",
        group: "model",
        filters: SIDE_BASE,
        sort: { k: "hours", dir: "desc" },
        layout: "list",
      },
      {
        name: "Recent",
        icon: "history",
        filters: SIDE_BASE,
        sort: { k: "hours", dir: "desc" },
        layout: "list",
      },
    ],
    list: cvRow,
    grid: (r, o) => chatCard(r as Parameters<typeof chatCard>[0], o),
    cols: [
      {
        k: "title",
        label: "Name",
        cell: (r) => `<span class="nm"><span>${esc(r.title)}</span></span>`,
      },
      { k: "model", label: "Model", cls: "opt", cell: (r) => esc(r.model) },
      {
        k: "hours",
        label: "Updated",
        w: "84px",
        cell: (r) => shortAgo(r.hours),
      },
    ],
  };
}
export function artsCfg(app: DvHost): DvConfig {
  return {
    id: "arts",
    noun: "artifacts",
    page: 18,
    gridClass: "ag",
    rows: () => app.arts.filter((a) => !a.deleted),
    inPage: true,
    newLabel: "New artifact",
    fields: [
      { k: "title", label: "Name", type: "text", get: (r) => r.title, sort: 1 },
      {
        k: "kind",
        label: "Type",
        type: "enum",
        get: (r) => r.kind,
        options: () => [...TYPES, "Folder"],
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "owner",
        label: "Owner",
        type: "enum",
        get: (r) => r.owner,
        options: () => ["You", "Other people"],
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "sharing",
        label: "Sharing",
        type: "enum",
        get: (r) => r.sharing,
        options: () => ["Private", "Organization", "Public"],
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "project",
        label: "Project",
        type: "enum",
        get: (r) => r.project || "No project",
        options: () => [...PROJECTS, "No project"],
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "hours",
        label: "Last opened",
        type: "date",
        get: (r) => r.hours,
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "edited",
        label: "Last edited",
        type: "date",
        get: (r) => r.edited,
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "pinned",
        label: "Pinned",
        type: "bool",
        get: (r) => r.pinned,
        yesNo: ["Pinned", "Not pinned"],
        filter: 1,
        group: 1,
      },
    ],
    /* the same artifacts as Claude's page, drawn the same way; a view arranges them (or, like Yours, filters them) */
    views: [
      {
        name: "All",
        icon: "layers",
        sort: { k: "hours", dir: "desc" },
        layout: "grid",
      },
      {
        name: "Yours",
        icon: "user",
        filters: { owner: ["You"] },
        sort: { k: "hours", dir: "desc" },
        layout: "grid",
      },
      {
        name: "By type",
        icon: "shapes",
        group: "kind",
        sort: { k: "hours", dir: "desc" },
        layout: "list",
      },
      {
        name: "Recently edited",
        icon: "pencil",
        group: "edited",
        sort: { k: "edited", dir: "desc" },
        layout: "table",
      },
    ],
    list: (r, o) => artRow(r as Parameters<typeof artRow>[0], o),
    grid: (r, o) => artCard(r as Parameters<typeof artCard>[0], o),
    cols: [
      {
        k: "title",
        label: "Name",
        cell: (r) =>
          `<span class="nm">${kindTile({ kind: String(r.kind) }, 13)}<span>${esc(r.title)}</span></span>`,
      },
      { k: "kind", label: "Type", w: "96px", cls: "opt", cell: (r) => r.kind },
      {
        k: "owner",
        label: "Owner",
        w: "96px",
        cls: "opt",
        cell: (r) => (r.owner === "You" ? "You" : "Others"),
      },
      {
        k: "edited",
        label: "Edited",
        w: "84px",
        cell: (r) => shortAgo(r.edited),
      },
    ],
  };
}
export function notionCfg(app: DvHost): DvConfig {
  return {
    id: "arts",
    noun: "books",
    title: "Reading list",
    page: 24,
    gridClass: "ag",
    rows: () => app.books,
    inPage: true,
    newLabel: "New book",
    fields: [
      {
        k: "title",
        label: "Title",
        type: "text",
        get: (r) => r.title,
        sort: 1,
      },
      {
        k: "author",
        label: "Author",
        type: "text",
        get: (r) => r.author,
        sort: 1,
      },
      {
        k: "shelf",
        label: "Status",
        type: "enum",
        get: (r) => r.shelf,
        options: () => SHELVES,
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "genre",
        label: "Genre",
        type: "enum",
        get: (r) => r.genre,
        options: () => Object.keys(GENRES),
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "rating",
        label: "Rating",
        type: "enum",
        get: (r) => r.rating,
        options: () => RATINGS,
        filter: 1,
        group: 1,
        sort: 1,
      },
      {
        k: "hours",
        label: "Date added",
        type: "date",
        get: (r) => r.hours,
        filter: 1,
        group: 1,
        sort: 1,
      },
    ],
    views: [
      {
        name: "Table",
        icon: "table",
        sort: { k: "rating", dir: "asc" },
        layout: "table",
      },
      {
        name: "Gallery",
        icon: "grid",
        sort: { k: "hours", dir: "desc" },
        layout: "grid",
      },
      {
        name: "By status",
        icon: "group",
        group: "shelf",
        sort: { k: "title", dir: "asc" },
        layout: "list",
      },
      {
        name: "To read",
        icon: "listnum",
        filters: { shelf: ["To read"] },
        sort: { k: "hours", dir: "desc" },
        layout: "list",
      },
    ],
    list: (r, o) => bookRow(r as Parameters<typeof bookRow>[0], o),
    grid: (r, o) => bookCard(r as Parameters<typeof bookCard>[0], o),
    cols: [
      {
        k: "title",
        label: "Title",
        cell: (r) =>
          `<span class="nm">${bookTile(r as Parameters<typeof bookTile>[0])}<span>${esc(r.title)}</span></span>`,
      },
      { k: "author", label: "Author", cls: "opt", cell: (r) => esc(r.author) },
      { k: "shelf", label: "Status", w: "86px", cell: (r) => r.shelf },
      {
        k: "rating",
        label: "Rating",
        w: "92px",
        cell: (r) => `<span class="stars">${r.rating}</span>`,
      },
    ],
  };
}
