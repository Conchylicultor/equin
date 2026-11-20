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
   * The kind's debug name — its identity in the build's contributor table
   * (`contributors.generated.ts`), and what a process starting only some
   * plugins names a list it reads by.
   */
  readonly debugName: string;
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
   * The contributions of the plugins THIS process started — in a process that
   * started only some (`declarePartialStart`), only theirs, with no list-rule
   * check. Never an answer about the whole list: only for a reader whose
   * question is "what do my own started plugins declare?" (a job verifying
   * that the database holds the objects its own code declares). Everywhere
   * else, `getContributions()`.
   */
  startedContributions(): Collected<P>[];
  /**
   * The contributions of this kind declared by `plugins` (loaded plugin
   * definitions), matched on this token's own kind. Pure: reads no boot state,
   * so a process that imports the barrels without booting gets the same set.
   */
  from(
    plugins: readonly { contributions?: readonly ServerContribution[] }[],
  ): P[];
}

/**
 * A contribution kind a process may run without some of its contributors (see
 * `defineServerContribution`): why each entry only matters to the plugin that
 * contributed it, so a process that did not start that plugin is right not to
 * have it.
 */
export interface PartialList {
  reason: string;
}

/**
 * What a contribution to a kind opened with `companions: true` may add:
 * `companion: true` makes it ship wherever the kind's declaring plugin ships
 * (the closure engine's companion edge, owner → contributor). Only such a kind
 * accepts it — on any other the field is an excess property, so a plugin
 * cannot make itself a companion of an owner that never asked for one. The
 * server twin of web-sdk's `CompanionFlag`.
 */
