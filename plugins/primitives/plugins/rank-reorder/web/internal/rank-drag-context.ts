import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import { useDroppable, type DraggableSyntheticListeners } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/**
 * The kinds of dnd-kit node a `RankReorderProvider` mounts, carried as
 * `data.kind` so its collision detection can tell them apart:
 *
 * - `row` — a sortable row (`useRankSortableItem`);
 * - `group-drop` — a group's header or empty band, the "into this group"
 *   target of a row (`useRankGroupDropTarget`);
 * - `new-group` — the "into a new group" target (`useRankNewGroupTarget`);
 * - `group-sort` — a whole group as a sortable block (`useRankSortableGroup`).
 */
export type RankNodeKind = "row" | "group-drop" | "new-group" | "group-sort";

/** The `kind` a node's dnd-kit data carries (rows minted before kinds existed
 *  carry none, and are rows). */
export function nodeKind(
  data: Record<string, unknown> | undefined,
): RankNodeKind {
  return (data?.kind as RankNodeKind | undefined) ?? "row";
}

/** The dnd-kit id of one of a group's drop targets (a group may have two: its
 *  header and its empty band) — namespaced, so it can never be a row's id. */
const groupDropId = (group: string, instance: string): string =>
  `\u0000rank-group-drop:${group}:${instance}`;
/** The dnd-kit id of a sortable group block. */
export const groupSortId = (key: string): string =>
  `\u0000rank-group-sort:${key}`;
/** The dnd-kit id of the new-group target. */
export const NEW_GROUP_ID = "\u0000rank-new-group";

/**
 * What a provider tells the nodes under it, stable across the frames of a
 * drag (it changes only when a drag starts or ends):
 */
export interface RankDragState {
  /** What is being dragged: a row, a group block, or nothing. */
  activeKind: "row" | "group" | null;
  /** The provider takes a row into another group (`onReseat`). */
  reseat: boolean;
  /** The provider takes a row into a new group (`onReseatNew`). */
  reseatNew: boolean;
  /** Which groups take a row from another (`reseatInto`); every one when the
   *  provider names none. */
  reseatInto: ((group: string) => boolean) | null;
  /** A group block's measured box is its header's united with its body's: the
   *  header node maps to its body here, read by the provider's measure. */
  spans: WeakMap<Element, () => HTMLElement | null>;
  /** Registers a target laid over the rows (a group header / empty band, the
   *  new-group card) in the provider's sortable list; returns its removal.
   *  Over a node the list does not hold, dnd-kit's sortable stops displacing
   *  the drag source — the dragged row would drop back to its layout slot
   *  while the pointer is on the target. Listed, the row keeps following. */
  addTarget: (id: string) => () => void;
  /** Reports the new-group card's node (null once unmounted): the provider
   *  keeps its band out of the auto-scroll zone. */
  setNewGroupNode: (el: HTMLElement | null) => void;
}

const OUTSIDE: RankDragState = {
  activeKind: null,
  reseat: false,
  reseatNew: false,
  reseatInto: null,
  spans: new WeakMap(),
  addTarget: () => () => undefined,
  setNewGroupNode: () => undefined,
};

export const RankDragContext = createContext<RankDragState>(OUTSIDE);

/** The drag the nearest `RankReorderProvider` is running, and what it takes.
 *  Outside one: nothing is dragged and nothing is taken. */
export function useRankDragState(): {
  activeKind: "row" | "group" | null;
  canReseat: boolean;
  canReseatNew: boolean;
} {
  const { activeKind, reseat, reseatNew } = useContext(RankDragContext);
  return { activeKind, canReseat: reseat, canReseatNew: reseatNew };
}

/**
 * A group's "into this group" target — its header, or the band an empty
 * group draws — for a row dragged from another group: a drop on it reports
 * `onReseat(id, { group })` with no anchor. Enabled only under a provider
 * that takes reseats (and that takes rows into `group`), and while the host
 * says so (`enabled`): a group that draws rows is reached through them — its
 * header must not compete with its first row, or crossing the header would
 * throw the row to the group's head. `armed` while a row drag is in flight
 * there (the host may show the band's affordance), `isOver` while the pointer
 * is on it.
 *
 * `preview` (under `slideAcrossGroups`): the group DRAWS a row dragged onto
 * this target (an empty group's band) — the row is laid out at its head. Off
 * (a collapsed group's header, which draws no row), the row stays laid out
 * where it was and only the target lights.
 */
