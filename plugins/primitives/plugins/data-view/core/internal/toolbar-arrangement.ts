import type { ComponentType, ReactNode } from "react";

/**
 * The forms the host builds a toolbar's parts in. Data, not components: the
 * host owns every part (search, control triggers, creators) and only asks the
 * arrangement which shape of each it wants, so an arrangement can place parts
 * but never re-instantiate one.
 */
export interface ToolbarPartForms {
  /** `field`: a bordered fixed-width search box. `filled`: the same
   *  fixed-width box as a quiet well (no border at rest) — the search sitting
   *  inside a pill that already draws the edge. `bare`: a borderless field
   *  that fills its cell, with a trailing `/` hint; Escape clears it. */
  search: "field" | "filled" | "bare";
  /** `ghost`: square ghost icon triggers. `round`: circular icon triggers. */
  controls: "ghost" | "round";
  /** `labelled`: one creator is a labelled button. `round`: a filled circular
   *  `+` (its label moves to the tooltip). */
  creators: "labelled" | "round";
}

/**
 * The pre-built pieces of a DataView toolbar, handed to an arrangement to place.
 * Every node is built once by the host; an arrangement renders each at most
 * once (a part rendered twice would be two live instances of it).
 */
export interface ToolbarParts {
  /** The surface's title (`DataViewProps.title`), or `null`. */
  title: ReactNode;
  /**
   * The view switcher in both of its forms — `strip` (the editable chip row)
   * and `chip` (one collapsed chip). Render exactly one. Both are `null` on a
   * pinned surface. The switcher is the only way to add, rename or reorder
   * views, so an arrangement must render one of them.
   */
  switcher: { strip: ReactNode; chip: ReactNode };
  /** The search input, in `forms.search`. Always render it: a non-empty query
   *  must stay visible. */
  search: ReactNode;
  /** Moves keyboard focus into the search input. */
  focusSearch: () => void;
  /** The current search query. */
  query: string;
  /** One trigger per applicable `DataViewSlots.Control`, in order, in
   *  `forms.controls`. */
  controls: ReactNode;
  /** The same controls behind ONE trigger (without search), in
   *  `forms.controls` — for an arrangement that runs out of room. */
  foldedControls: ReactNode;
  /** Consumer toolbar actions (`DataViewProps.actions`). */
  actions: ReactNode;
  /** The create affordance (`DataViewProps.creators`), in `forms.creators`;
   *  `null` when the surface declares none (so an arrangement can drop the
   *  divider it would draw before it). */
  creators: ReactNode;
  /**
   * How far from the surface's left edge the surface's `aside`
   * (`DataViewProps.aside`) reaches, as a CSS length — `"0px"` when there is
   * none. An {@link ToolbarArrangement.overlay} arrangement starts its left
   * card past it (adding its own gutter), so the cards never sit on the aside's
   * floating card. An in-flow band is already beside the aside's column and
   * can ignore it (it is `"0px"` there).
   */
  asideInset: string;
}

/**
 * How a DataView lays out its WIDE toolbar. A surface passes the arrangement
 * value it imported (`DataViewProps.toolbar`); absent → the default bar. The
 * host still owns the sticky band, its measurement, the hover-reveal group and
 * the compact fold — an arrangement only decides the wide layout, so no
 * arrangement can break a narrow pane.
 */
export interface ToolbarArrangement {
  /** Stable name, for debugging and tests. */
  id: string;
  forms: ToolbarPartForms;
  component: ComponentType<ToolbarParts>;
  /**
   * Empty space between the toolbar band and the view below it, as a CSS
   * length; absent → none (the view starts flush under the band). It sits
   * OUTSIDE the sticky band, so the pinned band never grows by it. Only the
   * wide layout wears it: the compact fold keeps a narrow pane's tight rhythm.
   */
  spaceBelow?: string;
  /**
   * `true`: the band FLOATS over the view instead of sitting above it. The
   * host positions the band absolutely over the surface's top edge
   * (transparent, `pointer-events: none`, no mask) and gives the view the whole
   * surface: the DataView root fills its parent's height, the view renders in
   * a scroller under the band, and a view that declares `fullBleed` (a map)
   * starts at the very top edge, under the band. Any other view is inset by
   * the band's height and the aside's reach, so its first row clears the
   * cards. The arrangement draws its parts as floating cards and opts EACH
   * card back into pointer events (`Overlay.Interactive`), so the gaps between
   * them stay click-through to the view. `spaceBelow` is ignored.
   *
   * The compact fold floats too, as the host's one bar on a raised card of its
   * own (past the aside), so the view's inset means the same thing at every
   * width and a narrow pane never shows a transparent row of controls.
   */
  overlay?: true;
}

/**
 * What a hosted toolbar's frame receives — see {@link HostedToolbar}. Every
 * node is built once by the host; the frame renders each at most once.
 */
