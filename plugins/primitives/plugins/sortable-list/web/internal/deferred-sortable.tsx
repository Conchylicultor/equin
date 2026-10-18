import {
  useCallback,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ItemBindingProvider,
  useItemBindingStore,
  type ItemBindingStore,
} from "@plugins/primitives/plugins/sortable-list/plugins/deferred-item/web";
import { SortableList, type SortableListProps } from "./sortable-list";

export type DeferredSortableHostProps = Omit<
  SortableListProps,
  "disabled" | "children"
>;

/**
 * The drag half of a deferred list: a plain `SortableList` whose children are
 * one invisible registrar per id, binding dnd-kit to the wrapper nodes the
 * `DeferredSortableItem`s of the enclosing `ItemBindingProvider` published.
 * Mount it as a SIBLING of those items, only while dragging is possible — it is
 * never their ancestor, so mounting or unmounting it remounts nothing.
 */
export function DeferredSortableHost({
  items,
  ...listProps
}: DeferredSortableHostProps): ReactNode {
  const store = useItemBindingStore();
  return (
    <SortableList items={items} {...listProps}>
      {items.map((id) => (
        <SortableRegistrar key={id} id={id} store={store} />
      ))}
    </SortableList>
  );
}

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
 * written as `DeferredSortableItem`.
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
 *
 * It is `ItemBindingProvider` + children + `enabled && DeferredSortableHost`. A
 * surface that renders the items without ever importing dnd-kit (reorder's
 * at-rest layout) composes those two halves itself.
 */
export function DeferredSortableList({
  enabled,
  items,
  children,
  ...listProps
}: DeferredSortableListProps): ReactNode {
  return (
    <ItemBindingProvider>
      {children}
      {enabled ? <DeferredSortableHost items={items} {...listProps} /> : null}
    </ItemBindingProvider>
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
  store: ItemBindingStore;
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
