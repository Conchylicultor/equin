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
 * What an entry of a DATA list may hold: what the build can write down as
 * JSON (`defineServerContribution(name, { data: true })`). A function, a class
 * instance (a drizzle table), a symbol or a value computed at run time has no
 * spelling here — `project` it to its data (a table to its name) first.
 */
export type ListData =
  | string
  | number
  | boolean
  | null
  | readonly ListData[]
  | { readonly [key: string]: ListData };

/**
 * One entry of a data list as the build wrote it down
 * (`list-entries.generated.ts`): the graph node whose barrel contributed it
 * (`<pluginPath>` or `<pluginPath>#machine`) and the entry itself.
 */
export interface WrittenListEntry {
  readonly node: string;
  readonly entry: unknown;
}

/** Every data list's entries, as the build wrote them: debug name → entries. */
export type WrittenListEntries = Readonly<
  Record<string, readonly WrittenListEntry[]>
>;

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

/** The key a data list's contribution carries (`{ data: true }`), read by the build. */
export const DATA_ENTRY = "_dataEntry";

function stripKind<P>({
  _kind: _,
  [DATA_ENTRY]: _data,
  ...rest
}: ServerContribution): P {
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
export function defineServerContribution<P extends ListData>(
  debugName: string,
  opts: {
    docLabel?: (props: P) => string | undefined;
    data: true;
  },
): ServerContributionToken<P>;
export function defineServerContribution<P extends ListData, I>(
  debugName: string,
  opts: {
    docLabel?: (props: P) => string | undefined;
    /** The payload a contributor's input declares — here, its data. */
    project: (input: I) => P;
    data: true;
  },
): ServerContributionToken<P, I>;
export function defineServerContribution<P, I>(
  debugName: string,
  opts?: {
    docLabel?: (props: P) => string | undefined;
    project?: (input: I) => P;
    partial?: PartialList;
    companions?: true;
    data?: true;
  },
): ServerContributionToken<P, I> {
  const kind = Symbol(debugName);
  const partial = opts?.partial !== undefined;
  const data = opts?.data === true;
  if (opts?.companions === true) companionKinds.add(debugName);
  if (data) {
    if (dataKinds.has(debugName))
      throw new Error(
        `[lists] data list "${debugName}" is defined twice: a list's debug name is its identity in the build's list entries.`,
      );
    dataKinds.set(debugName, kind);
  }
  const project = opts?.project ?? ((input: I) => input as unknown as P);

  const token = ((input: I) => {
    const { input: payload, companion } = splitCompanion(
      debugName,
      opts?.companions === true,
      input,
    );
    const props = project(payload);
    // A data list's entry is checked HERE, where the live value still is
    // what it is: the build evaluates every barrel, so an entry holding a
    // class instance, a function or a value plain JSON cannot keep fails the
    // build at the contributing plugin (and any boot), never written wrong.
    if (data) listEntryJson(props, `"${debugName}" entry`);
    return {
      _kind: kind,
      _doc: { label: opts?.docLabel?.(props) },
      // What tells the build this entry is written down as data
      // (`list-entries.generated.ts`) — a record of the barrel keeps it.
      ...(data ? { [DATA_ENTRY]: true } : {}),
      ...props,
      ...(companion ? { companion: true } : {}),
    };
  }) as unknown as ServerContributionToken<P, I>;
  (token as { debugName: string }).debugName = debugName;

  token.getContributionsIfCollected = () => {
    // A data list is read from what the build wrote down, on every host —
    // never from what this process happened to start.
    if (data)
      return writtenEntries === null ? undefined : writtenOf<P>(debugName);
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
    if (data) {
      if (writtenEntries === null)
        throw new Error(
          `[lists] "${debugName}" is a data list, read before this process installed the build's list entries ` +
            "(`installListEntries` — every boot does it before collecting).",
        );
      return writtenOf<P>(debugName);
    }
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

// ── Lists whose entries are data ─────────────────────────────────────────────
//
// A list defined with `data: true` is read from what the BUILD wrote down
// (`list-entries.generated.ts`, from the records it keeps of every plugin
// barrel), on every host — the full server included. So reading it starts
// nobody: a job reads every entry without starting a single contributor, and
// "complete in the server, missing an entry in a job" has no spelling. The
// file is kept equal to the code by the `server-contributors-in-sync` check,
// and every boot compares it with what its started plugins declare
// (`assertWrittenListsMatch`): an entry computed from something only known at
// run time fails there, loudly, never read wrong.

// Every data list this process's modules defined: debug name → its kind.
const dataKinds = new Map<string, symbol>();

// What the build wrote, kept to this process's registry: `null` until a boot
// (or a reader that boots nothing) installs it — a state, not an empty table.
let writtenEntries: {
  readonly table: WrittenListEntries;
  /** Graph node → its plugin's id (`_pluginId`), for every node of this registry. */
  readonly pluginOf: ReadonlyMap<string, string>;
} | null = null;

/**
 * Install the build's data-list entries, kept to `registry` (graph node →
 * plugin id): an entry of a plugin outside this process's composition is not
 * part of its lists. Before collecting (`bootPluginGraph`), or by a process
 * that boots nothing and reads a data list (`./equin db fork`'s probe).
 */
export function installListEntries(
  table: WrittenListEntries,
  registry: ReadonlyMap<string, string>,
): void {
  writtenEntries = { table, pluginOf: registry };
}

/** Forget the installed list entries. Test support (`core/testing`). */
export function clearListEntries(): void {
  writtenEntries = null;
}

function writtenOf<P>(debugName: string): Collected<P>[] {
  const { table, pluginOf } = writtenEntries!;
  // A data list nobody contributes to has no key in the table: the build
  // writes only what it found, and the in-sync check keeps the two equal.
  return (table[debugName] ?? []).flatMap((e) => {
    const pluginId = pluginOf.get(e.node);
    return pluginId === undefined
      ? []
      : [{ ...(e.entry as P), _pluginId: pluginId } as Collected<P>];
  });
}

/** `value` as canonical JSON, or why it is not plain data (`path` names where). */
function canonicalData(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (Number.isFinite(value)) return JSON.stringify(value);
      throw new NotDataError(path, String(value));
    case "object":
      break;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new NotDataError(path, `a ${typeof value}`);
  }
  if (Array.isArray(value))
    return `[${value.map((x, i) => canonicalData(x, `${path}[${i}]`)).join(",")}]`;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null)
    throw new NotDataError(
      path,
      `an instance of ${(value as object).constructor?.name ?? "a class"}`,
    );
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => {
      const x = (value as Record<string, unknown>)[k];
      return `${JSON.stringify(k)}:${canonicalData(x, `${path}.${k}`)}`;
    })
    .join(",")}}`;
}

class NotDataError extends Error {
  constructor(
    readonly path: string,
    readonly what: string,
  ) {
    super(`${path} is ${what}, not plain data`);
  }
}

/**
 * A data list's entry as canonical JSON — key order ignored — or a throw
 * naming where it is not plain data. Shared by the build (which writes the
 * entries) and the boot check (which compares them), so both judge "data" the
 * same way.
 */
export function listEntryJson(entry: unknown, where: string): string {
  try {
    return canonicalData(entry, "entry");
  } catch (err) {
    if (!(err instanceof NotDataError)) throw err;
    throw new Error(
      `[lists] ${where}: ${err.message}. A data list's entry is written down by the build and read from that file on every host, ` +
        "so it must be plain data the build can see — `project` it to its data (a table to its name), or, if it is computed from something only known at run time, it cannot be a data list's entry.",
    );
  }
}

