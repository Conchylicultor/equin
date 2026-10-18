import { join } from "path";
import {
  createFacet,
  type DocFact,
} from "@plugins/plugin-meta/plugins/facets/core";
import {
  collectSlots,
  declaredSlotSources,
  isSlot,
  seg,
  slotIdFor,
} from "@plugins/framework/plugins/slot-declaration/core";
import {
  isKeySpace,
  type SlotCompanions,
  type SlotHandle,
} from "@plugins/framework/plugins/slot-declaration/core";
import {
  readIfExists,
  stripTypes,
  maskSource,
  parseDefineGroup,
  markerCallSpans,
  matchBracket,
  walkFiles,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { type SlotDef, slotsFacetDef } from "../core";

/**
 * Parse `defineRenderSlot(...)` / `defineMountSlot(...)` calls. Mirrors
 * `parseDefineGroup`, but these slots aren't always assigned inside a
 * `Member: builder(...)` group entry (some are standalone, e.g.
 * `VariantGroup: defineRenderSlot<T>({...})`). So we scan each builder
 * occurrence directly: take the first string literal as the id and the nearest
 * preceding `Member:` (or `const Member =`) as the member name. `kind` is fixed
 * by the builder — `"render"` (always reorderable) or `"mount"` (never).
 */
function parseSlotCalls(
  masked: string,
  builder:
    | "defineRenderSlot"
    | "defineMountSlot"
    | "defineWrapperSlot"
    | "defineOrderedDispatchSlot",
  kind: "render" | "mount" | "wrap" | "ordered-dispatch",
  pluginId: string,
): SlotDef[] {
  const out: SlotDef[] = [];
  // Locate calls over the FULL mask so a `defineRenderSlot()` written inside a
  // string/template literal is never matched; read the id back from the ORIGINAL
  // at the call's arg span.
  for (const span of markerCallSpans(masked, builder)) {
    // The member/group name is the nearest `Word:` or `const Word =` before the
    // call, computed over the MASKED prefix so a `Word:` inside a string can't
    // invent a false member.
    const prefix = masked.slice(0, span.identifier);
    const nameMatch = /(\w+)\s*:\s*$|(?:export\s+)?const\s+(\w+)\s*=\s*$/.exec(
      prefix.replace(/<[^>]*>\s*$/, ""),
    );
    // No name in source ⇒ nothing this parse can identify. A slot minted inside
    // a factory (a pane's Actions) is exactly that case; the barrel-import path
    // is what sees those.
    const memberName = nameMatch && (nameMatch[1] ?? nameMatch[2]);
    if (!memberName) continue;
    // Group name: nearest enclosing `export const Group = {` if any, else member.
    const groupMatch = [
      ...prefix.matchAll(/export\s+const\s+([A-Z]\w*)\s*=\s*\{/g),
    ].pop();
    const groupName = groupMatch ? groupMatch[1]! : memberName;

    // DERIVED, not read: the id is the declaring plugin plus the declaration
    // key, and the key is what the member is called.
    const slotId = slotIdFor(pluginId, seg(memberName));
    out.push({ memberName, slotId, groupName, kind, contributors: [] });
  }
  return out;
}

// Every constructor a slot can be made with — the ones taking `companions`.
const COMPANION_SLOT_BUILDERS = [
  "defineSlot",
  "defineDispatchSlot",
  "defineOrderedDispatchSlot",
  "defineRenderSlot",
  "defineMountSlot",
  "defineWrapperSlot",
] as const;

const BUILDER_KIND: Record<
  (typeof COMPANION_SLOT_BUILDERS)[number],
  NonNullable<SlotDef["kind"]>
> = {
  defineSlot: "slot",
  defineDispatchSlot: "dispatch",
  defineOrderedDispatchSlot: "ordered-dispatch",
  defineRenderSlot: "render",
  defineMountSlot: "mount",
  defineWrapperSlot: "wrap",
};

/** A slot constructor call carrying a `companions:` option. */
interface CompanionSlotCall {
  /** The name the slot is exported under (a `const` renamed by `export { X as Y }` resolved). */
  name: string;
  kind: NonNullable<SlotDef["kind"]>;
  companions: SlotCompanions;
}

/**
 * Read the `companions` option of a slot constructor's argument, or `undefined`
 * when it has none. Only literal spellings are accepted — `true`, or
 * `{ key: "<prop>", space: "<KeySpace>" }` — and anything else THROWS: the
 * closure engine ships a slot's companions by this value alone, so one it
 * cannot read would ship them as options, the incident it exists to prevent.
 */
function readCompanionsOption(
  masked: string,
  original: string,
  open: number,
  close: number,
  file: string,
): SlotCompanions | undefined {
  // Only the call's own top-level object literal: `{` right after `(`.
  let brace = open + 1;
  while (brace < close && /\s/.test(masked[brace]!)) brace++;
  if (masked[brace] !== "{") return undefined;
  const end = matchBracket(masked, brace, "{", "}");
  if (end < 0) return undefined;
  // Depth-1 `companions:` only, so a nested option object cannot answer.
  let depth = 0;
  for (let i = brace; i < end; i++) {
    const c = masked[i]!;
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    if (depth !== 1) continue;
    const m = /^companions\s*:\s*/.exec(masked.slice(i, end));
    if (!m || (i > brace && /[\w$]/.test(masked[i - 1]!))) continue;
    const at = i + m[0].length;
    const rest = masked.slice(at, end);
    if (/^true\b/.test(rest)) return true;
    if (rest.startsWith("{")) {
      const objEnd = matchBracket(masked, at, "{", "}");
      const body = original.slice(at, objEnd + 1);
      const key = /\bkey\s*:\s*"([^"]+)"/.exec(body)?.[1];
      const space = /\bspace\s*:\s*"([^"]+)"/.exec(body)?.[1];
      if (key && space && isKeySpace(space)) return { key, space };
    }
    throw new Error(
      `${file}: a slot's \`companions\` option must be the literal \`true\` or ` +
        '`{ key: "<prop>", space: "<KeySpace>" }` (a known space) — the closure ' +
        "engine reads it statically to decide when the slot's companions ship. " +
        `Got: ${original.slice(at, Math.min(end, at + 80)).trim()}`,
    );
  }
  return undefined;
}

