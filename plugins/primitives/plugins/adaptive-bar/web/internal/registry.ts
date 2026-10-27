import { createContext } from "react";
import type { PortalForwardedAttrs } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type {
  ActionForm,
  ShrinkLadder,
} from "@plugins/primitives/plugins/action-presentation/web";

/**
 * Everything the bar knows about one occupant, held OUTSIDE React state on
 * purpose.
 *
 * The bar's React state is the placement — the one thing a widget must
 * re-render to honour. Ladders, holds, popups and pointer locks are inputs to
 * the next decision, not outputs anyone renders, so routing them through
 * `useState` would re-render every occupant for a pointer-down that changes
 * nothing on screen.
 */
export interface BarItemEntry {
  readonly id: string;
  /** The item's one stable portal target, created once and owned for its whole life. */
  readonly container: HTMLDivElement;
  ladder: Required<ShrinkLadder>;
  /**
   * The inline rungs this item last DECLARED, as one comparable string — what
   * a rung index means for this item.
   *
   * Distinct from {@link BarItemEntry.ladder}, and it has to be: a declaration's
   * own release resets `ladder` to the default, and that release runs on every
   * FORM change, because the item's channel identity carries its assigned form.
   * So `ladder` cannot answer "did the ladder actually change?" — it reads as
   * changed every time the bar moves the item a rung.
   *
   * Anything invalidated by a ladder change (H2's bars, whose rung indices only
   * mean anything against one ladder) has to key on this instead. Keyed on
   * inline rungs alone rather than the whole ladder, because that is exactly
   * what a rung index names; `yields` changes the demotion ORDER, not what any
   * index means.
   */
  declaredRungs: string | null;
  /** Live `useHoldShrink` holds — what survives the pointer release (a fling's coast). */
  holds: number;
  /** A popover of this item's own is open, so its top-layer content must not move. */
  popupOpen: boolean;
  /** A pointer went down inside this item and has not come up. */
  pointerPinned: boolean;
  /**
   * This container holds an `<iframe>` and the browser cannot move it without
   * reloading it. Set once, reported once: the bar then refuses to relocate it
   * at all rather than silently destroying the frame's state.
   */
  immovable: boolean;
}

/**
 * The imperative half of the item↔bar channel: stable for the bar's whole life,
 * so an item's registration effects never re-run because the bar re-rendered.
 */
export interface BarRegistry {
  register(id: string, container: HTMLDivElement): () => void;
  declare(id: string, ladder: Required<ShrinkLadder>): () => void;
  hold(id: string): () => void;
  setPopupOpen(id: string, open: boolean): void;
  /**
   * This item's contribution started or stopped rendering anything.
   *
   * The shared `ResizeObserver` cannot carry this signal in both directions: an
   * occupant that renders nothing is `hidden` (so it costs no gap), and a
   * `display: none` element reports no resize when content appears inside it.
   * So the item watches its own container's child list and says so.
   */
  contentChanged(id: string): void;
  /**
   * Claim this bar's ONE yielding child, and throw if it is already taken.
   *
   * A yielding child is the row's give: it is excluded from the fit ledger and
   * is the only occupant allowed below its own content width, so it absorbs
   * whatever the measured occupants leave. Two of them share that leftover
   * arbitrarily — each ends up narrower than the row could have given it, both
   * ellipsize, and which one loses depends on their content rather than on
   * anything the author wrote. There is no honest answer, so there is no second
   * one: this throws rather than picking.
   *
   * The claim carries the cell's element because the claim IS the registration:
   * the bar holds back a floor for this cell out of the fit's budget
   * (`yieldFloorPx`), and that number is read off the element — its font size,
   * and whether it is rendering anything at all.
   */
  claimYield(cell: HTMLElement): () => void;
  /**
   * The yielding cell started or stopped rendering anything.
   *
   * An empty cell reserves no floor — there is no title to keep legible — so
   * this is the edge that changes the budget, and the same signal an occupant
   * sends through {@link BarRegistry.contentChanged} for the same reason: a
   * `display: none` element reports no resize when content appears inside it,
   * and the row's own width does not move when a title arrives.
   */
  yieldContentChanged(): void;
}

/** `null` — no bar above — is a legitimate state: `AdaptiveBar.Item` is then transparent. */
export const BarRegistryContext = createContext<BarRegistry | null>(null);

const NO_FORMS: ReadonlyMap<string, ActionForm> = new Map();

/**
 * The reactive half: the form each item was assigned on the last committed
 * pass. Separate from the registry because THIS is what must re-render the
 * occupants, and the registry is what must not.
 */
export const BarFormsContext =
  createContext<ReadonlyMap<string, ActionForm>>(NO_FORMS);

const NO_ATTRS: PortalForwardedAttrs = {};

/**
 * The region attributes (theme scope, pane id, lineage, …) of the BAR itself —
 * what its row inherits from the DOM, and what the bar stamps on its panel's
 * dock. An occupant stamps only the attributes where its own bag differs from
 * these: re-stamping the same `data-theme-scope` on its container would make
 * that container a fresh theme-scope root, which re-declares the inherited
 * defaults (`color: var(--foreground)`, `--hover-fill`, …) and so throws away
 * whatever the row set (a bar's muted `toolbar-foreground`).
 */
export const BarRegionAttrsContext =
  createContext<PortalForwardedAttrs>(NO_ATTRS);
