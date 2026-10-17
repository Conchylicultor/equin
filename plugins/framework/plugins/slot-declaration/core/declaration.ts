import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";

// A LEAF on purpose: module eval depends on nothing but a type import, so the
// build-time collectors (the slots facet, the codegen declaration guard) can
// read this contract without pulling `web-sdk/core` — and with it React — into
// their module graph. Importing React before `registerBarrelStubs` runs would
// bind the real package ahead of the stub the whole barrel-import phase relies
// on.

/**
 * What a slot IS, carried on the slot object itself.
 *
 * Before this existed, "which constructor made this slot" was recoverable only
 * by sniffing which render method got attached (`.Render` → render slot) or by
 * grepping for the constructor's NAME in source text — and
 * `defineOrderedDispatchSlot`, whose runtime is literally `defineDispatchSlot`,
 * had no runtime evidence of its own identity at all. `reorderable` was likewise
 * trapped inside `defineRenderSlot`'s closure. Both are now facts on the object,
 * so every consumer reads one field instead of re-deriving the answer.
 */
export interface SlotMeta {
  kind: "slot" | "render" | "mount" | "wrap" | "dispatch" | "ordered-dispatch";
  /**
   * Whether this slot's contributions are user-orderable (and therefore owe a
   * reorder config directive). True for render and ordered-dispatch slots.
   */
  reorderable: boolean;
  /**
   * A render slot that is an internal part of ONE component — a list the
   * component draws inside itself — rather than a row of its own. Read by the
   * pane title guard: a render slot mounted inside a pane title throws (a
   * second header row the order file cannot see) unless it declares this.
   * Set through `defineRenderSlot({ partOfComponent: true })`.
   */
  partOfComponent?: boolean;
  /**
   * The slot's owner accepts COMPANIONS: a contribution here may say
   * `companion: true`, and then it ships in every composition that ships the
   * owner — the closure engine reads the flag statically and turns it into a
   * hard owner → contributor edge. For runtime companions nothing imports (the
   * sprite sheet `<Icon>` draws from, the middleware every slot renders
   * through). Every other contribution to the slot stays opt-in. Set through
   * `defineSlot({ companions: true })`.
   */
  companions?: true;
}

/**
 * The runtime-erased view of a slot — everything a slot-SET consumer (the
 * declaration guard, the slots facet, the reorder registry) needs, without the
 * props generic. Every {@link import("./slots").Slot} is one of these.
 */
export interface SlotHandle {
  id: string;
  meta: SlotMeta;
  /**
   * Set only on a FACADE — a hand-built callable presenting another slot (see
   * `defineSlotFacade`) — and pointing at the slot it fronts.
   *
   * A facade is what a plugin declares and what consumers import, but it is not
   * the object the constructor recorded, so declaring it must stamp the target
   * rather than the wrapper. {@link collectSlots} follows this; everything else
   * can ignore it.
   */
  _slot?: SlotHandle;
  /**
   * The plugin that DECLARED this slot, stamped by `PluginProvider` from the
   * declaring plugin's id (see `PluginDefinition.slots`). Ownership is read off
   * the declaration, never off "whoever imported the module first", so it can
   * neither depend on module-cache order nor be contested — exactly one plugin
   * may declare a slot (enforced by {@link declarePluginSlots}).
   */
  _pluginId?: PluginId;
  /**
   * The key path this slot was declared under, stamped alongside `_pluginId`.
   * Together they ARE the slot's name: its id is `${_pluginId}.${_key}`, and its
   * config file is `config/<plugin path>/<_key>.jsonc`.
   */
  _key?: string;
}

/**
 * What a plugin may put under a key in its `slots` record: a slot itself, or an
 * object whose own enumerable values include slots — a slot group
 * (`export const Studio = {…}`), a pane (whose `Actions` slot is an own value).
 *
 * Normalised exactly ONE shallow level. That shortcut is safe precisely because
 * anything nested deeper is not silently lost: it stays in `created \ declared`
 * and the build-time orphan guard names it, so the author declares it explicitly.
 */
