import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";

/** One node raised into an origin, as the raiser holds it. */
export interface Raised {
  /** Replace what is rendered. */
  update(node: ReactNode): void;
  /** Unmount it. Idempotent. */
  remove(): void;
  /**
   * Settles once the node has committed in the origin's tree (its layout
   * effects ran) — what a host placing its DOM waits for before showing it.
   */
  readonly mounted: Promise<void>;
}

export interface RaiseOptions {
  /**
   * Runs once if the origin goes away (unmounts) while the node is still
   * raised — the raiser's own record of it (a dialog's promise, a toast in
   * the page's stack) must end with it. Never runs after `remove()`.
   */
  onGone?: () => void;
}

/**
 * Where content a caller hands to page chrome renders: in the caller's own
 * origin, under its contexts (transport, plugin registry, navigator, theme).
 */
export interface RenderOriginHandle {
  raise(node: ReactNode, opts?: RaiseOptions): Raised;
}

interface Entry {
  id: number;
  node: ReactNode;
  onGone: (() => void) | undefined;
  onCommitted: () => void;
}

/** One origin's raised entries — the page's, or one `<RenderOrigin>` mount's. */
class OriginStore implements RenderOriginHandle {
  private nextId = 1;
  private entries: readonly Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private alive = true;

  /** The `PluginScope` the origin was mounted in (null: the page's tree). */
  constructor(readonly scopeId: string | null) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): readonly Entry[] => this.entries;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private replace(id: number, next: ((e: Entry) => Entry) | null): void {
    const before = this.entries;
    this.entries =
      next === null
        ? before.filter((e) => e.id !== id)
        : before.map((e) => (e.id === id ? next(e) : e));
    if (this.entries.length !== before.length || next !== null) this.emit();
  }

  raise(node: ReactNode, opts?: RaiseOptions): Raised {
    const id = this.nextId++;
    let onCommitted!: () => void;
    const mounted = new Promise<void>((resolve) => {
      onCommitted = resolve;
    });
    let removed = false;
    const raised: Raised = {
      update: (next) => {
        if (!removed) this.replace(id, (e) => ({ ...e, node: next }));
      },
      remove: () => {
        if (removed) return;
        removed = true;
        this.replace(id, null);
      },
      mounted,
    };
    if (!this.alive) {
      // The origin is gone already: nothing will render it.
      removed = true;
      queueMicrotask(() => opts?.onGone?.());
      return raised;
    }
    this.entries = [
      ...this.entries,
      { id, node, onGone: opts?.onGone, onCommitted },
    ];
    this.emit();
    return raised;
  }

  /** Bumped by every `open` and `closeSoon`, so a pending close knows it was superseded. */
  private generation = 0;

  /** The origin mounted (again — StrictMode re-runs effects). */
  open(): void {
    this.generation++;
    this.alive = true;
  }

  /**
   * The origin unmounted: everything raised into it ends — decided a
   * microtask later, so StrictMode's destroy → create (one synchronous pass)
   * keeps what a child raised from its own mount effect.
   */
  closeSoon(): void {
    const generation = ++this.generation;
    queueMicrotask(() => {
      if (this.generation === generation) this.close();
    });
  }

  private close(): void {
    this.alive = false;
    const gone = this.entries;
    this.entries = [];
    this.emit();
    for (const e of gone) e.onGone?.();
  }
}

/** Renders an origin's raised entries, in raise order. */
function RaisedEntries({ store }: { store: OriginStore }): ReactNode {
  const entries = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  return entries.map((e) => (
    <RaisedEntry key={e.id} node={e.node} onCommitted={e.onCommitted} />
  ));
}

function RaisedEntry({
  node,
  onCommitted,
}: {
  node: ReactNode;
  onCommitted: () => void;
}): ReactNode {
  useLayoutEffect(() => onCommitted(), [onCommitted]);
  return node;
}

const OriginContext = createContext<OriginStore | null>(null);

/**
 * A subtree's own render origin: content its code raises (a toast's body, an
 * imperative dialog) renders HERE — after `children`, in this position of the
 * React tree — so it reads exactly the contexts the subtree reads, never the
 * page chrome's that shows it. Mount one wherever a subtree stands for
 * another world than the page around it (a `PluginScope`, an embedded tab
 * set); the nearest one wins.
 *
 * When it unmounts, everything raised into it is unmounted too, each raise's
 * `onGone` called.
 */
export function RenderOrigin({ children }: { children: ReactNode }): ReactNode {
  const scopeId = usePluginScopeId();
  // One store per scope: a scope that changes in place (another composition
  // at the same position) ends what was raised in the old one.
  const store = useMemo(() => new OriginStore(scopeId), [scopeId]);
  useEffect(() => {
    store.open();
    return () => store.closeSoon();
  }, [store]);
  return (
    <OriginContext.Provider value={store}>
      {children}
      <RaisedEntries store={store} />
    </OriginContext.Provider>
  );
}

// The page's own origin IS page-global: one host (`PageRenderOrigin`,
// Core.Root) renders what code outside every origin raises, as the toast and
// dialog hosts did. Never reachable from inside a PluginScope
// (`useRenderOrigin` throws there).
const pageStore = new OriginStore(null);

/**
 * The page's origin: renders what code outside every `<RenderOrigin>` raises,
 * mounted once at the app root (`Core.Root`) by this plugin. Content raised
 * before it mounts renders once it does.
 */
export function PageRenderOrigin(): ReactNode {
  return <RaisedEntries store={pageStore} />;
}

/**
 * The origin content this caller raises renders in: the nearest
 * `<RenderOrigin>`, else — outside every `PluginScope` — the page's.
 *
 * Inside a `PluginScope` the origin must be the scope's own: an origin from
 * outside the scope (the page's included) would render the caller's content
 * against the page's server, registry and navigator. So a scope with no
 * origin of its own throws here, naming it — never a silent fall-through.
 */
export function useRenderOrigin(): RenderOriginHandle {
  const scopeId = usePluginScopeId();
  const nearest = useContext(OriginContext);
  if (nearest !== null && nearest.scopeId === scopeId) return nearest;
  if (scopeId === null) return pageStore;
  throw new Error(
    `useRenderOrigin: rendered inside PluginScope "${scopeId}", which has no <RenderOrigin> of its own — content raised here would render against the page's server. Mount a <RenderOrigin> inside the scope.`,
  );
}
