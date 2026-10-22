// Minimal private React fiber typings + constants. These are React internals
// (field names + WorkTag/flag values) — stable across React 18–19 and mirrored
// by React DevTools / bippy, but private. Centralized here with loose `any`
// where the real shape is irrelevant to us.

/** `PerformedWork` — set when a component runs its render fn (not on bailout). */
export const PerformedWork = 0b1;

/**
 * `Placement` — set when React actually inserts (or moves) this fiber in the
 * host tree this commit. THE authoritative "freshly mounted into the DOM"
 * signal: a brand-new fiber that React placed carries it; a fiber that merely
 * re-rendered (or persisted untouched) does not. Used alongside
 * `alternate === null` to tell a real mount/remount from a fiber that mounted
 * once and has since only ever bailed out — see `isFreshlyPlaced`.
 */
export const Placement = 0b10;

// WorkTag values (react-reconciler ReactWorkTags).
export const FunctionComponent = 0;
export const ClassComponent = 1;
export const HostRoot = 3;
export const HostComponent = 5;
export const HostText = 6;
export const Fragment = 7;
export const ForwardRef = 11;
export const MemoComponent = 14;
export const SimpleMemoComponent = 15;

export interface ContextItem {
  context: unknown;
  memoizedValue: unknown;
  next: ContextItem | null;
}

export interface Fiber {
  tag: number;
  // React internal: component fn/class/forwardRef/memo object
  type: any;
  key: string | null;
  /** React's authoritative per-parent reconciliation slot index. */
  index: number;
  flags: number;
  // React internal: hook linked-list node
  memoizedState: any;
  memoizedProps: any;
  dependencies: { firstContext: ContextItem | null } | null;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate: Fiber | null;
}

export interface FiberRoot {
  current: Fiber;
}

/** The passive commit bridge installed by index.html, before React loads. */
export interface ReactDevtoolsHook {
  __commitSubscribers?: Set<(root: FiberRoot) => void>;
  // the full hook has many fields we don't touch
  [key: string]: any;
}

/** The window index.html's commit bridge lives on (a cast, not a `Window` augmentation). */
export type DevtoolsWindow = Window & {
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsHook;
};