/** Every companion-taking slot constructor call in one file. */
function companionSlotCalls(
  masked: string,
  original: string,
  file: string,
): CompanionSlotCall[] {
  // `export { ValueCodecSlot as ValueCodec }` — the slot is known by its export.
  const exportedAs = new Map<string, string>();
  for (const m of masked.matchAll(/export\s*\{([^}]*)\}/g))
    for (const part of m[1]!.split(",")) {
      const alias = /^\s*(\w+)\s+as\s+(\w+)\s*$/.exec(part);
      if (alias) exportedAs.set(alias[1]!, alias[2]!);
    }
  const out: CompanionSlotCall[] = [];
  for (const builder of COMPANION_SLOT_BUILDERS) {
    for (const span of markerCallSpans(masked, builder)) {
      const companions = readCompanionsOption(
        masked,
        original,
        span.open,
        span.close,
        file,
      );
      if (!companions) continue;
      const prefix = masked.slice(0, span.identifier);
      const nameMatch =
        /(\w+)\s*:\s*$|(?:export\s+)?const\s+(\w+)\s*=\s*$/.exec(prefix);
      const local = nameMatch && (nameMatch[1] ?? nameMatch[2]);
      if (!local)
        throw new Error(
          `${file}: a slot declared with \`companions\` must be bound to a name ` +
            "(`Member: " +
            builder +
            "(…)` or `const Member = " +
            builder +
            "(…)`) so the closure engine can match its contributions to it.",
        );
      out.push({
        name: exportedAs.get(local) ?? local,
        kind: BUILDER_KIND[builder],
        companions,
      });
    }
  }
  return out;
}

