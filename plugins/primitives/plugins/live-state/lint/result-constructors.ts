/**
 * THE sanctioned ways to obtain or derive a resource result, one row each.
 * `no-handrolled-result` builds its error message from this table and derives
 * the plugins that own the shape (and so may spell it) from the rows' `from`
 * barrels, so a new clean form is one row here and the message names it at
 * once. `result-constructors.test.ts` checks every row's `name` is really
 * exported, as a value, from its `from` barrel.
 */
export interface ResultConstructor {
  /** The exported function. */
  name: string;
  /** The barrel it is imported from: `@plugins/<path>/web`. */
  from: `@plugins/${string}/web`;
  /** When to reach for it, in one line. */
  use: string;
}

export const RESULT_CONSTRUCTORS: readonly ResultConstructor[] = [
  // Reading.
  {
    name: "useLive",
    from: "@plugins/network/plugins/live/web",
    use: "read a liveCollection window / grouping / id set, or a liveValue",
  },
  {
    name: "useLiveRow",
    from: "@plugins/network/plugins/live/web",
    use: "read one row of a liveCollection by id (found / absent)",
  },
  {
    name: "useResource",
    from: "@plugins/primitives/plugins/live-state/web",
    use: "read a legacy resource descriptor (tree / revision-tick / config resources)",
  },
  {
    name: "useQueryResource",
    from: "@plugins/primitives/plugins/live-state/web",
    use: "wrap a local async load (a code-split module — never a server read) — never return the raw UseQueryResult",
  },
  {
    name: "useOptimisticResource",
    from: "@plugins/primitives/plugins/optimistic-mutation/web",
    use: "read a resource that pending local edits are replayed onto",
  },
  // Deriving.
  {
    name: "mapResource",
    from: "@plugins/primitives/plugins/live-state/web",
    use: "derive from one read, every arm kept",
  },
  {
    name: "mapRow",
    from: "@plugins/network/plugins/live/web",
    use: "reduce a useLiveRow read to a ResourceResult of what the row means",
  },
  {
    name: "combineResources",
    from: "@plugins/primitives/plugins/live-state/web",
    use: "combine several reads, all-or-nothing (useCombinedResources in a component)",
  },
  {
    name: "useCombinedResources",
    from: "@plugins/primitives/plugins/live-state/web",
    use: "combineResources with a render-stable identity",
  },
  {
    name: "foldResource",
    from: "@plugins/primitives/plugins/live-state/web",
    use: "reduce a read to a plain value, naming what every state yields",
  },
];

/**
 * The plugins that own the result shape — every `from` barrel's plugin, as the
 * path fragment a filename contains (`/plugins/network/plugins/live/`).
 */
export const RESULT_OWNERS: readonly string[] = [
  ...new Set(
    RESULT_CONSTRUCTORS.map(
      (c) => `/plugins/${c.from.slice("@plugins/".length, -"/web".length)}/`,
    ),
  ),
];

/** The rule's guidance, one line per constructor. */
export function resultConstructorsMessage(): string {
  return RESULT_CONSTRUCTORS.map(
    (c) => `\`${c.name}\` (${c.from}) — ${c.use}`,
  ).join("; ");
}
