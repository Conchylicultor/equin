import { Component, createContext, useContext, type ReactNode } from "react";
import { removeEntriesWhere } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

/**
 * Where view state belongs: the path of nested places the calling component
 * renders in — a tab (`t:<tabId>`), then a pane instance in it
 * (`t:<tabId>/p:<uuid>`). Both survive a reload (the tabs store keeps tab ids
 * and pane uuids), so view state keyed by the path comes back with its place.
 * `null` outside every `KeepScope` (an exhibit, a test): there is no place to
 * key on, so view state there is transient.
 */
const KeepScopeContext = createContext<string | null>(null);

/** One segment of a keep-scope path: `[a-z]+:` then an id with no `/` or `|`. */
const SEGMENT = /^[a-z]+:[^/|]+$/;

/**
 * Open a place view state is kept under, nested in the enclosing one. The pane
 * primitive opens one per pane instance (`p:<uuid>`), tab-surface one per tab
 * (`t:<tabId>`). `segment` must be stable across a reload — it is the key.
 */
export function KeepScope({
  segment,
  children,
}: {
  segment: string;
  children: ReactNode;
}) {
  if (!SEGMENT.test(segment))
    throw new Error(
      `KeepScope: segment "${segment}" must match ${SEGMENT} (kind:id, no "/" or "|")`,
    );
  const parent = useContext(KeepScopeContext);
  const path = parent === null ? segment : `${parent}/${segment}`;
  return (
    <KeepScopeContext.Provider value={path}>
      <KeepScopeProbe path={path}>{children}</KeepScopeProbe>
    </KeepScopeContext.Provider>
  );
}

/**
 * One place unmounting: its keep-scope path, and the React fiber of the probe
 * around its content (React internals — read only by the dev unmount detector,
 * `loss-detector`, which walks the subtree's hooks before React detaches it).
 */
export interface KeepScopeUnmount {
  readonly path: string;
  /** Whether the place was forgotten (closed for good) before it unmounted. */
  readonly forgotten: boolean;
  readonly fiber: unknown;
}

type UnmountListener = (unmount: KeepScopeUnmount) => void;

const unmountListeners = new Set<UnmountListener>();

/**
 * Call `listener` as each KeepScope unmounts, before React detaches its
 * subtree (so its hooks can still be read). Returns the unsubscribe.
 */
export function onKeepScopeUnmount(listener: UnmountListener): () => void {
  unmountListeners.add(listener);
  return () => {
    unmountListeners.delete(listener);
  };
}

/**
 * A class component only for its `componentWillUnmount`: React calls it on a
 * deleted subtree parent-first, while the subtree's fibers (and their hook
 * lists) are still linked — the one moment state about to be lost is visible.
 * Renders its children as they are; costs nothing while nobody listens.
 */
class KeepScopeProbe extends Component<{ path: string; children: ReactNode }> {
  override componentWillUnmount(): void {
    if (unmountListeners.size === 0) return;
    const { path } = this.props;
    const unmount: KeepScopeUnmount = {
      path,
      forgotten: path.split("/").some((segment) => forgotten.has(segment)),
      fiber: (this as unknown as { _reactInternals?: unknown })._reactInternals,
    };
    for (const listener of unmountListeners) listener(unmount);
  }

  override render(): ReactNode {
    return this.props.children;
  }
}

// The places forgotten (closed for good) lately, newest last: an unmount that
// follows a close is the end of the place, not a loss. Bounded — a close is
// followed by its unmount within the same commit.
const FORGOTTEN_MAX = 64;
const forgotten = new Set<string>();

/**
 * Render `children` in the place `path` names — a path captured elsewhere with
 * {@link useKeepScope} (`null`: no place). For state raised away from where it
 * belongs (a playback instance hosted at the page's render origin, outliving
 * its tab's view): it keeps its view state under its own place, so a reload
 * still gives it back, and closing that place still forgets it.
 */
export function KeepScopeAt({
  path,
  children,
}: {
  path: string | null;
  children: ReactNode;
}) {
  return (
    <KeepScopeContext.Provider value={path}>
      {children}
    </KeepScopeContext.Provider>
  );
}

/** The keep-scope path the caller renders in, or `null` outside every scope. */
export function useKeepScope(): string | null {
  return useContext(KeepScopeContext);
}

/**
 * Prefix of every pooled view-state id: `kept/<scope path>|<owner>`, or
 * `kept/<scope path>|<owner>#<key>` for one keyed instance of the owner.
 */
export const VIEW_ID_PREFIX = "kept/";

/**
 * The pooled id of `owner`'s view state under the scope `path` — of its
 * instance `key` when the owner has several in one place.
 */
export function viewEntryId(path: string, owner: string, key?: string): string {
  const base = `${VIEW_ID_PREFIX}${path}|${owner}`;
  return key === undefined ? base : `${base}#${key}`;
}

/**
 * Drop the view state of a place that is gone for good — a pane instance
 * closed (`p:<uuid>`), a tab closed (`t:<tabId>`) — and of every place nested
 * in it, in every composition scope. Not for an unmount: a hidden tab or a
 * pane scrolled out of a Miller chain comes back and reads its state again.
 * The view pool's TTL is only the backstop for places that end without a
 * close (a pane replaced in place).
 */
export function forgetKeepScope(segment: string): void {
  forgotten.delete(segment);
  forgotten.add(segment);
  if (forgotten.size > FORGOTTEN_MAX) {
    const oldest = forgotten.values().next();
    if (!oldest.done) forgotten.delete(oldest.value);
  }
  removeEntriesWhere("session", (id) => {
    if (!id.startsWith(VIEW_ID_PREFIX)) return false;
    const bar = id.indexOf("|");
    if (bar < 0) return false;
    return id.slice(VIEW_ID_PREFIX.length, bar).split("/").includes(segment);
  });
}