/**
 * The group a slot defined OUTSIDE its group object is listed under: the
 * `export const Group = { …, Member, … }` whose body names it, as a shorthand
 * (`Cell,`) or a value (`Cell: Cell`). Returns the group and the member key.
 */
function enclosingGroupOf(
  name: string,
  maskedFiles: readonly string[],
): { groupName: string; memberName: string } | undefined {
  for (const masked of maskedFiles) {
    for (const m of masked.matchAll(/export\s+const\s+([A-Z]\w*)\s*=\s*\{/g)) {
      const start = masked.indexOf("{", m.index);
      const end = matchBracket(masked, start, "{", "}");
      if (end < 0) continue;
      const body = masked.slice(start + 1, end);
      const entry = new RegExp(
        `(?:^|[,{\\s])(?:(\\w+)\\s*:\\s*)?${name}\\s*(?:,|$)`,
        "m",
      ).exec(body);
      if (entry) return { groupName: m[1]!, memberName: entry[1] ?? name };
    }
  }
  return undefined;
}

/**
 * Stamp `companions` onto the slots `slots` already holds, adding the ones the
 * group parse cannot reach (a slot `const` defined in its own file and listed
 * in its group by shorthand — `DataViewSlots.Cell`).
 */
function applyCompanions(
  slots: SlotDef[],
  calls: readonly CompanionSlotCall[],
  maskedFiles: readonly string[],
  pluginId: string,
): void {
  for (const call of calls) {
    const existing = slots.find((s) => s.memberName === call.name);
    if (existing) {
      existing.companions = call.companions;
      continue;
    }
    const group = enclosingGroupOf(call.name, maskedFiles) ?? {
      groupName: call.name,
      memberName: call.name,
    };
    slots.push({
      memberName: group.memberName,
      groupName: group.groupName,
      slotId: slotIdFor(pluginId, seg(group.memberName)),
      kind: call.kind,
      contributors: [],
      companions: call.companions,
    });
  }
}

/**
 * Static parse of every source file under the plugin's OWN `web/` (walkFiles
 * skips sub-plugin `plugins/` trees, `node_modules` and tests), deduped by slot
 * id, first writer wins.
 *
 * Two callers, two jobs. Under `skipBarrelImport` this IS the slot set. When
 * barrels are imported the declaration is the set, and this supplies only the
 * DISPLAY NAMES (`Group.Member`) — the one thing source text knows and the
 * runtime has erased. A slot the parse can't reach (a factory's templated id)
 * simply has no static name.
 */
function parseSlotsFromSource(dir: string, pluginId: string): SlotDef[] {
  const slots: SlotDef[] = [];
  const seen = new Set<string>();
  const files: string[] = [];
  walkFiles(join(dir, "web"), files);
  const companionCalls: CompanionSlotCall[] = [];
  const maskedFiles: string[] = [];

  for (const file of files) {
    const src = readIfExists(file);
    if (!src) continue;
    // stripTypes drops comments on the happy path; a FULL mask additionally
    // defends the transpile-failure fallback — a `defineSlot()` written in a
    // comment or string/template literal is blanked away and never parsed as a
    // real slot. Nothing is read back from the original any more — a slot id is
    // derived from its plugin and member name, not recovered from source text.
    const original = stripTypes(src, file);
    const masked = maskSource(original);
    maskedFiles.push(masked);
    companionCalls.push(...companionSlotCalls(masked, original, file));
    // Render and mount slots first: scanned by builder name (distinct from
    // `defineSlot`, so the group parser below won't double-count them).
    const fileSlots: SlotDef[] = [
      ...parseSlotCalls(masked, "defineRenderSlot", "render", pluginId),
      ...parseSlotCalls(masked, "defineMountSlot", "mount", pluginId),
      ...parseSlotCalls(masked, "defineWrapperSlot", "wrap", pluginId),
      // Before the `defineDispatchSlot` group pass: an ordered-dispatch slot is
      // usually a standalone `const`, which that pass (group members only) never
      // reaches — and first writer wins the dedupe below.
      ...parseSlotCalls(
        masked,
        "defineOrderedDispatchSlot",
        "ordered-dispatch",
        pluginId,
      ),
      ...parseDefineGroup(
        original,
        "defineSlot",
        (memberName, groupName): SlotDef => ({
          memberName,
          slotId: slotIdFor(pluginId, seg(memberName)),
          groupName,
          kind: "slot",
          contributors: [],
        }),
      ),
      // A capability's root slot (`defineRootSlot()`, web-sdk) — a plain slot
      // under its own constructor name, so the group pass needs it spelled.
      ...parseDefineGroup(
        original,
        "defineRootSlot",
        (memberName, groupName): SlotDef => ({
          memberName,
          slotId: slotIdFor(pluginId, seg(memberName)),
          groupName,
          kind: "slot",
          contributors: [],
        }),
      ),
      ...parseDefineGroup(
        original,
        "defineDispatchSlot",
        (memberName, groupName): SlotDef => ({
          memberName,
          slotId: slotIdFor(pluginId, seg(memberName)),
          groupName,
          kind: "dispatch",
          contributors: [],
        }),
      ),
    ];
    for (const slot of fileSlots) {
      if (seen.has(slot.slotId)) continue;
      seen.add(slot.slotId);
      slots.push(slot);
    }
  }
  applyCompanions(slots, companionCalls, maskedFiles, pluginId);
  return slots;
}

/**
 * Display names for a declared slot, from the barrel's OWN top-level exports —
 * ONE shallow pass, no recursion and no sniffing, because it decides nothing:
 * the set comes from the declaration, this only spells each entry the way its
 * author wrote it (`Shell.Sidebar`, `TaskDetailSections.Section`).
 *
 * A slot exported directly is `Key.Key`; a slot inside an exported group object
 * is `ExportKey.MemberKey`. That covers a factory result assigned to an exported
 * const too, which is the case source text cannot name (its id is templated).
 */
function safeEntries(obj: Record<string, unknown>): [string, unknown][] {
  try {
    return Object.entries(obj);
  } catch (err) {
    if (err instanceof TypeError) return [];
    throw err;
  }
}

interface SlotName {
  memberName: string;
  groupName: string;
}

/**
 * Slot OBJECT → the `Group.Member` spelling a contribution site writes.
 *
 * Keyed by identity, never by id: this runs while deciding what a plugin
 * declares, and an undeclared slot (a disabled plugin's) has no id to key by.
 *
 * The names are NOT cosmetic and are NOT the declaration key. `classify-edges`
 * matches `groupName` against the head segment of a static contribution
 * reference — the literal `Shell` in `Shell.Sidebar` — to derive the SOFT
 * dependency edges a composition's optional contributors are computed from. So
 * this must stay the exported spelling even though the slot's id no longer
 * derives from it.
 */
function namesFromBarrelExports(
  mod: Record<string, unknown>,
): Map<SlotHandle, SlotName> {
  const names = new Map<SlotHandle, SlotName>();
  for (const [key, val] of safeEntries(mod)) {
    if (isSlot(val)) {
      const real = val._slot ?? val;
      if (!names.has(real))
        names.set(real, { memberName: key, groupName: key });
      continue;
    }
    if (!val || (typeof val !== "object" && typeof val !== "function"))
      continue;
    for (const [member, inner] of safeEntries(val as Record<string, unknown>)) {
      if (!isSlot(inner)) continue;
      const real = inner._slot ?? inner;
      if (!names.has(real))
        names.set(real, { memberName: member, groupName: key });
    }
  }
  return names;
}

/**
 * The slots a plugin DECLARES (`PluginDefinition.slots`) — the authoritative
 * set, the authoritative `kind` (each slot carries its own `meta`), and the
 * authoritative ID, derived from this plugin plus the declaration key.
 *
 * The id needs no runtime stamp: a facet describes SOURCE, and this tree imports
 * disabled plugins' barrels too (their slots are never declared). `Group.Member`
 * display names still come from the barrel's exports — see above for why they
 * are load-bearing rather than decorative.
 */
function collectDeclaredSlots(
  dir: string,
  pluginId: string,
  importedModules: { mod: Record<string, unknown> }[],
): SlotDef[] {
  const out: SlotDef[] = [];
  const seen = new Set<string>();
  for (const { mod } of importedModules) {
    const sources = declaredSlotSources(mod);
    if (!sources) continue;
    const names = namesFromBarrelExports(mod);
    for (const { slot, key } of collectSlots(dir, sources)) {
      const slotId = slotIdFor(pluginId, key);
      if (seen.has(slotId)) continue;
      seen.add(slotId);
      // A slot nothing exports (a pane's `Actions`) has no `Group.Member`
      // spelling; the key is the honest fallback.
      const named = names.get(slot) ?? { memberName: key, groupName: key };
      out.push({
        memberName: named.memberName,
        groupName: named.groupName,
        slotId,
        kind: slot.meta.kind,
        contributors: [],
        ...(slot.meta.companions ? { companions: slot.meta.companions } : {}),
      });
    }
  }
  return out;
}

export default createFacet<SlotDef[]>({
  def: slotsFacetDef,

  extract(ctx) {
    // Two discovery modes:
    //  - Imports present (the normal build): the plugin's own `slots: {…}`
    //    DECLARATION is the sole authoritative set, and each slot's `meta.kind`
    //    is read off the slot object. Nothing is sniffed and nothing is guessed:
    //    a slot is here because its owner said so, which is also what makes the
    //    attribution correct (it was "whichever barrel exposed it first" while
    //    this walked export graphs). The static parse still runs, but only to
    //    recover the `Group.Member` display names source text alone knows.
    //  - No imports (`skipBarrelImport` build mode): fall back to the static
    //    text parse alone. Its one blind spot is a *dynamic* slot id — an id
    //    built from a template/identifier expression rather than a string
    //    a slot with no NAME in source (one minted inside a factory, such as a
    //    pane's `Actions`) — those the barrel-import path sees instead.
    const modules = ctx.imported?.modules;
    if (modules && modules.length > 0) {
      return collectDeclaredSlots(ctx.dir, ctx.pluginId, modules);
    }
    return parseSlotsFromSource(ctx.dir, ctx.pluginId);
  },

  // The per-slot reverse index (`SlotDef.contributors`) is populated by the
  // `contributions` facet's `relate()`: it already joins slots ↔ contributions
  // (to fill `definerPluginId`) and imports `slotsFacetDef`. The reverse edge —
  // `slots/facet` importing `contributions/core` — would close a collected-dir
  // dependency cycle (`contributions` already `dependsOn` `slots`), so the join
  // lives on the single facet that legally has both in scope.

  renderDoc(data) {
    if (data.length === 0) return [];
    // A slot with no `Group.Member` spelling (its id is templated, so neither
    // the barrel exports nor source text name it) carries the id in both
    // fields — print it once rather than `id.id`.
    const labelOf = (s: (typeof data)[number]): string =>
      `\`${s.groupName === s.memberName ? s.groupName : `${s.groupName}.${s.memberName}`}\``;
    const facts: DocFact[] = [
      { folder: "web", key: "Slots", values: data.map(labelOf) },
    ];
    // Who fills each slot, one contributor per line, grouped by slot so the doc
    // can summarize a slot half the repo contributes to (`Pane.Register`) as
    // one count.
    const groups = data
      .filter((s) => s.contributors.length > 0)
      .map((s) => ({
        label: labelOf(s),
        values: s.contributors.map((id) => `${labelOf(s)} ← \`${id}\``),
      }));
    if (groups.length > 0)
      facts.push({
        folder: "web",
        key: "Slot contributors",
        noun: "contributors",
        groups,
      });
    return facts;
  },
});
