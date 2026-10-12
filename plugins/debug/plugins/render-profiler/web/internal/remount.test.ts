import { describe, expect, test } from "bun:test";
import {
  PerformedWork,
  Placement,
  FunctionComponent,
  HostComponent,
  Fragment as FragmentTag,
  type Fiber,
  type FiberRoot,
} from "./react-types";
import { collectCommit, type PositionOccupant } from "./fiber-walk";

// ---- Minimal fiber fabrication --------------------------------------------
//
// Plain objects matching the `Fiber` interface, with only the fields the walk
// reads. `rendered` sets the PerformedWork flag; `mounted` sets `alternate`
// (null = freshly mounted this commit, a truthy object = reused in place);
// `placed` sets React's `Placement` flag (the fiber was inserted/moved in the
// host tree this commit). A genuine mount carries both `alternate === null` and
// `Placement`, so `placed` defaults to `!mounted` — pass it explicitly to model
// the bail-out case (a never-re-rendered fiber: alternate null, NOT placed).

interface FiberSpec {
  tag: number;
  // test fixture mirrors React's loose `type`
  type: any;
  key?: string | null;
  index?: number;
  /** Component fiber that ran its render fn this commit (PerformedWork). */
  rendered?: boolean;
  /** false ⇒ freshly mounted (alternate === null); true ⇒ reused in place. */
  mounted?: boolean;
  /** Fiber inserted/moved in the host tree this commit (Placement). Defaults to `!mounted`. */
  placed?: boolean;
  children?: Fiber[];
}

function fib(spec: FiberSpec): Fiber {
  const placed = spec.placed ?? !spec.mounted;
  const fiber: Fiber = {
    tag: spec.tag,
    type: spec.type,
    key: spec.key ?? null,
    index: spec.index ?? 0,
    flags: (spec.rendered ? PerformedWork : 0) | (placed ? Placement : 0),
    memoizedState: null,
    memoizedProps: null,
    dependencies: null,
    child: null,
    sibling: null,
    return: null,
    // Reused fibers have a (truthy) alternate; freshly mounted ones do not.
    alternate: spec.mounted ? ({} as Fiber) : null,
  };
  // Wire children as a child/sibling chain with their parent return pointer.
  const kids = spec.children ?? [];
  let prev: Fiber | null = null;
  for (const kid of kids) {
    kid.return = fiber;
    if (prev === null) fiber.child = kid;
    else prev.sibling = kid;
    prev = kid;
  }
  return fiber;
}

function rootOf(top: Fiber): FiberRoot {
  return { current: top };
}

