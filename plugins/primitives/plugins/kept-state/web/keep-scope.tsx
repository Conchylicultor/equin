import { createContext, useContext, type ReactNode } from "react";
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
      {children}
    </KeepScopeContext.Provider>
  );
}

/** The keep-scope path the caller renders in, or `null` outside every scope. */
export function useKeepScope(): string | null {
  return useContext(KeepScopeContext);
}

/** Prefix of every pooled view-state id: `kept/<scope path>|<owner>`. */
export const VIEW_ID_PREFIX = "kept/";

/** The pooled id of `owner`'s view state under the scope `path`. */
export function viewEntryId(path: string, owner: string): string {
  return `${VIEW_ID_PREFIX}${path}|${owner}`;
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
  removeEntriesWhere("session", (id) => {
    if (!id.startsWith(VIEW_ID_PREFIX)) return false;
    const bar = id.indexOf("|");
    if (bar < 0) return false;
    return id.slice(VIEW_ID_PREFIX.length, bar).split("/").includes(segment);
  });
}
