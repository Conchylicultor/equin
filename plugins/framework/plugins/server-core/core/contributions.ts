export type ServerContribution = {
  readonly _kind: symbol;
  _pluginId?: string;
  _pluginDescription?: string;
  [key: string]: unknown;
};

type Collected<P> = P & { _pluginId?: string; _pluginDescription?: string };

/**
 * A contribution kind. `P` is the payload every read returns; `I` is what a
 * contributor passes — `P` itself, unless the token was defined with a
 * `project` that derives the payload from it (see `defineServerContribution`).
 */
export interface ServerContributionToken<P, I = P> {
  (input: I): ServerContribution;
  /**
   * Every contribution of this kind, as `collectContributions` gathered them at
   * boot. Throws in a process that never collected — a CLI or a headless test —
   * rather than answering `[]`, which a caller cannot tell apart from "no
   * plugin contributes one".
   */
  getContributions(): Collected<P>[];
  /**
   * `getContributions()` for the few readers that legitimately run in the
   * pre-collect window too (module-eval resolvers with their own eager
   * fallback): `undefined` when nothing has been collected yet — a state, not
   * an empty set.
   */
  getContributionsIfCollected(): Collected<P>[] | undefined;
  /**
   * The contributions of this kind declared by `plugins` (loaded plugin
   * definitions), matched on this token's own kind. Pure: reads no boot state,
   * so a process that imports the barrels without booting gets the same set.
   */
  from(
    plugins: readonly { contributions?: readonly ServerContribution[] }[],
  ): P[];
}

// `null` until `collectContributions` runs: "not collected" is its own state,
// never an empty map.
let byKind: Map<symbol, ServerContribution[]> | null = null;

function stripKind<P>({ _kind: _, ...rest }: ServerContribution): P {
  return rest as P;
}

/**
 * Define a contribution kind. The token is the whole kind — its call and every
 * read (`getContributions`, `getContributionsIfCollected`, `from`) come from
 * here, so never wrap a token to change what a contribution carries: a wrapper
 * has to re-attach each read by hand, and one it forgets still type-checks.
 * Pass `project` instead — the contributor then passes an `I`, and the kind
 * stores (and every read returns) `project(input)`: `Resource.Declare` takes a
 * whole `Resource` and keeps `{ key, mode, preload }`.
 */
export function defineServerContribution<P>(
  debugName: string,
  opts?: { docLabel?: (props: P) => string | undefined },
): ServerContributionToken<P>;
export function defineServerContribution<P, I>(
  debugName: string,
  opts: {
    docLabel?: (props: P) => string | undefined;
    /** The payload a contributor's input declares. */
    project: (input: I) => P;
  },
): ServerContributionToken<P, I>;
export function defineServerContribution<P, I>(
  debugName: string,
  opts?: {
    docLabel?: (props: P) => string | undefined;
    project?: (input: I) => P;
  },
): ServerContributionToken<P, I> {
  const kind = Symbol(debugName);
  const project = opts?.project ?? ((input: I) => input as unknown as P);

  const token = ((input: I) => {
    const props = project(input);
    return {
      _kind: kind,
      _doc: { label: opts?.docLabel?.(props) },
      ...props,
    };
  }) as unknown as ServerContributionToken<P, I>;

  token.getContributionsIfCollected = () =>
    byKind === null
      ? undefined
      : (byKind.get(kind) ?? []).map((c) => stripKind<Collected<P>>(c));

  token.getContributions = () => {
    if (byKind === null) {
      throw new Error(
        `[contributions] "${debugName}" read before collectContributions ran: this process never booted the plugin graph. ` +
          `Pass the set in explicitly, or gather it from the plugin definitions with ${debugName}.from(plugins).`,
      );
    }
    return token.getContributionsIfCollected()!;
  };

  token.from = (plugins) =>
    plugins
      .flatMap((p) => p.contributions ?? [])
      .filter((c) => c._kind === kind)
      .map((c) => stripKind<P>(c));

  return token;
}

/** Forget what was collected — back to the pre-boot state. Test support (`core/testing`). */
export function clearCollectedContributions(): void {
  byKind = null;
}

export function collectContributions(
  plugins: {
    id: string;
    description?: string;
    contributions?: ServerContribution[];
  }[],
): void {
  const collected = new Map<symbol, ServerContribution[]>();
  byKind = collected;
  for (const p of plugins) {
    for (const c of p.contributions ?? []) {
      c._pluginId = p.id;
      c._pluginDescription = p.description;
      let list = collected.get(c._kind);
      if (!list) {
        list = [];
        collected.set(c._kind, list);
      }
      list.push(c);
    }
  }
}