export type SlotSource = SlotHandle | object;

/**
 * A plugin's slot declaration: the KEY under which each slot is declared is what
 * names it. A slot has no id of its own — its id is `${pluginId}.${keyPath}` —
 * so this record is where a slot's name comes into existence, and the plugin id
 * prefix is why that name can never disagree with its owner.
 *
 * ```ts
 * slots: Studio                          // { Sidebar, Toolbar } → …shell.sidebar / .toolbar
 * slots: { canvas: canvasPane }           // pane's Actions      → …graph.canvas.actions
 * slots: { ...Studio, detail: detailPane }
 * ```
 *
 * Typed `object`, not `Record<string, SlotHandle>`, for two reasons that are the
 * same reason: a factory result like `ItemActions<Row>` is an INTERFACE, and
 * TypeScript withholds the implicit index signature an interface would need to
 * satisfy a `Record`; and a slot group legitimately carries non-slot members
 * beside its slots (`controlSize`, `useZones`, a helper component). What counts
 * is decided at runtime by `collectSlots` — and a slot that fails to show up
 * there is not lost, it is an orphan the build-time guard names.
 */
export type SlotRecord = object;

/** One declared slot, paired with the key path that names it. */
export interface SlotDeclaration {
  slot: SlotHandle;
  /** Key path under the owning plugin: "sidebar", "canvas.actions". */
  key: string;
}

/**
 * A declaration key as an id segment: `TabBarActions` → `tab-bar-actions`,
 * `JSONLViewer` → `jsonl-viewer`. Authors key a record the way they name an
 * export; ids are kebab, as every existing id already is.
 */