export interface ServerCompanionFlag {
  companion?: true;
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
 *
 * `partial` declares that a host which does not boot a contributor of
 * this kind still answers everything it serves correctly — the kind is its
 * contributor's own reaction or bookkeeping, never part of an answer (a
 * `Trigger` is the contributor reacting to an event: a host without it does
 * not react). Read statically by the browser-host coverage guard
 * (`codegen/core/browser-host-coverage.ts`, its contributions arm): a kind
 * WITHOUT it, declared by a plugin a browser host boots, must have every
 * contributor its scoped page renders booted too — else the host would answer
 * without the contribution (a task list without a category's label, a list
 * without an exposed column). The reason is required: it is the claim the
 * guard takes on trust.
 *
 * `companions: true` opens the kind to COMPANIONS: a contribution passing
 * `companion: true` ships wherever the declaring plugin ships — a hard owner →
 * contributor edge in the closure engine (`plugin-meta/closure`), for what the
 * owner needs at runtime and cannot import (the import would be a cycle):
 * change-feed's `ChangelogRetention` — the changelog it writes grows forever
 * unless something prunes it, and the pruner (live-state-snapshot) imports
 * change-feed. Both flags are read STATICALLY — the kind's `companions: true`
 * from this call (an inline literal, the token bound to a `const`), the
 * contribution's `companion: true` from the inline `contributions: [ … ]`
 * literal of the contributor's `server/index.ts` — so neither may be computed.
 * Unkeyed only: a server kind dispatches on no key space, so there is no
 * "required while used" form (the web's keyed companion slots).
 */
export function defineServerContribution<P>(
  debugName: string,
  opts: {
    docLabel?: (props: P) => string | undefined;
    partial?: PartialList;
    companions: true;
  },
): ServerContributionToken<P, P & ServerCompanionFlag>;
export function defineServerContribution<P>(
  debugName: string,
  opts?: {
    docLabel?: (props: P) => string | undefined;
    partial?: PartialList;
  },
): ServerContributionToken<P>;
export function defineServerContribution<P, I>(
  debugName: string,
  opts: {
    docLabel?: (props: P) => string | undefined;
    /** The payload a contributor's input declares. */
    project: (input: I) => P;
    partial?: PartialList;
    companions: true;
  },
): ServerContributionToken<P, I & ServerCompanionFlag>;
export function defineServerContribution<P, I>(
  debugName: string,
  opts: {
    docLabel?: (props: P) => string | undefined;
    /** The payload a contributor's input declares. */
    project: (input: I) => P;
    partial?: PartialList;
  },
): ServerContributionToken<P, I>;
export function defineServerContribution<P, I>(
  debugName: string,
  opts?: {
    docLabel?: (props: P) => string | undefined;
    project?: (input: I) => P;
    partial?: PartialList;
    companions?: true;
  },
): ServerContributionToken<P, I> {
  const kind = Symbol(debugName);
  const partial = opts?.partial !== undefined;
  if (opts?.companions === true) companionKinds.add(debugName);
  const project = opts?.project ?? ((input: I) => input as unknown as P);

  const token = ((input: I) => {
    const { input: payload, companion } = splitCompanion(
      debugName,
      opts?.companions === true,
      input,
    );
    const props = project(payload);
    return {
      _kind: kind,
      _doc: { label: opts?.docLabel?.(props) },
      ...props,
      ...(companion ? { companion: true } : {}),
    };
  }) as unknown as ServerContributionToken<P, I>;
  (token as { debugName: string }).debugName = debugName;

  token.getContributionsIfCollected = () => {
    if (byKind === null) return undefined;
    if (!partial) assertWholeList(debugName);
    return (byKind.get(kind) ?? []).map((c) => stripKind<Collected<P>>(c));
  };

  token.startedContributions = () => {
    if (byKind === null) {
      throw new Error(
        `[contributions] "${debugName}" read before collectContributions ran: this process never booted the plugin graph.`,
      );
    }
    return (byKind.get(kind) ?? []).map((c) => stripKind<Collected<P>>(c));
  };

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

/**
 * Separate a contribution's `companion` flag from its payload. A kind not
 * opened to companions refuses the field loudly — the type already rejects it,
 * so reaching here means a cast hid it, and a companion its owner never asked
 * for is no companion at all to the closure engine.
 */
function splitCompanion<I>(
  debugName: string,
  opened: boolean,
  input: I,
): { input: I; companion: boolean } {
  if (typeof input !== "object" || input === null || !("companion" in input))
    return { input, companion: false };
  const { companion, ...rest } = input as I & { companion: unknown };
  if (!opened)
    throw new Error(
      `[contributions] "${debugName}" is not opened to companions: a contribution to it cannot pass \`companion\`. ` +
        "Its declaring plugin opts in with `defineServerContribution(name, { companions: true })`.",
    );
  if (companion !== true)
    throw new Error(
      `[contributions] "${debugName}": \`companion\` must be the literal \`true\` (or absent), got ${String(companion)}.`,
    );
  return { input: rest as I, companion: true };
}

// ── A process that started only some plugins ─────────────────────────────────
//
// A job process starts the plugins its job needs, not the whole app
// (`resolveStartSet`, `startPartial`). A COMPLETE list (a kind without
// `partial`) read there is missing every entry of a contributor it did not
// start — silently, unless the read checks. It checks against the BUILD's
// table of contributors (`contributors.generated.ts`), never against a
// declaration, so a forgotten declaration is a loud failure, never a silent
// miss.

/** What a process that started only some plugins knows about what it left out. */
export interface PartialStart {
  /** What it started from, in words: `job database.fork (plugin database/plugins/fork)`. */
  readonly startedFrom: string;
  /** How many graph nodes it started, and how many its registry holds. */
  readonly started: number;
  readonly total: number;
  /**
   * The contributors of `kind` (a debug name) in this process's registry that
   * it did not start — empty when every one started.
   */
  missingContributors(kind: string): readonly string[];
  /** How a reader of `kind` makes it read whole: the fix the error names. */
  readonly fix: (kind: string) => string;
}

let partialStart: PartialStart | null = null;

// Every kind opened to companions this process defined (module eval): its
// owner is loaded, so it needs its companions at run time — what the closure
// engine's owner → companion edge ships. A partial start starts their
// contributors as if the work read the list whole.
const companionKinds = new Set<string>();

/** The debug names of the companion kinds this process's modules defined, sorted. */
export function definedCompanionKinds(): string[] {
  return [...companionKinds].sort();
}

/**
 * Declare that this process started only some plugins, before it collects.
 * Boot sequence only (`runExec`'s partial start); once per process.
 */
export function declarePartialStart(start: PartialStart): void {
  if (partialStart !== null) {
    throw new Error("[lists] this process's partial start was declared twice");
  }
  partialStart = start;
}

/** A complete list read in a process that did not start all its contributors. */
export class PartialListReadError extends Error {
  constructor(
    readonly kind: string,
    readonly missing: readonly string[],
    start: PartialStart,
  ) {
    const shown = missing.slice(0, 8).join(", ");
    super(
      `[lists] "${kind}" is a complete list, read in a process that started ${start.started} of ${start.total} parts.\n` +
        `Not started: ${missing.length} contributor${missing.length === 1 ? "" : "s"} (${shown}${missing.length > 8 ? ", …" : ""}).\n` +
        `Started from: ${start.startedFrom}.\n` +
        `Fix: ${start.fix(kind)}`,
    );
    this.name = "PartialListReadError";
  }
}

function assertWholeList(kind: string): void {
  if (partialStart === null) return;
  const missing = partialStart.missingContributors(kind);
  if (missing.length > 0)
    throw new PartialListReadError(kind, missing, partialStart);
}

/** Whether this process started only some plugins (`declarePartialStart`). */
export function isPartialStart(): boolean {
  return partialStart !== null;
}

/** Forget a declared partial start. Test support (`core/testing`). */
export function clearPartialStart(): void {
  partialStart = null;
}

// How many times what was collected has been deliberately forgotten
// (`clearCollectedContributions`) — so state proven against one collection can
// tell "replaced after a clear" (a fresh start) from "replaced over it".
let clears = 0;

/**
 * The current collection as an opaque identity (`collection`, null before any
 * collect) and the clear count it sits after: a new `collectContributions`
 * makes a different collection, a clear bumps `clears`, so state proven
 * against one collection (host services' boot assert) can tell it is stale,
 * and whether a clear came between.
 */
export function currentCollection(): {
  collection: object | null;
  clears: number;
} {
  return { collection: byKind, clears };
}

/** Forget what was collected — back to the pre-boot state. Test support (`core/testing`). */
export function clearCollectedContributions(): void {
  byKind = null;
  clears++;
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
