import {
  onKeepScopeUnmount,
  stateMarkOf,
  type KeepScopeUnmount,
  type StateMark,
} from "@plugins/primitives/plugins/kept-state/web";
import { anyPopupOpen } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import {
  asFiber,
  committedFiber,
  componentName,
  componentSource,
  descendants,
  firstHostSource,
  holdsHooks,
  hooksOf,
  isChangedPropValue,
  ownerTrail,
  PerformedWork,
  Placement,
  refValueOf,
  stateQueueOf,
  type Fiber,
  type FiberRoot,
} from "./fiber";

/** One piece of React state a remount threw away. */
export interface StateLoss {
  /** The keep-scope path of the place that unmounted (`t:<tabId>`). */
  scope: string;
  /** The component holding the state. */
  component: string;
  /** Named components above it, outermost first. */
  owners: string[];
  /** Which `useState` / `useReducer` of the component, counting from 0. */
  stateIndex: number;
  /** `<file>:<line>` of the first element the component renders, when stamped. */
  source?: string;
  /** `Name@<file>:<line>` of the component owning that element, when stamped. */
  uiOwner?: string;
  /** What the value looked like (its type, and a short preview). */
  value: string;
}

/**
 * What the detector knows of every state hook seen: its baseline (what the
 * state was before the user touched it) and the value it last committed.
 * Keyed by the hook's update queue, the one object React keeps for a hook's
 * whole life (the hook objects themselves are cloned on each render).
 */
type Baselines = WeakMap<object, { baseline: unknown; last: unknown }>;

/**
 * The events a person makes something with: a key, a press, a click, typed or
 * pasted text, a drop — and a pointer moving with a button held (a drag).
 * Not hover, focus or scroll: what they set (a tooltip, a focus ring, a
 * scroll-driven measurement) is not something the user would miss.
 */
const USER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "keydown",
  "keyup",
  "beforeinput",
  "input",
  "change",
  "compositionend",
  "paste",
  "cut",
  "drop",
  "submit",
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
]);

/**
 * Whether `event` — the page's current event (`window.event`) at commit time —
 * is a user's. A discrete event's state updates commit while it is still being
 * dispatched: React flushes them in a microtask, and the browser runs a
 * listener's microtasks before it clears the current event. A change that
 * arrives any other way (a ResizeObserver measuring, a fetch answering, an
 * effect settling, a timer) commits with no current event. Exact, where a
 * time window after the input was not: a click's relayout re-measures within
 * a frame, and those measurements read as the user's.
 */
export function isUserEvent(event: Event | undefined): boolean {
  if (event === undefined) return false;
  if (event.type === "pointermove" || event.type === "mousemove")
    return (event as MouseEvent).buttons !== 0;
  return USER_EVENT_TYPES.has(event.type);
}

/**
 * Which commits carry what a user did: `(event)` is true for a commit made
 * while a user's event (`isUserEvent`) is being dispatched — unless it is a
 * **cascade**: a commit React makes synchronously inside a user commit's own
 * flush (a layout effect measuring the new layout — a bar re-fitting, a row
 * holding its widths for an animation — or a sync passive effect settling;
 * React re-renders those before `commitRoot` returns, so before the event
 * clears). The commit bridge is called inside that flush, so a user commit
 * opens the cascade window and a microtask closes it: every commit before the
 * microtask runs is the cascade, and the next listener's own commit (a
 * capture handler, then a bubble one; a native document listener) comes at a
 * later microtask checkpoint and is the user's again. A solo → docked layout
 * switch filed an adaptive bar's re-fit counter and a Miller row's animation
 * hold as losses before this.
 */
export function createCommitAttribution(): (
  event: Event | undefined,
) => boolean {
  let cascading = false;
  return (event) => {
    if (cascading || !isUserEvent(event)) return false;
    cascading = true;
    queueMicrotask(() => {
      cascading = false;
    });
    return true;
  };
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (err) {
    // A cyclic or BigInt-holding value has no JSON spelling: identity decides.
    if (err instanceof TypeError) return false;
    throw err;
  }
}

/**
 * Whether a state value can be something the user made or chose: not a DOM
 * node, a function, or an object holding one at its top level (a portal's
 * mount node, a positioning reference, an element measured into state) —
 * those are a component's wiring to the page, rebuilt by any mount.
 */
export function isUserData(value: unknown): boolean {
  if (typeof value === "function" || typeof value === "symbol") return false;
  if (typeof value !== "object" || value === null) return true;
  if (typeof Node !== "undefined" && value instanceof Node) return false;
  if (Array.isArray(value)) return value.every((v) => !isWiring(v));
  for (const [key, v] of Object.entries(value)) {
    if (key.startsWith("__react") || isWiring(v)) return false;
  }
  return true;
}

function isWiring(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof Node !== "undefined" && value instanceof Node)
  );
}

/** What a value looked like, short — the report names the state, not its data. */
export function previewValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value instanceof Set) return `Set(${value.size})`;
  if (value instanceof Map) return `Map(${value.size})`;
  switch (typeof value) {
    case "string":
      return `string(${value.length})`;
    case "number":
    case "boolean":
      return `${typeof value} ${String(value)}`;
    case "object": {
      const keys = Object.keys(value);
      const shown = keys.slice(0, 6).join(", ");
      return `object {${shown}${keys.length > 6 ? ", …" : ""}}`;
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return typeof value;
  }
  // tsc cannot see `typeof` as exhausted above; every case returns.
  throw new Error(`previewValue: unknown typeof ${typeof value}`);
}

/**
 * Record what one commit did to the state hooks it rendered: a fresh hook's
 * value is its baseline; a value this commit changed outside a user input
 * moves the baseline.
 * Walks only the subtrees that did work this commit (`subtreeFlags`), so its
 * cost follows React's own render, not the size of the tree.
 */