/** A contribution's own entry: what a data list's reader gets, without its bookkeeping. */
function ownEntry(c: ServerContribution): Record<string, unknown> {
  const {
    _kind: _k,
    _doc: _d,
    _pluginId: _p,
    _pluginDescription: _pd,
    [DATA_ENTRY]: _data,
    ...entry
  } = c;
  return entry;
}

/**
 * Every data list's entries this process's STARTED graph nodes declare equal
 * what the build wrote for them, entry for entry — the boot's backstop for an entry
 * computed from something only known at run time (an environment variable, the
 * clock), which the build would have written as it was on the build's machine.
 * Throws naming the list, the plugin and the entries that differ. Run by
 * `bootPluginGraph` right after collecting.
 */
export function assertWrittenListsMatch(
  startedNodes: ReadonlySet<string>,
): void {
  if (byKind === null || writtenEntries === null) {
    throw new Error(
      "[lists] assertWrittenListsMatch before collectContributions and installListEntries",
    );
  }
  const { table, pluginOf } = writtenEntries;
  const failures: string[] = [];
  for (const [name, kind] of dataKinds) {
    const live = byKind.get(kind) ?? [];
    // Compared over the graph nodes that started (a server half and its
    // machine half apart): one this process did not start declares nothing
    // here, and its written entries are still read.
    const key = (pluginId: string, json: string) => `${pluginId} ${json}`;
    const declared = live
      .map((c) =>
        key(
          c._pluginId!,
          listEntryJson(ownEntry(c), `"${name}" entry of ${c._pluginId}`),
        ),
      )
      .sort();
    const written = (table[name] ?? [])
      .flatMap((e) => {
        const pluginId = pluginOf.get(e.node);
        return pluginId === undefined || !startedNodes.has(e.node)
          ? []
          : [key(pluginId, listEntryJson(e.entry, `"${name}" written entry`))];
      })
      .sort();
    const onlyLive = declared.filter((x) => !written.includes(x));
    const onlyWritten = written.filter((x) => !declared.includes(x));
    if (declared.join("\n") !== written.join("\n")) {
      failures.push(
        `"${name}": declared by the code but not written by the build: ${onlyLive.join(" | ") || "none"}; ` +
          `written by the build but not declared: ${onlyWritten.join(" | ") || "none"}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `[lists] the build's list entries (list-entries.generated.ts) disagree with what the started plugins declare:\n${failures.join("\n")}\n` +
        "Run `./equin build` to rewrite them. If they still disagree, an entry is computed from something only known at run time — it cannot be a data list's entry.",
    );
  }
}
