import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { SortableList, type SortableListProps } from "./sortable-list";
import type { SortableItemState } from "./sortable-item";

/**
 * What a bound item's wrapper box wears while its list is enabled: the drag
 * listeners + a11y attributes dnd-kit hands a draggable, its displacement
 * transform, and whether it is the one being dragged.
 */
interface ItemDrag {
  wrapperProps: Record<string, unknown>;
  style: CSSProperties;
  isDragging: boolean;
}

/**
 * The meeting point between a deferred list's items (always mounted, cheap) and
 * its drag host (mounted only while enabled): each item publishes its wrapper
 * node by id, and the host's per-id registrar publishes back the drag props for
 * that node. Per id, so a frame of one row's drag re-renders that row alone.
 */
function createBindingStore() {
  const nodes = new Map<string, HTMLElement>();
  const drags = new Map<string, ItemDrag>();
  const subs = new Map<string, Set<() => void>>();
  const notify = (id: string) => {
    for (const cb of subs.get(id) ?? []) cb();
  };
  return {
    subscribe(id: string, cb: () => void): () => void {
      let set = subs.get(id);
      if (!set) subs.set(id, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) subs.delete(id);
      };
    },
    node: (id: string): HTMLElement | null => nodes.get(id) ?? null,
    drag: (id: string): ItemDrag | null => drags.get(id) ?? null,
    setNode(id: string, el: HTMLElement | null) {
      if ((nodes.get(id) ?? null) === el) return;
      if (el) nodes.set(id, el);
      else nodes.delete(id);
      notify(id);
    },
    setDrag(id: string, next: ItemDrag | null) {
      const prev = drags.get(id) ?? null;
      if (sameDrag(prev, next)) return;
      if (next) drags.set(id, next);
      else drags.delete(id);
      notify(id);
    },
  };
}

type BindingStore = ReturnType<typeof createBindingStore>;

function sameDrag(a: ItemDrag | null, b: ItemDrag | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.isDragging !== b.isDragging) return false;
  if (a.style.transform !== b.style.transform) return false;
  if (a.style.transition !== b.style.transition) return false;
  const ak = Object.keys(a.wrapperProps);
  if (ak.length !== Object.keys(b.wrapperProps).length) return false;
  return ak.every((k) => a.wrapperProps[k] === b.wrapperProps[k]);
}

const BindingContext = createContext<BindingStore | null>(null);

export interface DeferredSortableListProps extends Omit<
  SortableListProps,
  "disabled"
> {
  /**
   * Whether the list can be dragged right now. While `false` NO drag machinery
   * is mounted — no `DndContext`, no per-item `useSortable` — and flipping it
   * never remounts the items: they are not below the drag host, they are its
   * siblings.
   */
  enabled: boolean;
}

/**
 * A sortable list for surfaces that are draggable only in a mode — reorder's
 * edit mode — and plain the rest of the time. Same contract as
 * {@link SortableList} (which it mounts, as is, while `enabled`), with items
 * written as {@link DeferredSortableItem}.
 *
 * Why it exists: `SortableList` wraps its items in a `DndContext`, and each
 * `SortableItem` runs dnd-kit's `useSortable` (~50 hooks), whether or not
 * dragging is possible. Mounting the context only while enabled would put an
 * ancestor in front of the items when the mode flips, and React remounts every
 * subtree whose ancestor changes type — every contribution of every slot, on
 * every edit-mode toggle. So the drag host is a SIBLING of the items instead:
 * mounted only while enabled, it runs one `useSortable` per id against the
 * wrapper node the item published, and publishes the drag props back for the
 * item to wear. The items' own element chain never changes.
 */
export function DeferredSortableList({
  enabled,
  items,
  children,
  ...listProps
}: DeferredSortableListProps): ReactNode {
  const [store] = useState(createBindingStore);
  return (
    <BindingContext.Provider value={store}>
      {children}
      {enabled ? (
        <SortableList items={items} {...listProps}>
          {items.map((id) => (
            <SortableRegistrar key={id} id={id} store={store} />
          ))}
        </SortableList>
      ) : null}
    </BindingContext.Provider>
  );
}

/**
 * One id's draggable registration, inside the enabled host: binds dnd-kit's
 * draggable + droppable to the node the item published, and hands the drag
 * props back through the store. Renders nothing.
 */
function SortableRegistrar({
  id,
  store,
}: {
  id: string;
  store: BindingStore;
}): null {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const node = useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribe(id, cb), [store, id]),
    () => store.node(id),
  );
  useLayoutEffect(() => {
    setNodeRef(node);
  }, [node, setNodeRef]);
  useLayoutEffect(() => {
    store.setDrag(id, {
      wrapperProps: listeners ? { ...attributes, ...listeners } : {},
      style: { transform: CSS.Translate.toString(transform), transition },
      isDragging,
    });
  });
  useLayoutEffect(() => () => store.setDrag(id, null), [store, id]);
  return null;
}

export interface DeferredSortableItemProps {
  id: string;
  className?: string | ((state: SortableItemState) => string);
  children: (state: SortableItemState) => ReactNode;
}

/**
 * An item of a {@link DeferredSortableList}: one wrapper `div` that is the
 * drag source and drop target while the list is enabled, and a plain box (no
 * listeners, no transform) while it is not. Throws outside a deferred list —
 * an item no host can ever bind is a silent no-op drag otherwise.
 */
export function DeferredSortableItem({
  id,
  className,
  children,
}: DeferredSortableItemProps): ReactNode {
  const store = useContext(BindingContext);
  if (store === null)
    throw new Error(
      `DeferredSortableItem "${id}" rendered outside a DeferredSortableList`,
    );
  const drag = useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribe(id, cb), [store, id]),
    () => store.drag(id),
  );
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      store.setNode(id, el);
    },
    [store, id],
  );
  const state: SortableItemState = { isDragging: drag?.isDragging ?? false };
  return (
    <div
      ref={ref}
      style={drag?.style}
      className={typeof className === "function" ? className(state) : className}
      {...drag?.wrapperProps}
    >
      {children(state)}
    </div>
  );
}
