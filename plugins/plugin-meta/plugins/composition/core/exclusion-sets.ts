import {
  ALL_EXCLUSIONS_ID,
  BASE_EXCLUSIONS_ID,
} from "@plugins/infra/plugins/namespace/core";
import { parseEntryPattern } from "@plugins/plugin-meta/plugins/closure/plugins/entry-pattern/core";
import type { CompositionManifestItem } from "./manifest-map";

/**
 * Whether the registry's exclusion sets hold together — the manifest-SHAPE
 * rules of the rows `flattenManifest` folds into other rows. A row of category
 * `exclusions` is an exclusion set: every other row inherits exactly one (its
 * `exclusions` field; empty: `all-exclusions`), so the sets decide what is in
 * no app. Pure over the stored items, so `composition-closure` and its tests
 * read one rule.
 */
export type ExclusionSetsVerdict =
  { kind: "ok" } | { kind: "error"; message: string; hint: string };

const error = (message: string, hint: string): ExclusionSetsVerdict => ({
  kind: "error",
  message,
  hint,
});

export function checkExclusionSets(
  items: readonly CompositionManifestItem[],
): ExclusionSetsVerdict {
  // 1. The reserved sets. A row of category `exclusions` is an EXCLUSION
  //     SET: `flattenManifest` folds one into every manifest — the set its
  //     `exclusions` field names, else `all-exclusions` — so the sets decide
  //     what is in no app at all. Two are reserved and must exist exactly
  //     once, as sets: `base-exclusions` (the repo-wide removals every set
  //     reaches) and `all-exclusions` (the default). Delete either and its
  //     exclusions silently come back; duplicate one and which copy is folded
  //     in depends on registry order — same reason main's row is pinned.
  const setItems = items.filter((i) => i.category === "exclusions");
  const setNames = new Set(setItems.map((i) => i.name));
  for (const [id, role] of [
    [
      BASE_EXCLUSIONS_ID,
      "the repo-wide exclusion set — the negatives every exclusion set extends, so no composition can drop them",
    ],
    [
      ALL_EXCLUSIONS_ID,
      "the DEFAULT exclusion set — what a composition inherits when its `exclusions` field names none",
    ],
  ] as const) {
    const rows = items.filter((i) => i.id === id);
    if (rows.length !== 1) {
      return error(
        `expected exactly one composition with id "${id}", found ${rows.length}`,
        `"${id}" is ${role}. It must exist exactly once. Restore it in plugins/plugin-meta/plugins/composition/core/config.ts.`,
      );
    }
    if (rows[0]!.category !== "exclusions") {
      return error(
        `composition "${id}" has category "${rows[0]!.category}", not "exclusions"`,
        `"${id}" is ${role}; only a row of category \`exclusions\` is held to the exclusion-set rules. Set its category back to "exclusions".`,
      );
    }
  }
  const itemByName = new Map(items.map((i) => [i.name, i]));

  // 2. Every exclusion set is well-formed. Its bundle is empty by
  //     construction (negatives only), so it is never served, has no home
  //     and no unlisted apps, asserts no `excludes`, and inherits no other
  //     set (its own entries ARE its exclusions: `manifestItemToManifest`
  //     makes a set name itself). It may only EXCLUDE — every entry point a
  //     negative, `selectedContributors` empty: a positive on a row folded
  //     into other rows would silently force a plugin into every bundle that
  //     inherits it, which is `served-baseline`'s job, done through
  //     `extends`, where the row that opted in shows it. It `extends` only
  //     other sets, and reaches `base-exclusions` through them, so no
  //     composition can choose its way out of the repo-wide removals.
  for (const set of setItems) {
    const name = set.name;
    if (set.serve !== "off") {
      return error(
        `exclusion set "${name}" has \`serve: "${set.serve}"\``,
        `An exclusion set carries only negatives, so its own bundle is empty — there is nothing to serve. Set it back to \`"off"\`.`,
      );
    }
    if (set.home !== "" || set.unlisted.length > 0) {
      return error(
        `exclusion set "${name}" declares a \`home\` or \`unlisted\` apps`,
        "An exclusion set is never deployed — clear its `home` and `unlisted`.",
      );
    }
    if (set.excludes.length > 0) {
      return error(
        `exclusion set "${name}" declares \`excludes\``,
        "An exclusion set has no bundle to keep disjoint — clear its `excludes`; a composition asserts its own self-containment.",
      );
    }
    if (set.exclusions !== "") {
      return error(
        `exclusion set "${name}" names an exclusion set of its own ("${set.exclusions}")`,
        "An exclusion set's exclusions are its own entries and its `extends` chain — clear its `exclusions` field; to build on another set, `extends` it.",
      );
    }
    for (const entry of set.entryPoints) {
      if (parseEntryPattern(entry).negate) continue;
      return error(
        `exclusion set "${name}" has a positive entry point "${entry}"`,
        `An exclusion set is folded into every composition that inherits it, so it may only EXCLUDE — every entry must be a negative (\`!<id>\` or \`!<id>.**\`). A positive here would silently force "${entry}" into every bundle that inherits "${name}"; to force a plugin in, add it to the \`served-baseline\` pack and \`extends\` that from the compositions that want it.`,
      );
    }
    if (set.selectedContributors.length > 0) {
      return error(
        `exclusion set "${name}" selects ${set.selectedContributors.length} contributor(s): ${set.selectedContributors.join(", ")}`,
        `An exclusion set is folded into every composition that inherits it, so a contributor selected here is selected everywhere — the same silent force-in a positive entry point would be. Keep \`selectedContributors\` empty; put shared opt-ins in the \`served-baseline\` pack, which compositions reference through \`extends\`.`,
      );
    }
    const notSets = set.extends.filter((ref) => !setNames.has(ref));
    if (notSets.length > 0) {
      return error(
        `exclusion set "${name}" extends ${notSets.map((r) => `"${r}"`).join(", ")}, which ${notSets.length === 1 ? "is not an exclusion set" : "are not exclusion sets"}`,
        "An exclusion set may only `extends` other exclusion sets (category `exclusions`): anything else would fold its positives — or its own inherited set — into every composition that inherits this one.",
      );
    }
    const reached = new Set<string>();
    const walk = (n: string): void => {
      if (reached.has(n)) return;
      reached.add(n);
      for (const ref of itemByName.get(n)?.extends ?? []) walk(ref);
    };
    walk(name);
    if (!reached.has(BASE_EXCLUSIONS_ID)) {
      return error(
        `exclusion set "${name}" does not include "${BASE_EXCLUSIONS_ID}"`,
        `Every exclusion set must reach "${BASE_EXCLUSIONS_ID}" through \`extends\`, so a composition choosing it still leaves out what the repo has decided is in no app. Add \`extends: ["${BASE_EXCLUSIONS_ID}"]\` (or a set that extends it).`,
      );
    }
  }

  // 3. Every other row inherits a real exclusion set, and only through its
  //     `exclusions` field: a name there must be a set (an unknown or
  //     non-set name would fold nothing, or fold a row's positives into it),
  //     and `extends` never names a set — that would be a second, silent
  //     spelling of the choice.
  for (const item of items) {
    if (item.category === "exclusions") continue;
    if (item.exclusions !== "" && !setNames.has(item.exclusions)) {
      return error(
        `composition "${item.name}" names "${item.exclusions}" as its exclusion set, which ${itemByName.has(item.exclusions) ? "is not an exclusion set (category `exclusions`)" : "is no composition"}`,
        `\`exclusions\` names the exclusion set this row inherits — a row of category \`exclusions\` (${[...setNames].map((n) => `"${n}"`).join(", ")}). Leave it empty for the default, "${ALL_EXCLUSIONS_ID}".`,
      );
    }
    const viaExtends = item.extends.filter((ref) => setNames.has(ref));
    if (viaExtends.length > 0) {
      return error(
        `composition "${item.name}" extends the exclusion set(s) ${viaExtends.map((r) => `"${r}"`).join(", ")}`,
        "A composition inherits exactly one exclusion set, chosen by its `exclusions` field (empty: the default). Drop it from `extends` and name it in `exclusions` instead.",
      );
    }
  }
  return { kind: "ok" };
}
