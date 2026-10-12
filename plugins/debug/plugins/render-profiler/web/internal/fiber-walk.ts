import {
  type Fiber,
  type FiberRoot,
  PerformedWork,
  Placement,
  FunctionComponent,
  ClassComponent,
  ForwardRef,
  SimpleMemoComponent,
  MemoComponent,
  HostComponent,
  Fragment,
} from "./react-types";

/** Cap on how many ancestor names we keep for disambiguation (nearest-last). */
const ANCESTOR_PATH_CAP = 6;

/** Cap on the recorded position map; on overflow we stop inserting and truncate. */
const POSITION_MAP_CAP = 20_000;

/**
 * Resolve a fiber's display name. Component-type fibers get their real name
 * (unwrapping forwardRef `.render` and memo `.type`); non-component fibers get
 * a tag label. Defensive property access — never throws on a weird shape.
 */
export function getComponentName(fiber: Fiber): string {
  const type = fiber.type;
  if (fiber.tag === ForwardRef) {
    const render = type?.render;
    return render?.displayName ?? render?.name ?? "ForwardRef";
  }
  if (fiber.tag === MemoComponent || fiber.tag === SimpleMemoComponent) {
    const inner = type?.type ?? type;
    return inner?.displayName ?? inner?.name ?? "Memo";
  }
  // A fragment's `type` is `Symbol(react.fragment)` — give it a real name so it
  // surfaces as `Fragment` (not `Unknown#7`) in element-type remount causes.
  if (fiber.tag === Fragment) return "Fragment";
  if (typeof type === "function" || typeof type === "object") {
    const name = type?.displayName ?? type?.name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  if (typeof type === "string") return type; // host element name (e.g. "div")
  return `Unknown#${fiber.tag}`;
}

/** True for fibers that run user component code (have hooks / can self-update). */
export function isComponentFiber(fiber: Fiber): boolean {
  switch (fiber.tag) {
    case FunctionComponent:
    case ClassComponent:
    case ForwardRef:
    case SimpleMemoComponent:
    case MemoComponent:
      return true;
    default:
      return false;
  }
}

/**
 * Did this component fiber actually run its render fn THIS commit?
 *
 * The `PerformedWork` flag alone is NOT sufficient and produces a false
 * positive on every stable subtree: React sets `PerformedWork` when the render
 * fn runs, but it does NOT clear it on a fiber whose subtree *bails out* (when
 * an ancestor short-circuits and no work-in-progress is built, the fiber is
 * never touched). So a fiber that rendered once at mount and has only ever been
 * skipped since keeps `PerformedWork` set in `flags` *forever* — and a full-tree
 * walk on every commit would re-report it as a fresh render. This is exactly the
 * `Core.Root` controller set (mount once, return null, never re-render): the old
 * flag-only test reported all ~20 of them as re-rendering on *every* commit
 * triggered by *any* unrelated component.
 *
 * The authoritative discriminator is **object identity across commits**. React
 * double-buffers fibers: a genuine render swaps `current` ↔ `alternate`, so the
 * committed fiber is a *different object* than the one at that position last
 * commit; a bailed/skipped fiber is the *same object* (with its stale flag).
 * `prevSeen` holds the component fibers visited last commit, so a fiber still
 * present there did not render this commit — regardless of its `PerformedWork`
 * flag. (A bail-out that *does* build a work-in-progress resets `flags` to none
 * via `createWorkInProgress`, so the flag check already excludes it; this guard
 * covers the no-work-in-progress skip that leaves the flag stale.)
 */
export function fiberRenderedThisCommit(
  fiber: Fiber,
  prevSeen: WeakSet<Fiber>,
): boolean {
  if (!isComponentFiber(fiber)) return false;
  if ((fiber.flags & PerformedWork) === 0) return false;
  return !prevSeen.has(fiber);
}

/**
 * True iff this fiber was *freshly inserted into the host tree this commit* — a
 * genuine mount/remount, as opposed to a fiber that re-rendered or persisted in
 * place.
 *
 * `alternate === null` alone is NOT sufficient and produces false positives: a
 * fiber mounts once via `mountChildFibers` (alternate null) and, if it then only
 * ever **bails out** (never re-renders — the common case for a `Core.Root`
 * controller or an idle subtree under a re-rendering ancestor), React never
 * creates a work-in-progress alternate for it, so it keeps `alternate === null`
 * *forever* while its DOM node and effects stay put. Treating that as a mount
 * reported every commit as a phantom remount of the whole stable subtree.
 *
 * React's `Placement` flag is the authoritative discriminator: it is set only
 * when the commit actually inserts (or moves) the fiber in the host tree. A
 * brand-new fiber (`alternate === null`) that also carries `Placement` was truly
 * mounted this commit; one without it is a stable, never-touched fiber. We keep
 * the `alternate === null` half too, so a reused-but-moved keyed fiber (which
 * carries `Placement` but has an alternate) is never mistaken for a mount.
 */
export function isFreshlyPlaced(fiber: Fiber): boolean {
  return fiber.alternate === null && (fiber.flags & Placement) !== 0;
}

interface StackEntry {
  fiber: Fiber;
  /** Whether any ancestor component fiber on THIS path rendered. */
  ancestorRendered: boolean;
  /** Component display names of ancestors on this path, nearest-last. */
  path: string[];
  /** Position key of the parent, so children build their own key on it. */
  parentPositionKey: string;
  /** Index in `initiators` of the initiator this subtree renders under, or -1. */
  initiator: number;
}

/** What a recorded position held last/this commit — its occupant identity. */
export interface PositionOccupant {
  name: string;
  key: string | null;
}

/** One initiator surfaced by the walk: the topmost rendered fiber on its path. */
export interface CommitInitiatorFiber {
  fiber: Fiber;
  ancestorPath: string[];
  /** True when the fiber freshly mounted this commit (`alternate === null`). */
  isMount: boolean;
  /**
   * Component fibers that rendered under this initiator this commit, itself
   * included — what its update cost, as opposed to how often it fires.
   */
  rendered: number;
}

/** One remount detected by diffing this commit's positions against the prev. */
export interface RemountDetection {
  positionKey: string;
  ancestorPath: string[];
  fromType: string;
  toType: string;
  cause: "element-type" | "key-change";
}

export interface CommitWalkResult {
  initiators: CommitInitiatorFiber[];
  /** Recorded occupants of positions inside rendered subtrees this commit. */
  currentPositions: Map<string, PositionOccupant>;
  remounts: RemountDetection[];
  /** True when `currentPositions` hit POSITION_MAP_CAP and stopped inserting. */
  truncated: boolean;
  /** Component fibers that rendered this commit, across every initiator. */
  rendered: number;
  /**
   * Every component fiber visited this commit, by object identity. Threaded back
   * in as `prevSeen` next commit so `fiberRenderedThisCommit` can tell a genuine
   * render (a freshly-swapped fiber object) from a stale `PerformedWork` flag on
   * a bailed/skipped fiber (the same object as last commit).
   */
  currentSeen: WeakSet<Fiber>;
}

/** A position is worth recording only for component / host-element / fragment fibers. */
function isRecordablePosition(fiber: Fiber): boolean {
  return (
    isComponentFiber(fiber) ||
    fiber.tag === HostComponent ||
    fiber.tag === Fragment
  );
}

/**
 * Does any CURRENT sibling of `fiber` carry `key`? Used to tell a reorder (the
 * prev occupant moved to another slot and is still alive) from a true destroy
 * (the prev occupant's key is gone entirely). Walks `fiber.return.child` on
 * demand — no extra map, no fiber retention; only called on the rare mount path
 * when the prev occupant was keyed, so the scan is cheap.
 */
function siblingHasKey(fiber: Fiber, key: string): boolean {
  let c = fiber.return?.child ?? null;
  while (c) {
    if (c.key === key) return true;
    c = c.sibling;
  }
  return false;
}

/**
 * Iterative DFS over the committed tree. Two jobs in one pass:
 *
 * 1. **Initiators.** A component fiber is an INITIATOR iff it rendered AND no
 *    ancestor component fiber rendered on its path — i.e. it is the topmost
 *    rendered fiber along that path, so its re-render came from its own
 *    state/context/subscription, not propagation. Once we pass through a rendered
 *    component fiber, deeper renders on that path are propagation (we mark
 *    `ancestorRendered` true for the subtree), but sibling subtrees keep their
 *    own per-path flag, so multiple independent updates in one commit surface.
 *    "Rendered" is `fiberRenderedThisCommit` — `PerformedWork` set AND a fiber
 *    object not seen last commit (`prevSeen`), so a stable subtree carrying a
 *    stale `PerformedWork` flag is NOT mistaken for a re-render (see that fn).
 *    Every component fiber visited is added to `currentSeen` for next commit.
 *
 * 2. **Remounts.** Every fiber gets a purely **index-based** `positionKey`
 *    (`parent + "/i:" + fiber.index`) — React's authoritative per-parent slot.
 *    Positions *inside a rendered subtree* are recorded (with the occupant's
 *    `key`). A **freshly-placed** fiber (`isFreshlyPlaced`: `alternate === null`
 *    AND React's `Placement` flag set) at a slot the *previous* commit also
 *    occupied is a candidate remount; we then decide remount-vs-benign-reorder
 *    by asking whether the prev occupant was actually destroyed: if it was keyed
 *    and that key still appears among the new fiber's current siblings, it merely
 *    moved (suppress); otherwise it was rebuilt (remount). Requiring `Placement`
 *    (not just `alternate === null`) is load-bearing: a fiber that mounted once
 *    and has since only ever bailed out keeps `alternate === null` forever, so
 *    the `alternate`-only test reported every stable idle subtree (e.g. the whole
 *    `Core.Root` controller set) as a phantom remount on each re-render. This now
 *    catches all real causes with zero false positives — an index-only key would
 *    flag a list prepend, a key-only key would miss identity-churning
 *    `key={uuid()}` remounts, and an alternate-only mount test would flag stable
 *    bailed-out fibers.
 */
export function collectCommit(
  root: FiberRoot,
  prevPositions: Map<string, PositionOccupant>,
  prevSeen: WeakSet<Fiber> = new WeakSet(),
): CommitWalkResult {
  const initiators: CommitInitiatorFiber[] = [];
  const currentPositions = new Map<string, PositionOccupant>();
  const remounts: RemountDetection[] = [];
  const currentSeen = new WeakSet<Fiber>();
  let truncated = false;
  let rendered = 0;

  const start = root?.current;
  if (!start) {
    return {
      initiators,
      currentPositions,
      remounts,
      truncated,
      rendered,
      currentSeen,
    };
  }

  // Explicit stack of per-path state — clearer and correct vs. return-pointer
  // bookkeeping for the "ancestor rendered" flag.
  const stack: StackEntry[] = [
    {
      fiber: start,
      ancestorRendered: false,
      path: [],
      parentPositionKey: "",
      initiator: -1,
    },
  ];

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    const { fiber, ancestorRendered, path, parentPositionKey } = entry;
    let childInitiator = entry.initiator;

    // Compute the position key for EVERY fiber so children can build on it.
    // Purely index-based (React's authoritative per-parent slot); the prev
    // occupant's key is stored separately for the reorder-vs-destroy decision.
    const positionKey = parentPositionKey + "/i:" + fiber.index;

    let childAncestorRendered = ancestorRendered;
    let childPath = path;

    if (isComponentFiber(fiber)) {
      // Record this fiber's object identity so next commit can recognize it as
      // persisted (not re-rendered) if it carries a stale PerformedWork flag.
      currentSeen.add(fiber);
      const name = getComponentName(fiber);
      if (fiberRenderedThisCommit(fiber, prevSeen)) {
        // First rendered component on this path is the initiator; deeper renders
        // are propagation. Either way, the subtree now has a rendered ancestor.
        if (!ancestorRendered) {
          childInitiator = initiators.length;
          initiators.push({
            fiber,
            ancestorPath: path.slice(-ANCESTOR_PATH_CAP),
            isMount: isFreshlyPlaced(fiber),
            rendered: 0,
          });
        }
        const owner = initiators[childInitiator];
        if (owner) owner.rendered += 1;
        rendered += 1;
        childAncestorRendered = true;
      }
      // Extend the ancestor path for descendants with this component's name.
      childPath = path.concat(name);
      if (childPath.length > ANCESTOR_PATH_CAP * 2) {
        childPath = childPath.slice(-ANCESTOR_PATH_CAP * 2);
      }
    }

    // Only nodes inside a rendered subtree can have been destroyed/rebuilt this
    // commit (a remount needs its parent to have re-rendered).
    if (childAncestorRendered && isRecordablePosition(fiber)) {
      const name = getComponentName(fiber);
      // Detect a remount BEFORE recording the new occupant. A remount needs a
      // genuinely-new fiber that React actually placed this commit — NOT merely
      // `alternate === null`, which a never-re-rendered (bailed-out) fiber also
      // satisfies indefinitely without any real mount. See `isFreshlyPlaced`.
      if (isFreshlyPlaced(fiber)) {
        const prev = prevPositions.get(positionKey);
        // prev absent ⇒ genuinely new slot (list growth / first render) — a real
        // mount, not a remount.
        if (
          prev &&
          // If the prev occupant was keyed and its key still appears among the
          // current siblings, it merely moved/shifted (reused elsewhere), not
          // destroyed — suppress. This is what makes a keyed list prepend report
          // zero remounts.
          !(prev.key != null && siblingHasKey(fiber, prev.key))
        ) {
          // The prev occupant at this slot was destroyed and rebuilt.
          remounts.push({
            positionKey,
            ancestorPath: path.slice(-ANCESTOR_PATH_CAP),
            fromType: prev.name,
            toType: name,
            // Different element type ⇒ element-type flip; same type ⇒ the
            // identity changed (key churn / unkeyed sibling replacement).
            cause: prev.name !== name ? "element-type" : "key-change",
          });
        }
      }
      if (currentPositions.size < POSITION_MAP_CAP) {
        currentPositions.set(positionKey, { name, key: fiber.key });
      } else {
        truncated = true;
      }
    }

    // Push children (left-to-right order is irrelevant for aggregation).
    let child = fiber.child;
    while (child) {
      stack.push({
        fiber: child,
        ancestorRendered: childAncestorRendered,
        path: childPath,
        parentPositionKey: positionKey,
        initiator: childInitiator,
      });
      child = child.sibling;
    }
  }

  return {
    initiators,
    currentPositions,
    remounts,
    truncated,
    rendered,
    currentSeen,
  };
}