export interface HostedToolbarParts {
  /**
   * The one options trigger: search, and every applicable control, behind one
   * button that shows a count badge while anything narrows the list. It is the
   * ONLY way to reach them, so render it — in the frame's own header, where the
   * user looks for the surface's controls. Hover-revealed off the DataView
   * root (which the frame renders inside) unless `forms.options` is
   * `visible`, and pinned visible while a search query is typed. A frame may
   * portal it (and the switcher / creators) into chrome outside the DataView —
   * a surface's own toolbar — since a portal keeps the controls' context. `null` while the surface has no active view (its config
   * is loading, or authors no view).
   */
  options: ReactNode;
  /**
   * The collapsed view switcher, in `HostedToolbar.forms.switcher`, when the
   * surface authors more than one view; otherwise (one view, a pinned surface,
   * no active view) `null`. Render it when present: it is the only way to
   * change views — and lay the frame out for its absence too.
   */
  switcher: ReactNode;
  /** The create affordance (`DataViewProps.creators`) in its compact form, or
   *  `null` when the surface has none. */
  creators: ReactNode;
  /** The rows — the active view, or its loading / no-views state. */
  body: ReactNode;
  /**
   * The shell's header-measurement ref. A frame whose header STICKS (a
   * sidebar list's header line) attaches it to that sticky box, so the shell
   * publishes its height as `--dv-header-offset` and grouped views pin their
   * section headers below it rather than under it. A frame whose header
   * scrolls away with the rows (a card) leaves it unattached, and the offset
   * stays `0px`.
   */
  stickyRef: (node: HTMLElement | null) => void;
}

/**
 * The forms the host builds a hosted frame's parts in — {@link
 * ToolbarPartForms}' counterpart for {@link HostedToolbar}. Data, not
 * components: the host still builds the part, the frame only picks its shape.
 */
export interface HostedToolbarForms {
  /**
   * `chip` (default): the collapsed switcher as a pill-shaped chip — what a
   * frame whose header is a card title wants. `row`: a full-width row (the
   * view's icon in the lead column, its name, a chevron shown on hover and
   * while the menu is open) — for a list that is the whole surface, where the
   * switcher reads as the list's own heading line. Same menu either way.
   */
  switcher: "chip" | "row";
  /**
   * `revealed` (default): the options trigger is hover-revealed off the
   * DataView root, so a small card at rest shows only its rows. `visible`: the
   * trigger shows at rest — for a frame that places it among always-visible
   * buttons (a surface's own toolbar), where a hidden one reads as missing.
   */
  options?: "revealed" | "visible";
}

/**
 * A DataView with NO toolbar band: the surface draws its own frame (typically a
 * small card inside someone else's chrome) and places the parts the host hands
 * it. For small, fixed lists where a band of search/filter/sort would be mostly
 * empty chrome — the controls stay reachable through {@link
 * HostedToolbarParts.options}.
 *
 * Not a {@link ToolbarArrangement}: an arrangement lays out a band and must
 * render the switcher and search inline, and it is ignored by the compact fold.
 * A hosted surface has no band, so it has neither obligation and no fold.
 *
 * A hosted surface owns its own header, so `title` and `actions` are not
 * accepted alongside it (the frame renders its own).
 */
export interface HostedToolbar {
  kind: "hosted";
  frame: ComponentType<HostedToolbarParts>;
  /** The shape of each part the host builds; absent ⇒ `{ switcher: "chip",
   *  options: "revealed" }`. */
  forms?: HostedToolbarForms;
}

/**
 * The forms the host builds a sections surface's headers in — data, like
 * {@link HostedToolbarForms}: the host still builds every header.
 */
export interface SectionsToolbarForms {
  /**
   * `eyebrow` (default): the small muted caps label a sidebar names its runs
   * of rows with ("FAVORITES"). `group`: the quiet group-by heading — a
   * semibold value set in the `group` type role.
   */
  header: "eyebrow" | "group";
}

/**
 * A DataView with NO active instance: EVERY authored view instance renders,
 * stacked in config order, each under its own collapsible header — a sidebar's
 * "Favorites / Private / Scratch" as one surface. There is no switcher (every
 * view is on screen) and no band; each section header carries its own `+`
 * (the surface's `creators`, narrowed by `CreateOption.views`) and `⋯` (that
 * view's controls, its settings, and "Add section").
 *
 * Views read two extra host-injected keys off their config row in this mode:
 * `hideWhenEmpty` (the section is not rendered while its view has no rows —
 * and not while that is still unknown) and `description` (the header's
 * tooltip). A section's collapse is device-local, beside the view's expand map.
 *
 * `title` / `actions` / `pinnedView` are not accepted alongside it: there is no
 * band to hold the first two, and a pinned surface shows one instance by
 * definition.
 */
export interface SectionsToolbar {
  kind: "sections";
  /** The shape of each part the host builds; absent ⇒ `{ header: "eyebrow" }`. */
  forms?: SectionsToolbarForms;
}

/** `DataViewProps.toolbar`: a band layout, a host-drawn frame, or stacked
 *  sections. */
export type DataViewToolbarSpec =
  ToolbarArrangement | HostedToolbar | SectionsToolbar;

/** Narrow a toolbar spec to the hosted form. */
export function isHostedToolbar(
  spec: DataViewToolbarSpec | undefined,
): spec is HostedToolbar {
  return spec !== undefined && "kind" in spec && spec.kind === "hosted";
}

/** Narrow a toolbar spec to the sections form. */
export function isSectionsToolbar(
  spec: DataViewToolbarSpec | undefined,
): spec is SectionsToolbar {
  return spec !== undefined && "kind" in spec && spec.kind === "sections";
}
