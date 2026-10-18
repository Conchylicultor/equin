import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * What a bound item's wrapper box wears while a drag host is mounted beside it:
 * the drag listeners + a11y attributes dnd-kit hands a draggable, its
 * displacement transform, and whether it is the one being dragged.
 */
export interface ItemDrag {
  wrapperProps: Record<string, unknown>;
  style: CSSProperties;
  isDragging: boolean;
}

/** The state a {@link DeferredSortableItem} hands its render function. */
export interface DeferredItemState {
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

export type ItemBindingStore = ReturnType<typeof createBindingStore>;

function sameDrag(a: ItemDrag | null, b: ItemDrag | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.isDragging !== b.isDragging) return false;
  if (a.style.transform !== b.style.transform) return false;
  if (a.style.transition !== b.style.transition) return false;
  const ak = Object.keys(a.wrapperProps);
  if (ak.length !== Object.keys(b.wrapperProps).length) return false;
  return ak.every((k) => a.wrapperProps[k] === b.wrapperProps[k]);
}

const BindingContext = createContext<ItemBindingStore | null>(null);

/**
 * One deferred list's binding store, for the items below it and for the drag
 * host mounted (as their sibling) only while dragging is possible. Holds no
 * drag machinery itself.
 */
export function ItemBindingProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [store] = useState(createBindingStore);
  return (
    <BindingContext.Provider value={store}>{children}</BindingContext.Provider>
  );
}

/**
 * The enclosing list's binding store — what a drag host binds against. Throws
 * outside an {@link ItemBindingProvider}: a host with no items to bind is a
 * silent no-op drag otherwise.
 */
export function useItemBindingStore(): ItemBindingStore {
  const store = useContext(BindingContext);
  if (store === null)
    throw new Error(
      "A deferred sortable host rendered outside an ItemBindingProvider",
    );
  return store;
}

export interface DeferredSortableItemProps {
  id: string;
  className?: string | ((state: DeferredItemState) => string);
  children: (state: DeferredItemState) => ReactNode;
}

/**
 * An item of a deferred sortable list: one wrapper `div` that is the drag
 * source and drop target while a host is bound beside it, and a plain box (no
 * listeners, no transform) while none is. Throws outside a binding provider —
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
      `DeferredSortableItem "${id}" rendered outside a DeferredSortableList (an ItemBindingProvider)`,
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
  const state: DeferredItemState = { isDragging: drag?.isDragging ?? false };
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