export function seg(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * A slot's id, from its two halves. The ONE place `` `${pluginId}.${keyPath}` ``
 * is spelled.
 *
 * A slot has no id of its own — it is the declaring plugin's id plus the key
 * that plugin declared it under — so the composition is a fact about the naming
 * scheme, not a string each reader happens to build. It was built in six places
 * (the `slot.id` getter, {@link declarePluginSlots}, and four sites in the slots
 * facet), and the facet's copies are the ones that matter: they run under
 * `skipBarrelImport`, where there is no declaration to read the id back off, so
 * they must derive the SAME id the pass would settle. Six spellings of a
 * scheme is six chances for one to drift and produce a plausible id that names
 * nothing.
 *
 * `keyPath` is already an id-segment path ("sidebar", "canvas.actions") — the
 * form {@link collectSlots} settles and {@link seg} produces. This does not
 * re-`seg` it, because a dotted path's separators are not part of a segment.
 */
export function slotIdFor(pluginId: string, keyPath: string): string {
  return `${pluginId}.${keyPath}`;
}

const SEGMENT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Reserved because ~25 plugins already own a plain `defineConfig({ name: "config" })`,
 * whose file is `config/<plugin>/config.jsonc`. A slot keyed `config` would land
 * on the same path — and short derived names are exactly what makes that newly
 * reachable.
 */
const RESERVED_KEYS = new Set(["config"]);

// Every slot ever constructed, in construction order. Appended by `defineSlot`,
// which EVERY slot constructor funnels through — so this set needs no registry
// to keep in sync and nothing for an author to remember.
const createdSlots: SlotHandle[] = [];

/** Internal: called by `defineSlot` for every slot, once, at construction. */
export function recordCreatedSlot(slot: SlotHandle): void {
  createdSlots.push(slot);
}

/**
 * Every slot constructed SO FAR in this runtime.
 *
 * Complete only where module loading is complete — true in the build-time
 * codegen process (which imports every barrel), NOT mid-boot in the browser,
 * where web plugins load in tiers (`load-tiers.ts`). Consumers that need
 * completeness must run where it holds; see the orphan guard in codegen.
 */
export function getCreatedSlots(): readonly SlotHandle[] {
  return createdSlots;
}

/**
 * Whether `v` is a slot: a callable carrying `meta` + `useContributions`.
 *
 * It deliberately does NOT look at `id`. An id is derived from the declaring
 * plugin, so an undeclared slot has none and reading it throws — and this
 * predicate runs during `collectSlots`, i.e. precisely while deciding which
 * objects are the slots about to BE declared. Both fields it does read are
 * stamped at construction, so they are always there to be asked about.
 */
export function isSlot(v: unknown): v is SlotHandle {
  if (typeof v !== "function") return false;
  const s = v as Partial<SlotHandle> & { useContributions?: unknown };
  return (
    typeof s.useContributions === "function" &&
    typeof s.meta === "object" &&
    s.meta !== null
  );
}

/**
 * Normalise one plugin's `slots` record into the slots it declares, each paired
 * with the key path that NAMES it.
 *
 * A value may be a slot (key path = the key) or an object whose own values are
 * slots (key path = `key.member`), read exactly one level deep. So a slot group
 * declares as `slots: Studio` — the group's own property names are already the
 * names — while a pane needs a key: `slots: { canvas: canvasPane }`.
 *
 * Throws on an entry that yields nothing: an entry the author believed carried
 * slots but does not is a mistake, and returning `[]` would turn it into a
 * missing declaration diagnosed far away (as an orphan) instead of here, where
 * the offending entry is still in hand.
 */
export function collectSlots(
  owner: string,
  slots: SlotRecord,
): SlotDeclaration[] {
  // An array is an object, so `slots: [Studio]` would otherwise normalise to the
  // key path "0.sidebar" — a plausible-looking id nobody wrote. Name the fix.
  if (Array.isArray(slots)) {
    throw new Error(
      `[plugin.${owner}] \`slots\` is an array. It is now a RECORD, because the key ` +
        `is what names each slot (its id is \`\${pluginId}.\${key}\`). A slot group ` +
        `declares as \`slots: Studio\`; a pane needs a key: \`slots: { canvas: canvasPane }\`.`,
    );
  }
  // A lone slot as the WHOLE record has no key, so it would name nothing — and
  // iterating its own members (`meta`, `Render`, …) finds no slots, so it would
  // silently declare nothing and resurface as an orphan.
  if (isSlot(slots)) {
    throw new Error(
      `[plugin.${owner}] \`slots\` is a single slot with no key to name it. ` +
        `Give it one: \`slots: { <name>: <slot> }\`.`,
    );
  }

  const out: SlotDeclaration[] = [];
  const byKey = new Map<string, SlotHandle>();
  const keyOfSlot = new Map<SlotHandle, string>();

  const push = (slot: SlotHandle, keyPath: string): void => {
    // A facade declares its target, never itself: the target is the object the
    // constructor recorded, so stamping the wrapper would leave the real slot
    // undeclared.
    const real = slot._slot ?? slot;

    for (const segment of keyPath.split(".")) {
      if (!SEGMENT_RE.test(segment)) {
        throw new Error(
          `[plugin.${owner}] slot key "${keyPath}" is not a usable id segment ` +
            `(at "${segment}"). Use plain names — letters and digits, no dots: the ` +
            `hierarchy is already carried by the plugin id.`,
        );
      }
    }
    if (RESERVED_KEYS.has(keyPath)) {
      throw new Error(
        `[plugin.${owner}] slot key "${keyPath}" is reserved — its config file would ` +
          `collide with this plugin's own \`config/${owner.split(".").join("/")}/${keyPath}.jsonc\`.`,
      );
    }

    const existingAtKey = byKey.get(keyPath);
    if (existingAtKey !== undefined && existingAtKey !== real) {
      throw new Error(
        `[plugin.${owner}] two different slots derive the key "${keyPath}" — ` +
          `they would share one id, one config file and one contribution list.`,
      );
    }
    const existingKey = keyOfSlot.get(real);
    if (existingKey !== undefined) {
      if (existingKey === keyPath) return; // same slot reached twice; harmless
      throw new Error(
        `[plugin.${owner}] one slot is declared under two keys, "${existingKey}" and ` +
          `"${keyPath}". A slot has exactly one name — declare it once.`,
      );
    }
    byKey.set(keyPath, real);
    keyOfSlot.set(real, keyPath);
    out.push({ slot: real, key: keyPath });
  };

  for (const [key, source] of Object.entries(
    slots as Record<string, unknown>,
  )) {
    if (isSlot(source)) {
      push(source, seg(key));
      continue;
    }
    // Not a slot and not slot-bearing — a group's ordinary members (`controlSize`,
    // `useZones`, a helper component) sit right beside its slots, so they are
    // skipped rather than rejected. Nothing is lost by being lenient: a slot that
    // fails to appear here is still in `created \ declared`, and the build-time
    // orphan guard names it and the directory that constructed it.
    if (
      source === null ||
      (typeof source !== "object" && typeof source !== "function")
    ) {
      continue;
    }
    for (const [memberKey, member] of Object.entries(
      source as Record<string, unknown>,
    )) {
      if (isSlot(member)) push(member, `${seg(key)}.${seg(memberKey)}`);
    }
  }
  return out;
}

/**
 * Read a plugin's slot declaration off an imported module record — the ONE
 * definition of where a declaration lives, shared by the slots facet and the
 * build-time guard so they cannot look in different places.
 *
 * Normally it is `default.slots`, the `PluginDefinition` field. A module with no
 * default export at all declares via a named `slots` export instead: that is how
 * a plugin whose loaded module is not a `PluginDefinition` — web-sdk itself, which
 * has no `web/index.ts` because it IS the web runtime — still declares the slots
 * it owns. Returns `null` when the module declares nothing.
 */
export function declaredSlotSources(
  mod: Record<string, unknown>,
): SlotRecord | null {
  // An array is rejected loudly by `collectSlots`, not silently ignored here:
  // a stale `slots: [...]` must name itself, never read as "declares nothing"
  // and reappear as a pile of orphans.
  // `typeof "function"` counts: a slot IS a callable, and so is a factory result
  // like `defineItemActions(...)`. Excluding functions here made `slots: <a slot>`
  // read as "declares nothing" and silently orphan it, instead of reaching
  // `collectSlots`, which says exactly what is wrong with it.
  const asRecord = (v: unknown): SlotRecord | null =>
    v !== null && (typeof v === "object" || typeof v === "function")
      ? (v as SlotRecord)
      : null;

  const def: unknown = mod.default;
  if (def !== undefined) {
    if (def === null || typeof def !== "object") return null;
    return asRecord((def as { slots?: unknown }).slots);
  }
  return asRecord(mod.slots);
}

/** A plugin as the declaration pass sees it: its id plus what it declares. */
export interface SlotDeclaringPlugin {
  id: PluginId;
  slots?: SlotRecord;
}

/**
 * Which plugin set a declaration pass modelled — carried BY the answers that
 * pass gives, so "not declared" can say what it is not declared *in*.
 *
 *  - `"registry"` — the plugin set the browser actually loads. A DISABLED
 *    plugin is absent from it, so its slots are legitimately unnamed under this
 *    scope: that is an answer, not a failure.
 *  - `"source"` — everything the checkout declares, disabled plugins included.
 *    What a reader describing the SOURCE (the facets, the docs) needs.
 *
 * Declared HERE, in the leaf, rather than beside the scoped barrel pass that
 * takes it as an argument: {@link SlotLookup} has to name a scope, and this
 * module may not import codegen — nor anything else (see the file header, and
 * this plugin's CLAUDE.md). The scoped entry point imports the type from here
 * instead, which is the direction the dependency already runs.
 */
export type SlotScope = "registry" | "source";

/** One declaration a pass settled: the slot, its id, and the two parts of it. */
export interface SlotNamingEntry {
  slot: SlotHandle;
  id: string;
  pluginId: PluginId;
  key: string;
}

/**
 * What a slot is called, as a STATE rather than a nullable string.
 *
 * There used to be a free `declaredSlotId(slot?): string | undefined` here, and
 * that `undefined` carried three different meanings: "this contribution targets
 * no slot",
 * "no declaration pass ran, I cannot answer", and "declared by nobody in this
 * scope". Only the last is a real answer, and it is the only one left here — the
 * first belongs at the call site, beside the `if (c._slot)` branch it is really
 * about, and the second is not reachable, because `idOf` is a method on a naming
 * and only a pass mints one.
 *
 * A union rather than `string | undefined` is what makes the surviving state
 * UNABSORBABLE: `id` exists only on the `named` arm, so a consumer cannot reach
 * it without discriminating, and there is no `undefined` left to `!==` against —
 * the comparison that silently matches nothing and reads downstream as "this
 * plugin contributes nothing" instead of as the tooling failure it is.
 */
export type SlotLookup =
  | { kind: "named"; id: string; pluginId: PluginId; key: string }
  | { kind: "out-of-scope"; scope: SlotScope };

/**
 * The witness a declaration pass returns: the naming it settled, and the only
 * thing that can say what a slot is called.
 *
 * WHY IT HOLDS ITS OWN MAPS rather than reading the `_pluginId` / `_key` stamps
 * back off the slot objects. The stamps are process-global, monotonic and never
 * cleared, so reading them answers "the union of every pass that has run so far
 * in this process", not "what THIS pass declared". Checks run concurrently under
 * `Promise.all` (`checks/core/runner.ts`), so which passes have landed when a
 * given check reads is a matter of interleaving; and a `"tree"` check's verdict
 * is CACHED and trusted by a later `push` from a different process, so it must
 * be a function of the tree and of nothing else that ran beside it
 * (`tooling/core/types.ts` states that rule verbatim, with this very bug class
 * as its worked example). A naming built from the stamps would quietly make one
 * check's answer depend on another's timing. Do not "simplify" these maps away.
 *
 * The stamps stay — the browser's `slot.id` getter derives from them, and the
 * orphan guard asks whether a slot was ever declared at all. They are simply no
 * longer how a SCOPED reader gets its answer.
 */
export interface SlotNaming {
  /**
   * The slot this pass declared under `id`. THROWS on an id this pass did not
   * settle, naming both the id and the scope.
   *
   * For a GENERATOR, which should abort: resolve once outside a loop and compare
   * `c._slot === theSlot` inside it, so no id string survives in the loop to
   * drift and a stale one fails at a single named line instead of matching
   * nothing. A CHECK must use {@link SlotNaming.findSlot} instead — the runner
   * awaits every check under `Promise.all` and rethrows, so one throw inside a
   * check kills every other check's reporting.
   */
  slotNamed(id: string): SlotHandle;
  /** Probe form, for a caller that must turn absence into its own failure value. */
  findSlot(id: string): SlotHandle | undefined;
  /**
   * Note the parameter: `SlotHandle`, never `SlotHandle | undefined`. "This
   * contribution targets no slot" is the caller's own branch, not an arm of this
   * answer.
   */
  idOf(slot: SlotHandle): SlotLookup;
  /** Every declaration this pass settled, in declaration order. */
  declarations(): readonly SlotNamingEntry[];
  /** Preserved, so existing owners-map consumers are untouched. */
  owners: ReadonlyMap<string, PluginId>;
}

/** The scope as a message fragment, so a failure says what it is scoped to. */
function describeScope(scope: SlotScope): string {
  return scope === "registry"
    ? `"registry" scope — the plugin set the browser loads, which excludes disabled plugins`
    : `"source" scope — every plugin the checkout declares`;
}

/**
 * Freeze one pass's maps into the witness it returns. A frozen closure, not a
 * class: `core/` here is functional, and there is no state to mutate afterwards
 * — that is the property the whole design rests on.
 */
function makeNaming(
  entries: readonly SlotNamingEntry[],
  owners: ReadonlyMap<string, PluginId>,
  scope: SlotScope,
): SlotNaming {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const bySlot = new Map(entries.map((e) => [e.slot, e]));
  return Object.freeze({
    owners,
    declarations: () => entries,
    findSlot: (id: string): SlotHandle | undefined => byId.get(id)?.slot,
    slotNamed: (id: string): SlotHandle => {
      const entry = byId.get(id);
      if (entry === undefined) {
        throw new Error(
          `[slots] no slot is declared under the id "${id}" in this declaration ` +
            `pass (${describeScope(scope)}). Either the id is stale — an id derives ` +
            `from the declaring plugin's id plus its \`slots\` key, so moving a ` +
            `plugin renames every slot it owns — or its declaring plugin is outside ` +
            `this scope.`,
        );
      }
      return entry.slot;
    },
    idOf: (slot: SlotHandle): SlotLookup => {
      // A FACADE is looked through, exactly as `collectSlots` looks through one
      // when it declares it: the facade fronts the target, delegates its `id`
      // getter to the target, and the target is the object this pass recorded.
      const entry = bySlot.get(slot._slot ?? slot);
      return entry === undefined
        ? { kind: "out-of-scope", scope }
        : {
            kind: "named",
            id: entry.id,
            pluginId: entry.pluginId,
            key: entry.key,
          };
    },
  });
}

/**
 * Notified at the end of every declaration pass with that pass's naming (whose
 * `.owners` is the map subscribers have always read).
 *
 * The seam exists because a slot's OWNER is not known at construction — a slot
 * object is minted when its module evaluates, and which plugin owns it is only
 * settled when that plugin's definition is read. Anything derived per owned slot
 * (reorder's config descriptors and their registrations) therefore has exactly
 * one correct moment to (re)derive itself, and this is it: after the stamps, and
 * before `PluginProvider` reads any plugin's `contributions`.
 *
 * It is also what makes the browser's TIERED loading correct: each deferred
 * batch runs a fresh declaration pass over the grown plugin set, so a derived
 * registry catches up instead of being frozen at the first module's eval.
 */
export type SlotDeclarationListener = (naming: SlotNaming) => void;

const declarationListeners = new Set<SlotDeclarationListener>();
// The naming of the pass that ran LAST, replayed to late subscribers. Before the
// first pass it is an empty one rather than `undefined`, so a subscriber never
// has to branch on "has a pass run".
//
// There used to be a `slotDeclarationPasses()` counter beside this, so that a
// reader of plugins' `contributions` could refuse to answer before the first
// pass — a contributions array derived from the declaration (reorder's per-slot
// config directives, filled by `subscribeSlotsDeclared`) is empty until then,
// and reading it early gives a smaller answer indistinguishable from a correct
// one. That was a runtime assert standing in for a missing type. The one reader
// that needed it (the contributions facet) is now handed its modules and the
// naming of the pass over them as ONE value, so "barrels without a pass" has no
// spelling on that path and there is nothing left to count.
let lastNaming: SlotNaming = makeNaming([], new Map(), "registry");

/**
 * Subscribe to declaration passes. The listener is invoked immediately with the
 * latest naming (an empty one before the first pass), so a subscriber that
 * registers late is never one pass behind.
 */
export function subscribeSlotsDeclared(
  listener: SlotDeclarationListener,
): () => void {
  declarationListeners.add(listener);
  listener(lastNaming);
  return () => {
    declarationListeners.delete(listener);
  };
}

/**
 * Build the slotId → declaring-plugin map across every loaded plugin, stamping
 * `_pluginId` onto each slot OBJECT (not a copy — the reorder middleware looks
 * descriptors up by reference identity, so the slot every consumer holds must be
 * the one carrying the owner).
 *
 * Two plugins declaring the same slot throws. That is what makes stamping the
 * shared object safe: exactly one plugin may claim a slot, so the stamp can
 * never be contested. It also closes today's silent "first definer wins" dedupe.
 *
 * Idempotent: re-running over a superset of plugins (the browser appends each
 * deferred batch) re-derives the same map and re-writes the same stamps.
 *
 * Returns the {@link SlotNaming} this pass settled — the witness that OWNS the
 * answers, so no reader has to hope a pass ran, and no reader's answer depends
 * on which other pass ran beside it.
 *
 * `scope` is REQUIRED, and deliberately has no default. It is what an
 * `out-of-scope` answer names, and the two scopes model different plugin sets —
 * a default would let a source-scoped reader (the facets, the docs, anything
 * describing the checkout) silently receive the registry's smaller answer, which
 * is the shape of failure this whole witness exists to remove. Every pass site
 * states which question it is asking: `PluginProvider` and the codegen barrel
 * guard's registry pass say `"registry"`, the enriched tree says `"source"`.
 */
export function declarePluginSlots(
  plugins: readonly SlotDeclaringPlugin[],
  scope: SlotScope,
): SlotNaming {
  const owners = new Map<string, PluginId>();
  // THIS pass's declarations, in declaration order. Accumulated here rather than
  // recovered afterwards from the stamps written below — see {@link SlotNaming}
  // for why that distinction is the whole point.
  const entries: SlotNamingEntry[] = [];
  // Which slot OBJECT claimed each id in THIS pass. Keying on the object rather
  // than on the owner id is what catches a same-plugin collision: two slots of
  // one plugin landing on one id used to pass silently, and downstream they
  // would share a contribution list at render, collapse to a single manifest
  // row, and — one descriptor registering instead of two — let the prune delete
  // the loser's authored config.
  const claimant = new Map<string, SlotHandle>();
  for (const plugin of plugins) {
    if (!plugin.slots) continue;
    for (const { slot, key } of collectSlots(plugin.id, plugin.slots)) {
      // Composed here rather than read off `slot.id`: the getter derives the id
      // FROM the stamps this loop is about to write, so asking the slot for its
      // own name before naming it is exactly the read that throws.
      const id = slotIdFor(plugin.id, key);
      const existing = owners.get(id);
      if (existing !== undefined && existing !== plugin.id) {
        throw new Error(
          `[slots] slot "${id}" is declared by two plugins: ` +
            `"${existing}" and "${plugin.id}". Exactly one plugin owns a slot — ` +
            `the other should import it, not declare it.`,
        );
      }
      const prior = claimant.get(id);
      if (prior !== undefined && prior !== slot) {
        throw new Error(
          `[slots] two different slots of "${plugin.id}" resolve to the id ` +
            `"${id}". They would share one config file and one contribution ` +
            `list — give them distinct keys in that plugin's \`slots\` record.`,
        );
      }
      // First settlement of this id in this pass. A plugin can legitimately
      // reach here twice — the facet tree declares per imported MODULE, so a
      // plugin's web and server barrels both push a record — and the two guards
      // above have already proved it is the same slot and the same owner, so the
      // first entry stands rather than being duplicated.
      if (prior === undefined) {
        entries.push({ slot, id, pluginId: plugin.id, key });
      }
      claimant.set(id, slot);
      owners.set(id, plugin.id);
      slot._pluginId = plugin.id;
      slot._key = key;
    }
  }
  const naming = makeNaming(entries, owners, scope);
  // Published before the listeners run, so a subscriber that re-derives state
  // here (and anything it calls) already sees the pass it is being notified
  // about. A pass that threw above never publishes — it settled no ownership.
  lastNaming = naming;
  for (const listener of declarationListeners) listener(naming);
  return naming;
}

/**
 * `created \ declared` — every slot constructed in this runtime that no plugin
 * declared. Non-empty is an error at the one place both sets are complete (the
 * build-time codegen process); the caller formats and throws, because it is the
 * one that can attribute each orphan to a source location.
 */
export function findUndeclaredSlots(): SlotHandle[] {
  // By OBJECT (is this slot stamped?), never by id string. Matching on the id
  // let a slot hide behind a namesake: a hand-built facade that copied its
  // target's id was declared in the target's place, the target itself was never
  // stamped, and the guard waved it through because *something* owned that
  // string. `defineSlotFacade` fixes the facades; this makes the guard unable to
  // be fooled by the next one.
  return getCreatedSlots().filter((slot) => slot._pluginId === undefined);
}