// A named function component "type" — getComponentName reads `.name`.
function comp(name: string) {
  const fn = function () {
    return null;
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

const A = comp("A");
const B = comp("B");
const X = comp("X");

/** Two-pass diff: walk prev to seed positions, then walk current against them. */
function diff(prevTop: Fiber, currTop: Fiber) {
  const pass1 = collectCommit(rootOf(prevTop), new Map(), new WeakSet());
  const prev: Map<string, PositionOccupant> = pass1.currentPositions;
  return collectCommit(rootOf(currTop), prev, pass1.currentSeen);
}

describe("remount detection", () => {
  test("cond ? <A/> : <B/> toggle ⇒ one element-type remount A→B", () => {
    // A rendered parent component holding a single unkeyed component child.
    const prev = fib({
      tag: FunctionComponent,
      type: comp("Parent"),
      rendered: true,
      mounted: true,
      children: [
        fib({ tag: FunctionComponent, type: A, index: 0, mounted: true }),
      ],
    });
    const curr = fib({
      tag: FunctionComponent,
      type: comp("Parent"),
      rendered: true,
      mounted: true,
      // B freshly mounts at the same unkeyed slot (index 0) — alternate null.
      children: [
        fib({ tag: FunctionComponent, type: B, index: 0, mounted: false }),
      ],
    });

    const { remounts } = diff(prev, curr);
    expect(remounts).toHaveLength(1);
    expect(remounts[0]).toMatchObject({
      fromType: "A",
      toType: "B",
      cause: "element-type",
    });
  });

  test("keyed list prepend [A,B] → [X,A,B] ⇒ ZERO remounts", () => {
    const prev = fib({
      tag: FunctionComponent,
      type: comp("List"),
      rendered: true,
      mounted: true,
      children: [
        fib({
          tag: FunctionComponent,
          type: A,
          key: "a",
          index: 0,
          mounted: true,
        }),
        fib({
          tag: FunctionComponent,
          type: B,
          key: "b",
          index: 1,
          mounted: true,
        }),
      ],
    });
    const curr = fib({
      tag: FunctionComponent,
      type: comp("List"),
      rendered: true,
      mounted: true,
      children: [
        // X is genuinely new (fresh key-slot) — a mount, not a remount.
        fib({
          tag: FunctionComponent,
          type: X,
          key: "x",
          index: 0,
          mounted: false,
        }),
        // A/B keep their key-slots and are reused in place (alternate present).
        fib({
          tag: FunctionComponent,
          type: A,
          key: "a",
          index: 1,
          mounted: true,
        }),
        fib({
          tag: FunctionComponent,
          type: B,
          key: "b",
          index: 2,
          mounted: true,
        }),
      ],
    });

    const { remounts } = diff(prev, curr);
    expect(remounts).toHaveLength(0);
  });

  test("<>{x}</> → <div>{x}</div> ⇒ remount Fragment→div", () => {
    const prev = fib({
      tag: FunctionComponent,
      type: comp("Wrap"),
      rendered: true,
      mounted: true,
      children: [
        fib({
          tag: FragmentTag,
          type: Symbol("react.fragment"),
          index: 0,
          mounted: true,
        }),
      ],
    });
    const curr = fib({
      tag: FunctionComponent,
      type: comp("Wrap"),
      rendered: true,
      mounted: true,
      children: [
        // The unkeyed slot 0 flips from a fragment to a host <div>, freshly mounted.
        fib({ tag: HostComponent, type: "div", index: 0, mounted: false }),
      ],
    });

    const { remounts } = diff(prev, curr);
    expect(remounts).toHaveLength(1);
    expect(remounts[0]).toMatchObject({
      fromType: "Fragment",
      toType: "div",
      cause: "element-type",
    });
  });

  test("[Foo(v1)] → [Foo(v2)] (key churn, old destroyed) ⇒ key-change remount", () => {
    // The classic `key={uuid()}` bug: same component, new key each commit. The
    // old key is gone from the current siblings, so the slot was truly rebuilt.
    const prev = fib({
      tag: FunctionComponent,
      type: comp("Keyed"),
      rendered: true,
      mounted: true,
      children: [
        fib({
          tag: FunctionComponent,
          type: A,
          key: "v1",
          index: 0,
          mounted: true,
        }),
      ],
    });
    const curr = fib({
      tag: FunctionComponent,
      type: comp("Keyed"),
      rendered: true,
      mounted: true,
      // Same component A, same slot (index 0), new key — freshly mounted, and v1
      // is NOT among current siblings (only v2 exists) ⇒ genuine destroy/rebuild.
      children: [
        fib({
          tag: FunctionComponent,
          type: A,
          key: "v2",
          index: 0,
          mounted: false,
        }),
      ],
    });

    const { remounts } = diff(prev, curr);
    expect(remounts).toHaveLength(1);
    expect(remounts[0]).toMatchObject({
      fromType: "A",
      toType: "A",
      cause: "key-change",
    });
  });

  test("bailed-out child (alternate null, NOT placed) ⇒ ZERO remounts", () => {
    // The Core.Root false-positive class: a child mounts once via
    // mountChildFibers (alternate === null) and then only ever bails out, so
    // React never builds it a work-in-progress alternate. It stays
    // `alternate === null` forever while its DOM/effects are untouched — NOT a
    // remount. The Placement flag is absent, which is how we tell it apart from
    // a genuine mount. (Modeled across two commits: same name+slot, alternate
    // null both times, never placed.)
    const prev = fib({
      tag: FunctionComponent,
      type: comp("Root"),
      rendered: true,
      mounted: true,
      children: [
        fib({
          tag: FunctionComponent,
          type: A,
          index: 0,
          mounted: false,
          placed: false,
          rendered: true,
        }),
      ],
    });
    const curr = fib({
      tag: FunctionComponent,
      type: comp("Root"),
      rendered: true,
      mounted: true,
      children: [
        fib({
          tag: FunctionComponent,
          type: A,
          index: 0,
          mounted: false,
          placed: false,
          rendered: true,
        }),
      ],
    });

    const { remounts } = diff(prev, curr);
    expect(remounts).toHaveLength(0);
  });

  test("bailed-out initiator (alternate null, NOT placed) ⇒ first sight is an update, not a mount", () => {
    // Same bail-out fiber as a top-level initiator. On the FIRST commit we
    // observe it (empty prevSeen) we have no history, so it reports — but as an
    // UPDATE (isMount false), never a phantom mount.
    const top = fib({
      tag: FunctionComponent,
      type: A,
      rendered: true,
      mounted: false,
      placed: false,
    });
    const { initiators } = collectCommit(rootOf(top), new Map(), new WeakSet());
    expect(initiators).toHaveLength(1);
    expect(initiators[0]?.isMount).toBe(false);
  });

  test("stale PerformedWork on a PERSISTED fiber ⇒ NOT re-reported after first commit", () => {
    // The Core.Root false-positive class at the initiator level. A controller
    // renders once at mount (PerformedWork set) and then only ever bails out, so
    // React keeps the SAME fiber object with the flag still set. The walk must
    // recognize the identical object (via prevSeen) as not-rendered-this-commit
    // — otherwise every commit triggered by ANY unrelated component re-reports
    // all ~20 stable controllers as phantom re-renders.
    const stale = fib({
      tag: FunctionComponent,
      type: A,
      rendered: true,
      mounted: false,
      placed: false,
    });
    // Same fiber OBJECT walked across two commits (React reuses it on bail-out).
    const pass1 = collectCommit(rootOf(stale), new Map(), new WeakSet());
    expect(pass1.initiators).toHaveLength(1); // first sight: no history, reported
    const pass2 = collectCommit(
      rootOf(stale),
      pass1.currentPositions,
      pass1.currentSeen,
    );
    expect(pass2.initiators).toHaveLength(0); // persisted object, stale flag: suppressed
  });

  test("genuine re-render (fiber object swaps each commit) ⇒ reported every commit", () => {
    // React double-buffers: a real re-render swaps current↔alternate, so the
    // committed fiber is a NEW object each commit. It must keep reporting even
    // though it was 'seen' (at a different object) last commit.
    const c1 = fib({
      tag: FunctionComponent,
      type: A,
      rendered: true,
      mounted: true,
    });
    const p1 = collectCommit(rootOf(c1), new Map(), new WeakSet());
    expect(p1.initiators).toHaveLength(1);
    const c2 = fib({
      tag: FunctionComponent,
      type: A,
      rendered: true,
      mounted: true,
    });
    const p2 = collectCommit(rootOf(c2), p1.currentPositions, p1.currentSeen);
    expect(p2.initiators).toHaveLength(1);
  });

  test("freshly-placed initiator (alternate null + Placement) ⇒ counted as mount", () => {
    const top = fib({
      tag: FunctionComponent,
      type: A,
      rendered: true,
      mounted: false, // placed defaults to true (a genuine mount)
    });
    const { initiators } = collectCommit(rootOf(top), new Map(), new WeakSet());
    expect(initiators).toHaveLength(1);
    expect(initiators[0]?.isMount).toBe(true);
  });

  test("keyed reorder [A,B] → [B,A] (all reused) ⇒ ZERO remounts", () => {
    const prev = fib({
      tag: FunctionComponent,
      type: comp("List"),
      rendered: true,
      mounted: true,
      children: [
        fib({
          tag: FunctionComponent,
          type: A,
          key: "a",
          index: 0,
          mounted: true,
        }),
        fib({
          tag: FunctionComponent,
          type: B,
          key: "b",
          index: 1,
          mounted: true,
        }),
      ],
    });
    const curr = fib({
      tag: FunctionComponent,
      type: comp("List"),
      rendered: true,
      mounted: true,
      // Both reused in place (alternate present) — a pure reorder, no mounts at all.
      children: [
        fib({
          tag: FunctionComponent,
          type: B,
          key: "b",
          index: 0,
          mounted: true,
        }),
        fib({
          tag: FunctionComponent,
          type: A,
          key: "a",
          index: 1,
          mounted: true,
        }),
      ],
    });

    const { remounts } = diff(prev, curr);
    expect(remounts).toHaveLength(0);
  });
});

describe("fibers rendered per initiator", () => {
  test("each initiator counts the component fibers rendered under it", () => {
    // Root (bailed) holds two independent updates: P re-renders with two
    // rendered children and one bailed child; Q re-renders alone.
    const tree = fib({
      tag: FunctionComponent,
      type: comp("Root"),
      mounted: true,
      children: [
        fib({
          tag: FunctionComponent,
          type: comp("P"),
          rendered: true,
          mounted: true,
          children: [
            fib({
              tag: FunctionComponent,
              type: A,
              rendered: true,
              mounted: true,
            }),
            fib({
              tag: HostComponent,
              type: "div",
              index: 1,
              mounted: true,
              children: [
                fib({
                  tag: FunctionComponent,
                  type: B,
                  rendered: true,
                  mounted: true,
                }),
              ],
            }),
            fib({ tag: FunctionComponent, type: X, index: 2, mounted: true }),
          ],
        }),
        fib({
          tag: FunctionComponent,
          type: comp("Q"),
          index: 1,
          rendered: true,
          mounted: true,
        }),
      ],
    });
    // No prior commit: every flagged fiber counts as rendered.
    const result = collectCommit(rootOf(tree), new Map(), new WeakSet());
    const by = Object.fromEntries(
      result.initiators.map((i) => [i.fiber.type.name, i.rendered]),
    );
    expect(by).toEqual({ P: 3, Q: 1 });
    expect(result.rendered).toBe(4);
  });
});