export function observeCommit(
  root: Fiber,
  baselines: Baselines,
  userInput: boolean,
): void {
  const stack: { fiber: Fiber; fresh: boolean }[] = [
    { fiber: root, fresh: false },
  ];
  while (stack.length > 0) {
    const { fiber, fresh: freshAbove } = stack.pop()!;
    const fresh = freshAbove || fiber.alternate === null;
    if (holdsHooks(fiber) && (fresh || fiber.flags & PerformedWork)) {
      for (const hook of hooksOf(fiber)) {
        const queue = stateQueueOf(hook);
        if (queue === null) continue;
        const value = hook.memoizedState;
        const known = baselines.get(queue);
        if (known === undefined) {
          baselines.set(queue, { baseline: value, last: value });
          continue;
        }
        // Only a change THIS commit made is attributed to this commit: a
        // component re-rendering for another reason does not absorb what the
        // user changed earlier.
        if (Object.is(known.last, value)) continue;
        known.last = value;
        // A state set to a prop the parent handed in anew this commit (React's
        // "adjust state when a prop changes" watermark: `prevItems` = `items`,
        // `prevId` = `id`) mirrors that prop, whatever event it rode in.
        if (!userInput || isChangedPropValue(fiber, value))
          known.baseline = value;
      }
    }
    for (let child = fiber.child; child !== null; child = child.sibling) {
      if (
        fresh ||
        (child.flags | child.subtreeFlags) & (PerformedWork | Placement)
      )
        stack.push({ fiber: child, fresh });
    }
  }
}

/**
 * Every state hook under `place` whose value differs from its baseline and
 * that is neither kept (`useKept` / `useDraft`) nor marked
 * `useTransient("<why>")`. A hook with no baseline (mounted before the
 * detector started) is not judged.
 */
export function collectLosses(
  place: Fiber,
  scope: string,
  baselines: Baselines,
): StateLoss[] {
  const losses: StateLoss[] = [];
  for (const fiber of descendants(place)) {
    if (!holdsHooks(fiber)) continue;
    // Only the repo's own components: a library's internal state (a popover
    // root's open flag) is not the repo's to keep, and reporting it would make
    // every report suspect. A component the repo wrote carries the build's
    // stamp; a library's never does.
    if (componentSource(fiber) === undefined) continue;
    let mark: StateMark | null = null;
    let stateIndex = -1;
    for (const hook of hooksOf(fiber)) {
      const queue = stateQueueOf(hook);
      if (queue === null) {
        mark = stateMarkOf(refValueOf(hook));
        continue;
      }
      stateIndex += 1;
      const marked = mark;
      mark = null;
      if (marked !== null) continue;
      const known = baselines.get(queue);
      if (known === undefined) continue;
      if (same(known.baseline, hook.memoizedState)) continue;
      if (!isUserData(hook.memoizedState)) continue;
      const { source, owner } = firstHostSource(fiber);
      losses.push({
        scope,
        component: componentName(fiber),
        owners: ownerTrail(fiber),
        stateIndex,
        ...(source !== undefined ? { source } : {}),
        ...(owner !== undefined ? { uiOwner: owner } : {}),
        value: previewValue(hook.memoizedState),
      });
    }
  }
  return losses;
}

/** The passive commit bridge index.html installs before React loads. */
interface CommitBridge {
  __commitSubscribers?: Set<(root: FiberRoot) => void>;
}

function commitBridge(): Set<(root: FiberRoot) => void> | null {
  const hook = (
    window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: CommitBridge }
  ).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  return hook?.__commitSubscribers ?? null;
}

/**
 * The dev unmount detector: watch every commit for the baselines of React
 * state, and when a page-level place (an outermost `KeepScope` — a tab's app,
 * the global action bar) unmounts without being closed, report each piece of
 * state the user changed that the remount throws away (`onLoss`, at most once
 * per component state per page). Returns the stop. Throws when the page has
 * no commit bridge (index.html's, installed before React) — the detector
 * cannot see a commit without it.
 */
export function watchStateLoss(onLoss: (loss: StateLoss) => void): () => void {
  const subscribers = commitBridge();
  if (subscribers === null)
    throw new Error(
      "watchStateLoss: no React commit bridge on this page (index.html installs __REACT_DEVTOOLS_GLOBAL_HOOK__.__commitSubscribers before React loads)",
    );
  const baselines: Baselines = new WeakMap();
  const seen = new Set<string>();
  const byUser = createCommitAttribution();
  const onCommit = (root: FiberRoot): void => {
    // `window.event`: the one read that says which event, if any, a commit
    // happens in (a listener is handed its own; a commit is not).
    observeCommit(root.current, baselines, byUser(window.event));
  };
  subscribers.add(onCommit);

  const onUnmount = (unmount: KeepScopeUnmount): void => {
    // A nested place (a pane inside a tab) goes with its outer one, or with a
    // navigation that replaced it — only a page-level place unmounting is a
    // remount the user comes back to. A closed place is gone for good.
    if (unmount.forgotten || unmount.path.includes("/")) return;
    // A remount with a popup open is one the reload policy never makes (it
    // waits while the user is engaged), and an open popup's flags and
    // position are transient by design: the place is not judged.
    if (anyPopupOpen()) return;
    const probe = asFiber(unmount.fiber);
    if (probe === null) return;
    for (const loss of collectLosses(
      committedFiber(probe),
      unmount.path,
      baselines,
    )) {
      const key = `${loss.component}#${loss.stateIndex}@${loss.source ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      onLoss(loss);
    }
  };
  const stopUnmounts = onKeepScopeUnmount(onUnmount);

  return () => {
    stopUnmounts();
    subscribers.delete(onCommit);
  };
}
