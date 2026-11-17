// React fiber internals, as little of them as the detector reads. Private to
// React but stable across 18–19 (React DevTools reads the same fields); every
// read is defensive — a shape we do not know is skipped, never thrown on.

/** `PerformedWork`: the fiber ran its render this commit. */
export const PerformedWork = 0b1;
/** `Placement`: the fiber was inserted this commit (the root of a new subtree). */
export const Placement = 0b10;

// WorkTags (react-reconciler ReactWorkTags) of the fibers that hold hooks.
const FunctionComponent = 0;
const HostRoot = 3;
const HostComponent = 5;
const ForwardRef = 11;
const SimpleMemoComponent = 15;

export interface HookNode {
  memoizedState: unknown;
  queue: unknown;
  next: HookNode | null;
}

export interface Fiber {
  tag: number;
  type: unknown;
  flags: number;
  subtreeFlags: number;
  memoizedState: unknown;
  stateNode: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate: Fiber | null;
}

export interface FiberRoot {
  current: Fiber;
}

export function asFiber(value: unknown): Fiber | null {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { tag?: unknown }).tag === "number"
    ? (value as Fiber)
    : null;
}

/** A fiber whose `memoizedState` is a hook list. */
export function holdsHooks(fiber: Fiber): boolean {
  return (
    fiber.tag === FunctionComponent ||
    fiber.tag === ForwardRef ||
    fiber.tag === SimpleMemoComponent
  );
}

export function hooksOf(fiber: Fiber): HookNode[] {
  const out: HookNode[] = [];
  let hook = fiber.memoizedState as HookNode | null;
  // A hook list is a linked list of objects with `next`; anything else (a
  // class's state, a host's props) is not one.
  while (
    typeof hook === "object" &&
    hook !== null &&
    "next" in hook &&
    out.length < 500
  ) {
    out.push(hook);
    hook = hook.next;
  }
  return out;
}

/**
 * A `useState` / `useReducer` hook: its queue carries the reducer it last
 * rendered with. (`useSyncExternalStore`'s queue carries `getSnapshot`
 * instead; refs, memos and effects have no queue.)
 */
export function stateQueueOf(hook: HookNode): object | null {
  const queue = hook.queue;
  if (typeof queue !== "object" || queue === null) return null;
  if (!("lastRenderedReducer" in queue)) return null;
  if (typeof (queue as { getSnapshot?: unknown }).getSnapshot === "function")
    return null;
  return queue;
}

/** The value a `useRef` hook holds, or `undefined` for any other hook. */
export function refValueOf(hook: HookNode): unknown {
  if (hook.queue !== null) return undefined;
  const state = hook.memoizedState;
  if (typeof state !== "object" || state === null) return undefined;
  const keys = Object.keys(state);
  return keys.length === 1 && keys[0] === "current"
    ? (state as { current: unknown }).current
    : undefined;
}

/**
 * Of a fiber and its alternate, the one in the committed tree: the one whose
 * `return` chain reaches a HostRoot that is its root's current. (A class
 * instance keeps the fiber it was created with, which may be either.)
 */
export function committedFiber(fiber: Fiber): Fiber {
  for (const candidate of [fiber, fiber.alternate]) {
    if (candidate === null) continue;
    let node: Fiber = candidate;
    let steps = 0;
    while (node.return !== null && steps < 10_000) {
      node = node.return;
      steps += 1;
    }
    if (
      node.tag === HostRoot &&
      (node.stateNode as FiberRoot | null)?.current === node
    )
      return candidate;
  }
  return fiber;
}

/** Every fiber under `fiber` (itself excluded), depth first. */
export function* descendants(fiber: Fiber): Generator<Fiber> {
  let node = fiber.child;
  while (node !== null && node !== fiber) {
    yield node;
    if (node.child !== null) {
      node = node.child;
      continue;
    }
    while (node !== null && node !== fiber && node.sibling === null)
      node = node.return;
    if (node === null || node === fiber) return;
    node = node.sibling;
  }
}

/** A component's name as React DevTools would show it. */
export function componentName(fiber: Fiber): string {
  const type = fiber.type as
    | { displayName?: unknown; name?: unknown; render?: unknown }
    | null
    | undefined;
  if (typeof type === "function" || (typeof type === "object" && type)) {
    if (typeof type.displayName === "string" && type.displayName)
      return type.displayName;
    if (typeof type.name === "string" && type.name) return type.name;
    const render = type.render as { name?: unknown } | undefined;
    if (render && typeof render.name === "string" && render.name)
      return render.name;
  }
  return "Anonymous";
}

/**
 * The names of the nearest named components above `fiber`, outermost first —
 * where the component sits, for a reader (`TaskDetail › Prompt › LaunchOptions`).
 */
export function ownerTrail(fiber: Fiber, depth = 4): string[] {
  const names: string[] = [];
  let node = fiber.return;
  while (node !== null && names.length < depth) {
    if (holdsHooks(node) || node.tag === 1) {
      const name = componentName(node);
      if (name !== "Anonymous" && names[0] !== name) names.unshift(name);
    }
    node = node.return;
  }
  return names;
}

/**
 * The source line of the first DOM element the component renders — stamped
 * `data-source="<file>:<line>"` (and `data-ui-owner`) by element-picker's
 * build transform — which names the file the state is in.
 */
export function firstHostSource(fiber: Fiber): {
  source?: string;
  owner?: string;
} {
  for (const node of descendants(fiber)) {
    if (node.tag !== HostComponent) continue;
    const el = node.stateNode as Element | null;
    if (el === null || typeof el.getAttribute !== "function") continue;
    const source = el.getAttribute("data-source") ?? undefined;
    const owner = el.getAttribute("data-ui-owner") ?? undefined;
    if (source !== undefined || owner !== undefined) return { source, owner };
  }
  return {};
}