export function useRankGroupDropTarget(
  group: string,
  options: { enabled?: boolean; preview?: boolean } = {},
): {
  ref: (el: HTMLElement | null) => void;
  isOver: boolean;
  armed: boolean;
} {
  const { enabled = true, preview = false } = options;
  const {
    activeKind,
    reseat: takesAny,
    reseatInto,
    addTarget,
  } = useContext(RankDragContext);
  // A group the provider does not take rows into is no target at all: never
  // lit, never hit — the refusal is visible while the row is over it.
  const reseat = takesAny && (reseatInto === null || reseatInto(group));
  const live = reseat && enabled;
  const instance = useId();
  const id = groupDropId(group, instance);
  const data = useMemo(
    () => ({ kind: "group-drop" as const, group, preview }),
    [group, preview],
  );
  const { setNodeRef, isOver } = useDroppable({ id, data, disabled: !live });
  useEffect(() => (live ? addTarget(id) : undefined), [live, addTarget, id]);
  return {
    ref: setNodeRef,
    isOver: isOver && live,
    armed: live && activeKind === "row",
  };
}

/**
 * The "into a new group" target: a drop of a row on it reports
 * `onReseatNew(id)`. Mount it only while `useRankDragState()` says a row
 * drag is in flight under a provider with `onReseatNew`. Its band is no
 * auto-scroll zone: reaching it never scrolls the list away (the provider's
 * auto-scroll reads its node).
 */
export function useRankNewGroupTarget(): {
  ref: (el: HTMLElement | null) => void;
  isOver: boolean;
} {
  const { addTarget, setNewGroupNode } = useContext(RankDragContext);
  const { setNodeRef, isOver } = useDroppable({
    id: NEW_GROUP_ID,
    data: NEW_GROUP_DATA,
  });
  useEffect(() => addTarget(NEW_GROUP_ID), [addTarget]);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      setNodeRef(el);
      setNewGroupNode(el);
    },
    [setNodeRef, setNewGroupNode],
  );
  return { ref, isOver };
}

const NEW_GROUP_DATA = { kind: "new-group" as const };

export interface RankSortableGroupControls {
  /** On the group's HEADER: the drag source and the block's measured top. */
  ref: (el: HTMLElement | null) => void;
  /** On the group's BODY (a sibling of the header): the rest of the block,
   *  united with the header's box when the provider measures it. */
  bodyRef: (el: HTMLElement | null) => void;
  /** Spread on the header (the same element as `ref`). */
  listeners: DraggableSyntheticListeners;
  /** On BOTH the header and the body: the block slides as one. */
  style: CSSProperties;
  isDragging: boolean;
}

/**
 * A whole group as a sortable block, for a provider given `groups`: its
 * header drags it (the provider's 4px activation, so a click still reaches
 * the header) and the other sortable groups' blocks slide out of its way.
 * Header and body are two siblings — a wrapper box would re-bound a sticky
 * header — so the block is measured as their union (`bodyRef`) and the one
 * `style` goes on both. `sortable: false` (a group that does not move) mounts
 * a disabled node, which neither drags nor is a drop slot.
 */
export function useRankSortableGroup(
  key: string,
  sortable: boolean,
): RankSortableGroupControls {
  const { spans, activeKind } = useContext(RankDragContext);
  const data = useMemo(() => ({ kind: "group-sort" as const, key }), [key]);
  const { setNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: groupSortId(key), data, disabled: !sortable });
  const body = useRef<HTMLElement | null>(null);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      setNodeRef(el);
      if (el) spans.set(el, () => body.current);
    },
    [setNodeRef, spans],
  );
  const bodyRef = useCallback((el: HTMLElement | null) => {
    body.current = el;
  }, []);
  // A block slides only under a SECTION drag. Under a row drag the rows and
  // blocks share one sortable list, so dnd-kit would hand the blocks the
  // slide too — and a transformed block is a stacking context that seals the
  // dragged row inside it, under the next pinned header (z-layers CLAUDE.md,
  // "`z-drag`"). The rows' own slide is all a row drag moves.
  const slides = activeKind === "group";
  const style: CSSProperties = {
    transform: slides ? CSS.Translate.toString(transform) : undefined,
    transition: slides ? transition : undefined,
    // No `position`: the header is sticky (positioned already) and the body
    // a flex item of the sections' column, where z-index applies as is.
    // `drag`: the lifted block paints over the pinned headers and bodies of
    // the sections it passes (theirs are `raised` / level).
    ...(isDragging ? { zIndex: "var(--z-drag)" } : {}),
  };
  return {
    ref,
    bodyRef,
    listeners: sortable ? listeners : undefined,
    style,
    isDragging,
  };
}
