import {
  glideScroll,
  restoreScrollOffset,
  scrollToTop,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import {
  ACT,
  BUCKETS,
  DATES,
  FEATS,
  FEAT_TITLE,
  KIND,
  MODELS,
  RECENT_DEFAULTS,
  STATES,
  TYPES,
  artCard,
  artRow,
  bucket,
  cvRow,
  inDate,
  longAgo,
  makeArts,
  makeBooks,
  makeChats,
  type Art,
  type Book,
  type Chat,
  type FeatStatus,
  type RecentSettings,
} from "./data";
import {
  DataView,
  artsCfg,
  flip,
  notionCfg,
  reduce,
  sideCfg,
  type DvHost,
  type Rec,
} from "./data-view";
import { Menus, type MenuItem } from "./menus";
import { CSS as STYLES, EASE_POINTS, esc, hash, ic } from "./styles";
import {
  createInViewWatcher,
  type InViewWatcher,
} from "@plugins/primitives/plugins/dom/plugins/in-view/web";

/* ============================== the app ==============================
   <notion-dataview>, <claude-before> and <claude-after>, ported verbatim from the prototype's `claude.js`
   (`proto-1794207359-w7ez6h`).
   notion: a Notion-like database page (a reading list) drawn by the SAME data view as equin's Artifacts page
   below: same toolbar, same menus, same rows and cards, only its records, fields and views are its own.
   before / after: the Claude app's sidebar (chats) and Artifacts page, cloned from claude.ai in its light theme,
   then the same two surfaces rebuilt on ONE data-view primitive (DataView) that both mount with the same toolbar.
   Every title is invented. Each figure renders into its own shadow root. */
export type FigureMode = "notion" | "before" | "after";

/** a scroll glided by the figure itself (a list revealing what a feature line is about) */
const GLIDE_MS = 360;
/** how a list scrolls when the figure moves it: glided on the figure's curve, or at once under reduced motion */
function glideTo(p: HTMLElement, top: number) {
  if (reduce()) {
    restoreScrollOffset(p, { top });
    return () => {};
  }
  return glideScroll(p, { top }, { duration: GLIDE_MS, easing: EASE_POINTS });
}

/* Claude's serif (Anthropic Serif) is not public: Source Serif 4 is the closest free cut. Fonts load at document level. */
function loadClaudeSerif() {
  if (document.querySelector("link[data-claude-serif]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.dataset.claudeSerif = "";
  l.href =
    "https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,500&display=swap";
  document.head.append(l);
}

interface Box {
  el: HTMLDivElement;
  target: BoxTarget;
  inset?: boolean;
}
type BoxTarget =
  | HTMLElement
  | HTMLElement[]
  | null
  | (() => HTMLElement | HTMLElement[] | null);

export class App implements DvHost {
  after: boolean;
  notion: boolean;
  sr: ShadowRoot;
  chats: Chat[];
  arts: (Art & Rec)[];
  books: (Book & Rec)[] = [];
  S: RecentSettings = { ...RECENT_DEFAULTS };
  custom: string[] = [];
  route = { page: "artifacts" };
  secCol = new Set<string>();
  nid = 0;
  A = {
    tab: "All",
    q: "",
    searching: false,
    sort: "Last opened",
    owner: null as string | null,
    types: new Set<string>(),
    date: "Any time",
    sharing: "Any",
    pinned: false,
    layout: "grid",
  };
  R = { tab: "Active", q: "", searching: false, shown: 30, loading: false };
  dvSide: DataView | null = null;
  dvArts: DataView | null = null;
  menus: Menus;
  twin: Menus;
  frame!: HTMLElement;
  layer!: HTMLElement;
  fresh: string | null = null;
  quietScroll = 0;
  featSearch = false;
  featMenu = false;
  hk: string | null = null;
  boxes: Box[] = [];
  boxRaf = 0;
  featWait: object | null = null;
  savedScroll: Map<HTMLElement, number> | null = null;
  timers = new Set<ReturnType<typeof setTimeout>>();
  glides = new Set<() => void>();
  private off: (() => void)[] = [];

  constructor(host: HTMLElement, mode: FigureMode) {
    loadClaudeSerif();
    this.after = mode !== "before";
    this.notion = mode === "notion";
    this.sr = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    this.chats = makeChats();
    this.arts = makeArts() as (Art & Rec)[];
    if (this.notion) {
      this.books = makeBooks() as (Book & Rec)[];
      this.dvArts = new DataView(this, notionCfg(this));
    } else if (this.after) {
      this.dvSide = new DataView(this, sideCfg(this));
      this.dvArts = new DataView(this, artsCfg(this));
    }
    this.menus = new Menus(this);
    this.twin = new Menus(this);
    this.build();
    this.wire();
    this.renderSidebar(false);
    this.renderMain();
  }
  dispose() {
    for (const f of this.off) f();
    cancelAnimationFrame(this.boxRaf);
    for (const t of this.timers) clearTimeout(t);
    for (const g of this.glides) g();
    this.dvSide?.dispose();
    this.dvArts?.dispose();
    this.recIo?.disconnect();
  }
  later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }
  $(s: string) {
    return this.sr.querySelector<HTMLElement>(s);
  }
  liveChats() {
    return this.chats.filter((c) => !c.deleted);
  }
  pinnedArts(): Chat[] {
    return this.arts
      .filter((a) => a.pinned && !a.deleted)
      .map((a) => ({
        id: a.id,
        title: a.title,
        kind: "art",
        pinned: true,
        state: "Idle",
        unread: false,
        owner: "You",
        archived: false,
        model: MODELS[hash(a.id) % 2]!,
        project: a.project,
        hours: a.hours,
        created: a.created,
      }));
  }
  sideRows(): Rec[] {
    return this.liveChats().concat(this.pinnedArts());
  }

  build() {
    const A = this.after;
    if (this.notion) {
      /* a database page alone: no app sidebar, the data view is the whole page */
      this.sr.innerHTML = `<style>${STYLES}</style><div class="fig cl native"><div class="frame solo"><main class="main" data-main></main><div class="layer"></div></div></div>`;
      this.frame = this.$(".frame")!;
      this.layer = this.$(".layer")!;
      return;
    }
    this.sr.innerHTML =
      `<style>${STYLES}</style><div class="fig cl"><div class="frame">` +
      `<aside class="sb" aria-label="Sidebar"><div class="sbh"><button class="ib" data-act="sbtoggle" title="Toggle sidebar" aria-label="Toggle sidebar">${ic("sidebar")}</button><span class="word">Claude</span></div>` +
      `<nav class="nav"><button class="ni" data-act="new" title="New chat">${ic("plus")}<span>New</span></button><button class="ni" data-act="arts" data-nav>${ic("art")}<span>Artifacts</span></button></nav>` +
      (A
        ? `<div class="sbdv" data-dv="side"><div data-tb="side"></div><div class="sbb" data-scroll="side"><div class="dvbody" data-body="side"></div></div></div>`
        : `<div class="sbb" data-sbb></div>`) +
      `<div class="acct"><span class="av">A</span><span class="nm">Alex <span class="pl">· Pro</span></span></div></aside>` +
      `<main class="main" data-main></main><div class="layer"></div></div>` +
      this.features() +
      `<p class="cap">${A ? "My Claude version: conversation and artifacts share the same data view primitive" : "Claude: conversation and artifacts, two separate data-view reimplementations"}</p></div>`;
    this.frame = this.$(".frame")!;
    this.layer = this.$(".layer")!;
  }
  features() {
    const A = this.after,
      line = (
        k: string,
        side: string,
        [st, t]: readonly [FeatStatus, string],
      ) =>
        `<div class="fi" data-feat="${k}" data-side="${side}"><i class="${st}"${FEAT_TITLE[st] ? ` title="${FEAT_TITLE[st]}"` : ""}></i><span>${esc(t)}</span></div>`;
    return (
      `<div class="fl"><div class="flh">Conversation data view</div><div class="flh">Artifact data view</div>` +
      FEATS.map(
        ([k, sb, ar, after]) =>
          line(k, "sb", A ? ["nu", after] : sb) +
          line(k, "ar", A ? ["nu", after] : ar),
      ).join("") +
      `</div>`
    );
  }

  /* ---------- BEFORE: the sidebar, as on claude.ai ---------- */
  recents() {
    const S = this.S,
      by =
        S.sort === "Name"
          ? (a: Chat, b: Chat) => a.title.localeCompare(b.title)
          : S.sort === "Date created"
            ? (a: Chat, b: Chat) => a.created - b.created
            : (a: Chat, b: Chat) => a.hours - b.hours;
    return this.liveChats()
      .filter(
        (c) =>
          !c.pinned &&
          (S.status === "All" || (S.status === "Archived") === !!c.archived) &&
          c.hours < ACT[S.act]! &&
          (S.owner === "All" || c.owner === "You"),
      )
      .sort(by);
  }
  recGroups(rows: Chat[]) {
    const g = this.S.group;
    if (g === "None") return [{ k: "Recents", rows }];
    const keys =
      g === "State" ? STATES : g === "Date" ? BUCKETS : ["Unread", "Read"];
    const of = (c: Chat) =>
      g === "State"
        ? c.state
        : g === "Date"
          ? bucket(c.hours)
          : c.unread
            ? "Unread"
            : "Read";
    return keys
      .map((k) => ({ k, rows: rows.filter((c) => of(c) === k) }))
      .filter((x) => x.rows.length);
  }
  recDirty() {
    return (Object.keys(RECENT_DEFAULTS) as (keyof RecentSettings)[]).some(
      (k) => this.S[k] !== RECENT_DEFAULTS[k],
    );
  }
  head(name: string, opts: { recents?: boolean } = {}) {
    const col = this.secCol.has(name);
    return (
      `<div class="sech" data-k="s:${esc(name)}" ><button class="shb" data-act="sec" data-sec="${esc(name)}"><span>${esc(name)}</span>${ic(col ? "right" : "chev", 14)}</button>` +
      (opts.recents
        ? `<button class="sfb${this.recDirty() ? " has" : ""}" data-act="recmenu" title="Filter and group recents" aria-label="Filter and group recents">${ic("filter")}</button>`
        : "") +
      `</div>`
    );
  }
  renderSidebar(anim = true) {
    if (this.after) {
      if (this.dvSide) this.dvSide.renderAll(anim);
      return;
    }
    const box = this.$("[data-sbb]"),
      row = (r: Chat) =>
        cvRow(r, { k: "r:" + r.id, fresh: this.fresh === r.id });
    const pinned = this.liveChats()
      .filter((c) => c.pinned && !c.archived)
      .concat(this.pinnedArts());
    let html = "";
    if (pinned.length)
      html +=
        this.head("Pinned") +
        (this.secCol.has("Pinned") ? "" : pinned.map(row).join(""));
    this.custom.forEach((n) => {
      html += this.head(n);
    });
    const rec = this.recents(),
      take = rec.slice(0, 20),
      gs = this.recGroups(take);
    if (!gs.length)
      html +=
        this.head("Recents", { recents: true }) +
        `<div class="end" data-k="none">No chats</div>`;
    gs.forEach((g, i) => {
      html +=
        this.head(g.k, { recents: i === 0 }) +
        (this.secCol.has(g.k) ? "" : g.rows.map(row).join(""));
    });
    if (rec.length > take.length)
      html += `<button class="va" data-act="viewall" data-k="va" data-f="scroll">View all</button>`;
    flip(
      box,
      () => {
        if (box) box.innerHTML = html;
      },
      anim,
    );
    /* the header the open recents menu hangs from was redrawn: hang it from the new one */
    if (
      this.menus.open &&
      this.menus.anchor &&
      !this.menus.anchor.isConnected
    ) {
      const b = this.$("[data-act=recmenu]");
      if (b) {
        this.menus.anchor = b;
        b.classList.add("on");
        b.closest(".sech")!.classList.add("mon");
      }
    }
  }
  recMenu(): MenuItem[] {
    const S = this.S,
      set = (k: keyof RecentSettings, v: string) => {
        S[k] = v;
        this.renderSidebar(true);
      };
    const opt =
      (k: keyof RecentSettings) =>
      (o: string): MenuItem => ({
        label: o,
        check: S[k] === o,
        keep: 1,
        action: () => set(k, o),
      });
    return [
      {
        label: "Status",
        value: S.status,
        sub: () => ["Active", "Archived", "All"].map(opt("status")),
      },
      {
        label: "Last activity",
        value: S.act,
        sub: () => Object.keys(ACT).map(opt("act")),
      },
      {
        label: "Owner",
        value: S.owner,
        sub: () => ["All", "Yours"].map(opt("owner")),
      },
      { sep: 1 },
      {
        label: "Group by",
        value: S.group,
        sub: () => [
          ...["Date", "Unread", "State"].map(opt("group")),
          { sep: 1 },
          opt("group")("None"),
        ],
      },
      {
        label: "Sort by",
        value: S.sort,
        sub: () => ["Name", "Date created", "Last activity"].map(opt("sort")),
      },
      { sep: 1 },
      {
        label: "Reset to defaults",
        action: () => {
          this.S = { ...RECENT_DEFAULTS };
          this.renderSidebar(true);
        },
      },
      { sep: 1 },
      { label: "New section", action: () => this.newSection() },
    ];
  }
  newSection() {
    let n = "New section",
      i = 2;
    while (this.custom.includes(n)) n = "New section " + i++;
    this.custom.push(n);
    this.renderSidebar(true);
    this.renameSection(n);
  }
  renameSection(s: string) {
    const h = this.$(`.sech[data-k="s:${CSS.escape(s)}"] .shb`);
    if (!h) return;
    const inp = document.createElement("input");
    inp.className = "ren";
    inp.value = s;
    inp.style.margin = "0 4px";
    h.replaceWith(inp);
    focusElement(inp, { reveal: false });
    inp.select();
    let done = false;
    const fin = (ok: boolean) => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      if (ok && v && v !== s && !this.custom.includes(v))
        this.custom[this.custom.indexOf(s)] = v;
      this.renderSidebar(false);
    };
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") fin(true);
      else if (e.key === "Escape") fin(false);
    });
    inp.addEventListener("blur", () => fin(true));
  }
  /* New: a new conversation row at the top of the list, nothing else */
  newChat() {
    this.menus.close();
    const c: Chat = {
      id: "n" + ++this.nid,
      title: "New chat",
      kind: "chat",
      pinned: false,
      state: "Idle",
      model: MODELS[0]!,
      unread: false,
      owner: "You",
      archived: false,
      project: null,
      hours: 0.01,
      created: 0.01,
    };
    this.chats.unshift(c);
    this.fresh = c.id;
    if (this.after) this.dvSide!.renderBody(true);
    else this.renderSidebar(true);
    this.fresh = null;
    const sc = this.$(this.after ? "[data-scroll=side]" : "[data-sbb]"),
      r = sc && sc.querySelector<HTMLElement>(`[data-id="${c.id}"]`);
    if (sc && r) {
      const top = r.offsetTop - sc.offsetTop - 40;
      if (top < sc.scrollTop || top > sc.scrollTop + sc.clientHeight - 80)
        this.glide(sc, Math.max(0, top));
    }
    if (this.route.page === "recents") this.renderRecBody(true);
  }
  glide(p: HTMLElement, top: number) {
    const cancel = glideTo(p, top);
    this.glides.add(cancel);
    this.later(() => this.glides.delete(cancel), GLIDE_MS + 50);
  }
  markActive() {
    const n = this.$(".ni[data-nav]");
    if (n) n.classList.toggle("on", this.route.page === "artifacts");
  }

  /* ---------- main: the Artifacts page (or View all) ---------- */
  go(page: string) {
    this.menus.close();
    this.route = { page };
    this.renderMain();
    this.markActive();
  }
  renderMain() {
    const m = this.$("[data-main]")!,
      p = this.route.page;
    if (p === "recents") {
      m.innerHTML = `<div class="ms" data-scroll="rec"><div class="page"><h1 class="h1">Recents</h1><div class="bar" data-rbar></div><div data-rbody></div></div></div>`;
      this.R.shown = 30;
      this.renderRecBar();
      this.renderRecBody(false);
    } else if (this.notion) {
      const dv = this.dvArts!;
      m.innerHTML =
        `<div class="ms" data-dv="arts"><div class="page"><h1 class="h1">${esc(dv.c.title)}</h1><div data-tb="arts"></div>` +
        `<div class="nsc" data-scroll="arts"><div class="dvbody" data-body="arts"></div></div></div></div>`;
      dv.ioRoot = null;
      dv.renderAll(false);
    } else if (this.after) {
      const dv = this.dvArts!;
      m.innerHTML = `<div class="ms" data-scroll="arts" data-dv="arts"><div class="page"><h1 class="h1">${esc(dv.c.title || "Artifacts")}</h1><div data-tb="arts"></div><div class="dvbody" data-body="arts"></div></div></div>`;
      dv.ioRoot = null;
      dv.renderAll(false);
    } else {
      m.innerHTML = `<div class="ms" data-scroll="main"><div class="page"><h1 class="h1">Artifacts</h1><div class="bar" data-abar></div><div data-abody data-f="scroll layout"></div></div></div>`;
      this.renderArtsBar();
      this.renderArtsBody(false);
    }
    this.markActive();
  }
  /* refresh whatever lists are on screen after a data change */
  changed(anim = true) {
    this.renderSidebar(anim);
    if (this.route.page === "recents") this.renderRecBody(anim);
    else if (this.after) this.dvArts!.renderBody(anim);
    else this.renderArtsBody(anim);
  }

  /* ---------- BEFORE: the Artifacts page, as on claude.ai ---------- */
  artsList() {
    const A = this.A,
      q = A.q.trim().toLowerCase();
    const out = this.arts.filter(
      (a) =>
        !a.deleted &&
        (A.tab === "All" ||
          (A.tab === "Yours" ? a.owner === "You" : a.owner !== "You")) &&
        (!q || a.title.toLowerCase().includes(q)) &&
        (!A.owner || a.owner === A.owner) &&
        (!A.types.size || A.types.has(a.kind)) &&
        inDate(a.hours, A.date) &&
        (A.sharing === "Any" ||
          (A.sharing === "Shared"
            ? a.sharing !== "Private"
            : a.sharing === "Private" && a.owner === "You")) &&
        (!A.pinned || a.pinned),
    );
    const k = A.sort === "Last edited" ? "edited" : "hours";
    return out.sort((a, b) => a[k] - b[k]);
  }
  artsFiltered() {
    const A = this.A;
    return (
      A.sort !== "Last opened" ||
      !!A.owner ||
      A.types.size > 0 ||
      A.date !== "Any time" ||
      A.sharing !== "Any" ||
      A.pinned
    );
  }
  renderArtsBar() {
    const A = this.A,
      el = this.$("[data-abar]");
    if (!el) return;
    el.innerHTML =
      `<div class="tabs" data-f="views">${["All", "Yours", "Shared with you"].map((t) => `<button class="tab${A.tab === t ? " on" : ""}" data-act="atab" data-v="${t}">${t}</button>`).join("")}</div>` +
      `<div class="tools">` +
      (A.searching
        ? `<label class="sfield" data-f="search">${ic("search", 16)}<input data-aq placeholder="Search artifacts..." value="${esc(A.q)}" aria-label="Search artifacts"><button class="x" data-act="asearchx" title="Close search">${ic("close", 13)}</button></label>`
        : `<button class="ib" data-act="asearch" data-f="search" title="Search your artifacts" aria-label="Search your artifacts">${ic("search")}</button>`) +
      `<button class="ib${this.artsFiltered() ? " has" : ""}" data-act="afilter" data-f="filter sort" title="Filter and sort" aria-label="Filter and sort">${ic("filter")}</button>` +
      `<button class="ib" data-act="alayout" data-f="layout" title="${A.layout === "grid" ? "List view" : "Grid view"}" aria-label="${A.layout === "grid" ? "List view" : "Grid view"}">${ic(A.layout === "grid" ? "list" : "grid")}</button>` +
      `<button class="ib" data-act="create" title="New" aria-label="New">${ic("plus")}</button></div>`;
  }
  renderArtsBody(anim = true) {
    const el = this.$("[data-abody]");
    if (!el) return;
    const list = this.artsList(),
      A = this.A,
      o = (a: Art) => ({
        k: A.layout[0] + ":" + a.id,
        time: A.sort === "Last edited" ? "edited" : "hours",
      });
    const html = !list.length
      ? `<div class="empty">No artifacts found</div>`
      : A.layout === "grid"
        ? `<div class="ag">${list.map((a) => artCard(a, o(a))).join("")}</div>`
        : `<div class="al">${list.map((a) => artRow(a, o(a))).join("")}</div>`;
    flip(
      el,
      () => {
        el.innerHTML = html;
      },
      anim,
    );
  }
  artsFilterMenu(): MenuItem[] {
    const A = this.A,
      again = () => {
        this.renderArtsBar();
        this.renderArtsBody(true);
      };
    const one =
      (cur: () => string, opts: string[], set: (o: string) => void) => () =>
        opts.map((o): MenuItem => ({
          label: o,
          check: cur() === o,
          checkable: 1,
          keep: 1,
          action: () => {
            set(o);
            again();
          },
        }));
    const types =
      A.types.size === 0
        ? "Any"
        : A.types.size === 1
          ? [...A.types][0]!
          : A.types.size + " types";
    const live = this.arts.filter((a) => !a.deleted);
    return [
      {
        label: "Sort by",
        value: A.sort,
        sub: one(
          () => A.sort,
          ["Last opened", "Last edited"],
          (o) => {
            A.sort = o;
          },
        ),
      },
      { sep: 1 },
      {
        label: "Owner",
        value: A.owner || "Anyone",
        sub: () =>
          ["You", "Other people"].map((o): MenuItem => ({
            label: o,
            check: A.owner === o,
            checkable: 1,
            keep: 1,
            action: () => {
              A.owner = A.owner === o ? null : o;
              again();
            },
          })),
      },
      {
        label: "Type",
        value: types,
        sub: () =>
          TYPES.map((t): MenuItem => ({
            label: t,
            count: live.filter((a) => a.kind === t).length,
            check: A.types.has(t),
            checkable: 1,
            keep: 1,
            action: () => {
              if (A.types.has(t)) A.types.delete(t);
              else A.types.add(t);
              again();
            },
          })),
      },
      {
        label: "Date opened",
        value: A.date,
        sub: one(
          () => A.date,
          DATES,
          (o) => {
            A.date = o;
          },
        ),
      },
      {
        label: "Sharing",
        value: A.sharing,
        sub: one(
          () => A.sharing,
          ["Any", "Only you", "Shared"],
          (o) => {
            A.sharing = o;
          },
        ),
      },
      { sep: 1 },
      {
        label: "Pinned",
        check: A.pinned,
        checkable: 1,
        keep: 1,
        action: () => {
          A.pinned = !A.pinned;
          again();
        },
      },
    ];
  }
  createMenu(): MenuItem[] {
    const mk = (kind: string, label: string, badge?: string): MenuItem => ({
      label,
      icon: KIND[kind]!.ic,
      ...(badge ? { badge } : {}),
      action: () => this.createArt(kind),
    });
    return [
      { label: "Chat", icon: "chat", action: () => this.newChat() },
      {
        label: "Folder",
        icon: "folder",
        action: () => this.createArt("Folder"),
      },
      { sep: 1 },
      mk("Docs", "Docs"),
      mk("Slides", "Slides"),
      mk("Design", "Design"),
      mk("Sheets", "Sheets", "Beta"),
      mk("Data", "Data"),
      mk("Whiteboard", "Whiteboard", "Beta"),
    ];
  }
  /* a new book: a new record at the top, in whatever view is showing */
  newBook() {
    const b = {
      id: "n" + ++this.nid,
      title: "Untitled",
      author: "",
      genre: "Novel",
      shelf: "To read",
      rating: "Unrated",
      hours: 0.01,
    };
    this.books.unshift(b);
    this.fresh = b.id;
    this.dvArts!.toTop();
    this.dvArts!.renderBody(true);
    this.fresh = null;
  }
  /* a new artifact: a new card at the top of the list, nothing else */
  createArt(kind: string) {
    const a: Art = {
      id: "x" + ++this.nid,
      title:
        kind === "Folder"
          ? "Untitled folder"
          : "Untitled " + (kind === "Docs" ? "doc" : kind.toLowerCase()),
      kind,
      hours: 0.01,
      edited: 0.01,
      created: 0.01,
      owner: "You",
      sharing: "Private",
      pinned: false,
      project: null,
    };
    this.arts.unshift(a);
    if (this.route.page !== "artifacts") this.go("artifacts");
    else this.changed(true);
    const sc = this.$("[data-main] .ms");
    if (sc && sc.scrollTop)
      scrollToTop(sc, { behavior: reduce() ? "auto" : "smooth" });
  }

  /* ---------- BEFORE: Recents, Claude's third list (View all) ---------- */
  recIo: InViewWatcher | null = null;
  recList() {
    const R = this.R,
      q = R.q.trim().toLowerCase();
    if (R.tab === "Shared") return [];
    return this.chats
      .filter(
        (c) =>
          !c.deleted &&
          !!c.archived === (R.tab === "Archived") &&
          (!q || c.title.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.hours - b.hours);
  }
  renderRecBar() {
    const R = this.R,
      el = this.$("[data-rbar]");
    if (!el) return;
    el.innerHTML =
      `<div class="tabs">${["Active", "Shared", "Archived"].map((t) => `<button class="tab${R.tab === t ? " on" : ""}" data-act="rtab" data-v="${t}">${t}</button>`).join("")}</div><div class="tools">` +
      (R.searching
        ? `<label class="sfield">${ic("search", 16)}<input data-rq placeholder="Search your chats..." value="${esc(R.q)}" aria-label="Search your chats"><button class="x" data-act="rsearchx" title="Close search">${ic("close", 13)}</button></label>`
        : `<button class="ib" data-act="rsearch" title="Search" aria-label="Search">${ic("search")}</button>`) +
      `<button class="btn dark" data-act="new">New session</button></div>`;
  }
  renderRecBody(anim = true) {
    const R = this.R,
      el = this.$("[data-rbody]");
    if (!el) return;
    const list = this.recList(),
      take = list.slice(0, R.shown);
    let html = !list.length
      ? `<div class="empty">${R.tab === "Shared" ? "No shared chats yet" : "No chats found"}</div>`
      : `<div class="rl">${take.map((c) => `<div class="rrow" data-k="q:${c.id}" data-id="${c.id}"><div class="rrb"><span class="t">${esc(c.title)}</span><span class="rm">${longAgo(c.hours)}</span></div></div>`).join("")}</div>`;
    if (take.length < list.length)
      html += `<div class="more" data-rsent>${R.loading ? '<span class="spin"></span>' : ""}</div>`;
    flip(
      el,
      () => {
        el.innerHTML = html;
      },
      anim,
    );
    const root = this.$("[data-scroll=rec]"),
      s = el.querySelector<HTMLElement>("[data-rsent]");
    this.recIo?.disconnect();
    this.recIo = null;
    if (s && root) {
      this.recIo = createInViewWatcher(
        (es) => {
          if (!es.some((e) => e.isIntersecting) || R.loading) return;
          R.loading = true;
          s.innerHTML = '<span class="spin"></span>';
          this.later(() => {
            R.loading = false;
            R.shown += 30;
            this.renderRecBody(true);
          }, 480);
        },
        { root, rootMargin: "0px 0px 120px 0px" },
      );
      this.recIo.observe(s);
    }
  }

  /* ---------- events ---------- */
  dvById(id: string) {
    return id === "side" ? this.dvSide! : this.dvArts!;
  }
  listen<K extends keyof DocumentEventMap>(
    t: Document,
    type: K,
    fn: (e: DocumentEventMap[K]) => void,
    capture?: boolean,
  ) {
    t.addEventListener(type, fn, capture);
    this.off.push(() => t.removeEventListener(type, fn, capture));
  }
  wire() {
    const sr = this.sr;
    sr.addEventListener("click", (e) => this.onClick(e));
    sr.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.dvq) this.dvById(t.dataset.dvq).setQ(t.value);
      else if (t.hasAttribute("data-aq")) {
        this.A.q = t.value;
        this.renderArtsBody(true);
      } else if (t.hasAttribute("data-rq")) {
        this.R.q = t.value;
        this.R.shown = 30;
        this.renderRecBody(true);
      }
    });
    sr.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if ((e as KeyboardEvent).key !== "Escape" || this.menus.open) return;
      if (t.hasAttribute("data-aq")) {
        this.A.q = "";
        this.A.searching = false;
        this.renderArtsBar();
        this.renderArtsBody(true);
      } else if (t.dataset.dvq === "arts") this.dvArts!.setSearching(false);
      else if (t.hasAttribute("data-rq")) {
        this.R.q = "";
        this.R.searching = false;
        this.renderRecBar();
        this.renderRecBody(true);
      }
    });
    /* a press or hover in the layer goes to whichever menu stack drew that menu */
    const owner = (e: Event) => {
      const m = (e.target as Element).closest(".menu");
      return m && this.twin.levels.some((L) => L.el === m)
        ? this.twin
        : this.menus;
    };
    const refocus = (el: HTMLElement | null) =>
      focusElement(el, { reveal: false });
    this.layer.addEventListener("click", (e) => {
      e.stopPropagation();
      owner(e).click(e, refocus);
    });
    this.layer.addEventListener("pointerover", (e) => owner(e).hover(e));
    /* an open menu owns the keyboard wherever focus is: Escape closes it */
    this.listen(
      document,
      "keydown",
      (e) => {
        if (!this.menus.open || e.key !== "Escape") return;
        this.menus.close();
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
    /* close menus on any press outside them (inside or outside the figure) */
    this.listen(
      document,
      "pointerdown",
      (e) => {
        if (!this.menus.open) return;
        const path = e.composedPath();
        if (
          path.includes(this.layer) ||
          (this.menus.anchor && path.includes(this.menus.anchor))
        )
          return;
        this.menus.close();
      },
      true,
    );
    sr.addEventListener(
      "scroll",
      () => {
        if (performance.now() - (this.quietScroll || 0) < 150) return;
        this.menus.close();
      },
      true,
    );
    /* hovering a feature line opens the menu or control it is about, in this figure; leaving it closes it again */
    const fl = this.$(".fl");
    if (fl)
      fl.addEventListener("pointerover", (e) => {
        const fi = (e.target as Element).closest<HTMLElement>(".fi[data-feat]"),
          key = fi ? fi.dataset.feat! : null;
        if (key === this.hk) return;
        this.featOff(!key);
        this.hk = key;
        if (key) this.featOn(key);
      });
    if (fl)
      fl.addEventListener("pointerleave", () => {
        this.featOff(true);
        this.hk = null;
      });
  }
  /* a feature line is one row of two twins (sidebar | Artifacts page): hovering either lights both, and shows that
     feature in BOTH surfaces at once, as ONE box per surface around the control it is about (a menu, opened as its
     whole tree down to the list the line is about, or the control itself). Each surface gets its own menu stack (the
     sidebar's on this.menus, the page's on this.twin), so the two never stack into each other. In a menu, the box
     wraps the rows the line is about, as one run from the first to the last of them, never rows one by one.
     The box is drawn over the figure, in the menu layer: nothing in the figure changes size, so nothing moves. */
  /* the rows of an open menu (lv: its level, negative from the deepest) the picked items draw */
  rowsIn(
    M: Menus,
    lv: number,
    pick: (it: MenuItem) => boolean = (it) => !!it.label,
  ) {
    return () => {
      const L = M.levels[lv < 0 ? M.levels.length + lv : lv];
      if (!L || !L.items) return null;
      return L.items
        .map((it, i) =>
          !it.sep && !it.header && pick(it)
            ? L.el.querySelector<HTMLElement>(`[data-i="${i}"]`)
            : null,
        )
        .filter((e): e is HTMLElement => !!e);
    };
  }
  box(target: BoxTarget, inset?: boolean) {
    if (!target) return;
    const el = document.createElement("div");
    el.className = "hbox";
    this.layer.append(el);
    this.boxes.push({ el, target, ...(inset ? { inset } : {}) });
  }
  /* where each box sits now: around its target, cut to what the target's scrolling ancestors show of it */
  placeBoxes() {
    const F = this.frame.getBoundingClientRect();
    for (const b of this.boxes) {
      const got = typeof b.target === "function" ? b.target() : b.target,
        els = Array.isArray(got) ? got : got ? [got] : [];
      if (!els.length || els.some((e) => !e.isConnected)) {
        b.el.style.display = "none";
        continue;
      }
      /* a run of rows is boxed as one: the union of their boxes */
      const rs = els.map((e) => e.getBoundingClientRect()),
        t = els[0]!,
        pad = b.inset ? -4 : 4;
      let x0 = Math.min(...rs.map((r) => r.left)) - pad,
        y0 = Math.min(...rs.map((r) => r.top)) - pad,
        x1 = Math.max(...rs.map((r) => r.right)) + pad,
        y1 = Math.max(...rs.map((r) => r.bottom)) + pad,
        cut = false;
      for (
        let p = t.parentElement;
        p && p !== this.frame.parentElement;
        p = p.parentElement
      ) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const c = p.getBoundingClientRect(),
          m = 4;
        if (y0 < c.top + m) {
          y0 = c.top + m;
          cut = true;
        }
        if (y1 > c.bottom - m) {
          y1 = c.bottom - m;
          cut = true;
        }
        if (x0 < c.left + m) {
          x0 = c.left + m;
          cut = true;
        }
        if (x1 > c.right - m) {
          x1 = c.right - m;
          cut = true;
        }
      }
      if (x1 - x0 < 8 || y1 - y0 < 8) {
        b.el.style.display = "none";
        continue;
      }
      const rad = parseFloat(getComputedStyle(t).borderTopLeftRadius) || 0;
      Object.assign(b.el.style, {
        display: "",
        left: x0 - F.left + "px",
        top: y0 - F.top + "px",
        width: x1 - x0 + "px",
        height: y1 - y0 + "px",
        borderRadius: (b.inset || cut ? 10 : Math.max(8, rad + pad)) + "px",
      });
    }
  }
  /* leave: the pointer left the lines altogether (not just moved to the next one): the lists scroll back */
  featOff(leave: boolean) {
    this.sr
      .querySelectorAll(".fi.lit")
      .forEach((x) => x.classList.remove("lit"));
    this.featClear();
    if (leave) this.revealScroll([]);
  }
  /* take down what a line shows (its boxes, menus and opened search), leaving the lists where they are */
  featClear() {
    this.boxes.forEach((b) => b.el.remove());
    this.boxes = [];
    cancelAnimationFrame(this.boxRaf);
    this.featWait = null;
    if (this.featMenu) {
      this.featMenu = false;
      this.menus.close();
      this.twin.close();
    }
    if (this.featSearch) {
      this.featSearch = false;
      if (this.after) {
        if (!this.dvArts!.q) this.dvArts!.setSearching(false);
      } else if (!this.A.q) {
        this.A.searching = false;
        this.renderArtsBar();
      }
    }
  }
  featOn(k: string) {
    this.sr
      .querySelectorAll(`.fi[data-feat="${k}"]`)
      .forEach((x) => x.classList.add("lit"));
    this.featShow(k);
    /* what it shows may sit in a part of a list scrolled out of sight: scroll the lists so it is all in view, and
       show it again once they settle (menus hang from where their control will be, not from where it was) */
    const moving = this.revealScroll(this.featTargets());
    if (!moving) return;
    this.featClear();
    const wait = (this.featWait = {});
    this.later(() => {
      if (this.featWait === wait && this.hk === k) this.featShow(k);
    }, GLIDE_MS + 30);
  }
  featShow(k: string) {
    this.boxes = [];
    this.featSide(k, "sb", this.menus);
    this.featSide(k, "ar", this.twin);
    this.featMenu = this.menus.open || this.twin.open;
    this.unclash();
    /* a box follows its target while the line is hovered (a search field growing) */
    cancelAnimationFrame(this.boxRaf);
    const tick = () => {
      this.placeBoxes();
      this.boxRaf = requestAnimationFrame(tick);
    };
    tick();
  }
  /* what a hovered line shows: the controls its menus hang from and what it boxes */
  featTargets() {
    const els: HTMLElement[] = [];
    for (const M of [this.menus, this.twin])
      if (M.open && M.anchor) els.push(M.anchor);
    for (const b of this.boxes) {
      const g = typeof b.target === "function" ? b.target() : b.target;
      (Array.isArray(g) ? g : g ? [g] : []).forEach((e) => els.push(e));
    }
    return els;
  }
  /* scroll the figure's lists, smoothly, so every element is fully in sight; a list none of them needs goes back to
     where the reader left it (that position is kept from the first hovered line until the pointer leaves the lines).
     Only the figure's own scrolling boxes move: never the page, never the layout. Answers whether any list moves. */
  revealScroll(els: HTMLElement[]) {
    const saved = (this.savedScroll ??= new Map());
    const want = new Map<HTMLElement, number>(),
      m = 8;
    for (const el of els) {
      if (!el.isConnected) continue;
      for (
        let p = el.parentElement;
        p && p !== this.frame;
        p = p.parentElement
      ) {
        const cs = getComputedStyle(p);
        if (
          !/(auto|scroll)/.test(cs.overflowY) ||
          p.scrollHeight <= p.clientHeight
        )
          continue;
        const r = el.getBoundingClientRect(),
          c = p.getBoundingClientRect(),
          top = r.top - c.top + p.scrollTop,
          h = r.height;
        if (h + 2 * m > p.clientHeight) continue;
        const base = want.has(p)
          ? want.get(p)!
          : saved.has(p)
            ? saved.get(p)!
            : p.scrollTop;
        let t = base;
        if (top - m < t) t = top - m;
        else if (top + h + m > t + p.clientHeight)
          t = top + h + m - p.clientHeight;
        /* something in the list's first screen (a page's toolbar): back to the very top, its title in sight too */
        if (t < base && top + h + m <= p.clientHeight) t = 0;
        want.set(p, Math.max(0, t));
      }
    }
    let moving = false;
    const go = (p: HTMLElement, top: number) => {
      if (Math.abs(p.scrollTop - top) < 1) return;
      this.quietScroll = performance.now() + 1000;
      moving = true;
      this.glide(p, top);
    };
    for (const [p, top] of saved)
      if (!want.has(p)) {
        if (p.isConnected) go(p, top);
        saved.delete(p);
      }
    for (const [p, top] of want) {
      if (!saved.has(p)) saved.set(p, p.scrollTop);
      go(p, top);
    }
    return moving;
  }
  /* the two surfaces' menu trees open at once: when the sidebar's tree reaches into the page's, slide the page's to
     the right, as far as the figure allows */
  unclash() {
    const A = this.menus.levels,
      B = this.twin.levels;
    if (!A.length || !B.length) return;
    const r = (e: HTMLElement) => ({
      l: e.offsetLeft,
      r: e.offsetLeft + e.offsetWidth,
      t: e.offsetTop,
      b: e.offsetTop + e.offsetHeight,
    });
    const clash = (dx: number, dy: number) =>
      A.some((x) =>
        B.some((y) => {
          const p = r(x.el),
            q = r(y.el);
          return (
            p.l < q.r + dx + 8 &&
            q.l + dx < p.r + 8 &&
            p.t < q.b + dy &&
            q.t + dy < p.b
          );
        }),
      );
    if (!clash(0, 0)) return;
    const F = this.frame.getBoundingClientRect(),
      u = B.map((L) => r(L.el)).reduce((a, q) => ({
        l: Math.min(a.l, q.l),
        r: Math.max(a.r, q.r),
        t: Math.min(a.t, q.t),
        b: Math.max(a.b, q.b),
      }));
    const move = (dx: number, dy: number) =>
      B.forEach((L) => {
        L.el.style.left = L.el.offsetLeft + dx + "px";
        L.el.style.top = L.el.offsetTop + dy + "px";
      });
    /* slide the page's tree right as far as the figure allows, else down (a narrow figure: the sidebar stacked above the
       page), the least that clears the sidebar's */
    for (let dx = 0; dx <= F.width - 8 - u.r; dx += 4)
      if (!clash(dx, 0)) {
        move(dx, 0);
        return;
      }
    for (let dy = 0; dy <= F.height - 8 - u.b; dy += 4)
      if (!clash(0, dy)) {
        move(0, dy);
        return;
      }
    const a = A.map((L) => r(L.el)).reduce((x, q) => Math.max(x, q.b), 0);
    move(0, a + 8 - u.t);
  }
  /* open the page's search field, if that moves nothing below it (a narrow page wraps it to a row of its own):
     otherwise leave the search button as it is. Answers the control to box. */
  openSearchIfStill(
    open: () => void,
    close: () => void,
    field: () => HTMLElement | null,
    button: () => HTMLElement | null,
  ): BoxTarget {
    /* what must stay put: the list, and the view tabs beside the search */
    const still = () =>
      [
        ...this.sr.querySelectorAll(
          "[data-main] .page > :last-child, [data-main] .tabs, [data-main] .tabs > *, [data-main] .vts > *, [data-main] .tools > .ib:not([data-dvact=qopen]):not([data-act=asearch])",
        ),
      ]
        .map((e) => {
          const r = e.getBoundingClientRect();
          return [r.left, r.top, r.width, r.height].map(Math.round).join(",");
        })
        .join("|");
    const was = still();
    open();
    /* judged at the field's full width, not mid-grow */
    this.sr
      .querySelectorAll("[data-main] .sfield")
      .forEach((e) => e.getAnimations().forEach((x) => x.finish()));
    if (still() !== was) {
      close();
      return button();
    }
    this.featSearch = true;
    return field;
  }
  /* what each line points at, per surface. A line about something a surface lacks points at nothing there. */
  featSide(k: string, side: "sb" | "ar", M: Menus) {
    if (this.after && !this.dvSide && side === "sb") return;
    const R = (lv: number, pick?: (it: MenuItem) => boolean) =>
        this.rowsIn(M, lv, pick),
      named =
        (...ls: string[]) =>
        (it: MenuItem) =>
          ls.includes(it.label!),
      fields = (it: MenuItem) =>
        !!it.label && !/^(Clear filters|Reset view)$/.test(it.label);
    if (this.after && side === "ar") {
      if (this.route.page !== "artifacts") return;
      const dv = this.dvArts!,
        tb = dv.$("data-tb")!,
        b = (a: string) => dv.barBtn(a),
        o = { cls: "wide", align: "end" as const };
      if (k === "search") {
        if (dv.searching || dv.q)
          this.box(tb.querySelector<HTMLElement>(".dsrch .sfield"));
        else
          this.box(
            this.openSearchIfStill(
              () => dv.setSearching(true),
              () => dv.setSearching(false),
              () => tb.querySelector<HTMLElement>(".dsrch .sfield"),
              () => b("qopen"),
            ),
          );
      } else if (k === "views")
        this.box(tb.querySelector<HTMLElement>(".tabs"));
      else if (k === "filter") {
        M.openPath(b("filter"), () => dv.filterMenu(), [], o);
        this.box(R(-1, fields));
      } else if (k === "sort") {
        M.openPath(b("sort"), () => dv.sortMenu(), [], o);
        this.box(R(-1));
      } else if (k === "group") {
        M.openPath(
          b("vsettings"),
          () => dv.viewSettingsMenu(),
          ["Group by"],
          o,
        );
        this.box(R(-1));
      } else if (k === "layout") {
        M.openPath(b("vsettings"), () => dv.viewSettingsMenu(), ["Layout"], o);
        this.box(R(-1));
      } else if (k === "scroll") this.box(() => dv.$("data-body"));
      return;
    }
    if (this.after) {
      const dv = this.dvSide!,
        tb = dv.$("data-tb")!,
        opts = { cls: "wide", align: "start" as const },
        sb = tb.querySelector<HTMLElement>(".sbtn")!;
      if (k === "search") {
        M.openPath(sb, () => dv.settingsMenu(), [], opts);
        this.box(R(0, (it) => !!it.input));
      } else if (k === "filter") {
        M.openPath(sb, () => dv.settingsMenu(), ["Filter"], opts);
        this.box(R(-1, fields));
      } else if (k === "sort") {
        M.openPath(sb, () => dv.settingsMenu(), ["Sort"], opts);
        this.box(R(-1));
      } else if (k === "group") {
        M.openPath(
          sb,
          () => dv.settingsMenu(),
          ["View settings", "Group by"],
          opts,
        );
        this.box(R(-1));
      } else if (k === "layout") {
        M.openPath(
          sb,
          () => dv.settingsMenu(),
          ["View settings", "Layout"],
          opts,
        );
        this.box(R(-1));
      } else if (k === "views") {
        M.openPath(
          tb.querySelector<HTMLElement>(".vbtn")!,
          () => dv.viewsMenu(),
          [],
          { ...opts, matchWidth: true },
        );
        this.box(R(0, (it) => !!it.checkable || it.label === "Add view"));
      } else if (k === "scroll") this.box(() => dv.$("data-body"));
      return;
    }
    if (side === "sb") {
      const btn = this.$("[data-act=recmenu]"),
        o = { beside: this.$(".sb") },
        sc = this.$("[data-sbb]");
      if (k === "filter" && btn) {
        M.openPath(btn, () => this.recMenu(), [], o);
        this.box(R(0, named("Status", "Last activity", "Owner")));
      } else if (k === "sort" && btn) {
        M.openPath(btn, () => this.recMenu(), ["Sort by"], o);
        this.box(R(-1));
      } else if (k === "group" && btn) {
        M.openPath(btn, () => this.recMenu(), ["Group by"], o);
        this.box(R(-1));
      } else if (k === "views" || k === "layout") this.box(sc, true);
      else if (k === "scroll") {
        const va = this.$(".va");
        if (va) this.box(() => this.$(".va"));
      }
      return;
    }
    if (this.route.page !== "artifacts") return;
    const fb = this.$("[data-act=afilter]")!;
    if (k === "search") {
      if (this.A.searching) this.box(this.$("[data-abar] .sfield"));
      else
        this.box(
          this.openSearchIfStill(
            () => {
              this.A.searching = true;
              this.renderArtsBar();
            },
            () => {
              this.A.searching = false;
              this.renderArtsBar();
            },
            () => this.$("[data-abar] .sfield"),
            () => this.$("[data-act=asearch]"),
          ),
        );
    } else if (k === "filter") {
      M.openPath(fb, () => this.artsFilterMenu(), []);
      this.box(
        R(0, named("Owner", "Type", "Date opened", "Sharing", "Pinned")),
      );
    } else if (k === "sort") {
      M.openPath(fb, () => this.artsFilterMenu(), ["Sort by"]);
      this.box(R(-1));
    } else if (k === "views") this.box(this.$("[data-abar] .tabs"));
    else if (k === "layout") this.box(this.$("[data-act=alayout]"));
    else if (k === "scroll") this.box(() => this.$("[data-abody]"));
  }
  onClick(e: Event) {
    const t = e.target as Element;
    const d = t.closest<HTMLElement>("[data-dvact]");
    if (d) {
      this.dvById(d.closest<HTMLElement>("[data-dv]")!.dataset.dv!).handle(
        d.dataset.dvact!,
        d,
      );
      return;
    }
    const a = t.closest<HTMLElement>("[data-act]");
    if (!a) return;
    const act = a.dataset.act ?? "",
      A = this.A,
      R = this.R;
    switch (act) {
      case "sbtoggle":
        this.frame.classList.toggle("col");
        this.menus.close();
        return;
      case "new":
        this.newChat();
        return;
      case "arts":
        this.go("artifacts");
        return;
      case "create":
        if (this.notion) this.newBook();
        else this.menus.openAt(a, () => this.createMenu());
        return;
      /* before */
      case "sec": {
        const s = a.dataset.sec!;
        if (this.secCol.has(s)) this.secCol.delete(s);
        else this.secCol.add(s);
        this.renderSidebar(true);
        return;
      }
      case "recmenu":
        this.menus.openAt(a, () => this.recMenu(), { beside: this.$(".sb") });
        return;
      case "viewall":
        this.go("recents");
        return;
      case "atab":
        A.tab = a.dataset.v!;
        this.renderArtsBar();
        this.renderArtsBody(true);
        return;
      case "asearch":
        A.searching = true;
        this.featSearch = false;
        this.renderArtsBar();
        focusElement(this.$("[data-aq]"), { reveal: false });
        return;
      case "asearchx":
        A.q = "";
        A.searching = false;
        this.renderArtsBar();
        this.renderArtsBody(true);
        return;
      case "afilter":
        this.menus.openAt(a, () => this.artsFilterMenu());
        return;
      case "alayout":
        A.layout = A.layout === "grid" ? "list" : "grid";
        this.renderArtsBar();
        this.renderArtsBody(true);
        return;
      case "rtab":
        R.tab = a.dataset.v!;
        R.shown = 30;
        this.renderRecBar();
        this.renderRecBody(true);
        return;
      case "rsearch":
        R.searching = true;
        this.renderRecBar();
        focusElement(this.$("[data-rq]"), { reveal: false });
        return;
      case "rsearchx":
        R.q = "";
        R.searching = false;
        this.renderRecBar();
        this.renderRecBody(true);
        return;
    }
  }
}
