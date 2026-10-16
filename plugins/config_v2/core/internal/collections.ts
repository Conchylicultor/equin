import type { FieldsRecord } from "@plugins/fields/core";
import {
  isListFieldDef,
  type ListFieldDef,
} from "@plugins/fields/plugins/list/plugins/config/core";
import { isObjectFieldDef } from "@plugins/fields/plugins/object/plugins/config/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { computeHash } from "./config-proxy";
import type { JsonValue } from "./types";

/**
 * Called once per list INSTANCE found in the document — not once per list field.
 * A `listField` nested in another list's `itemFields` is visited once for every
 * row of the parent, each with its own `path`.
 *
 * Return a new array to replace the instance, or nothing to leave it as it is.
 */
export type ConfigListVisitor = (
  items: Record<string, unknown>[],
  field: ListFieldDef,
  /** Dotted/indexed location in the document, e.g. `categories[0].items`. */
  path: string,
) => Record<string, unknown>[] | void;

/**
 * THE walk over every `listField` instance in a config document, at any nesting
 * depth — the one definition of "where the lists are".
 *
 * A config document is a recursive structure: a `FieldsRecord` entry may be a
 * `listField` (whose `itemFields` is another `FieldsRecord`) or an `objectField`
 * (whose `subFields` is another). Every consumer that walked it one level deep
 * — id seeding, the stable-id check, the settings "modified" diff — silently
 * skipped everything below the top level and drifted apart. They all go through
 * here now.
 *
 * Pure: returns a NEW document when anything changed and the input object
 * unchanged when nothing did, copying only along the touched paths.
 *
 * **A list is visited BEFORE its rows are recursed into**, and that order is
 * load-bearing, not incidental. A row's synthesized `auto-` id is a hash of the
 * row's content, and that content contains the row's own nested arrays — so
 * seeding nested ids first would change the hash of every enclosing row, and
 * re-mint the top-level ids of every descriptor that has a nested list. Visiting
 * outermost-first keeps those hashes exactly what they were.
 *
 * Container-ness is a closed two-member set — a field holds either one nested
 * document (`objectField`) or an array of them (`listField`) — so it is named
 * here in code rather than opened as a slot. A third container field type would
 * be the moment to promote it to a marker on `FieldDef`.
 */
export function mapConfigLists(
  doc: Record<string, unknown>,
  fields: FieldsRecord,
  visit: ConfigListVisitor,
): Record<string, unknown> {
  return mapFields(doc, fields, visit, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapFields(
  doc: Record<string, unknown>,
  fields: FieldsRecord,
  visit: ConfigListVisitor,
  prefix: string,
): Record<string, unknown> {
  let result = doc;
  // Copy-on-first-write: an untouched subtree returns its input by reference, so
  // a caller can tell "nothing changed here" by identity.
  const writable = () => (result === doc ? (result = { ...doc }) : result);

  for (const [key, field] of Object.entries(fields)) {
    const value = doc[key];
    const path = prefix ? `${prefix}.${key}` : key;

    if (isListFieldDef(field)) {
      // A key the document omits, or holds as a non-array, is left to schema
      // default-backfill — there is no list instance here to visit.
      if (!Array.isArray(value)) continue;
      const original = value as Record<string, unknown>[];

      const visited = visit(original, field, path) ?? original;
      let items = visited;
      let copied = false;

      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        // A malformed row (null, a string, a nested array) has no sub-document
        // to descend into. The visitor already saw it and decided what to do.
        if (!isPlainObject(item)) continue;
        const next = mapFields(
          item,
          field.itemFields,
          visit,
          `${path}[${index}]`,
        );
        if (next === item) continue;
        if (!copied) {
          items = [...items];
          copied = true;
        }
        items[index] = next;
      }

      if (copied || visited !== original) writable()[key] = items;
      continue;
    }

    if (isObjectFieldDef(field)) {
      if (!isPlainObject(value)) continue;
      const next = mapFields(value, field.subFields, visit, path);
      if (next !== value) writable()[key] = next;
    }
  }

  return result;
}

// Normalize every listField collection in a config document, AT EVERY NESTING
// DEPTH: array position is the canonical order, so we drop any legacy `rank`
// (migrating stored order by it first) and synthesize a stable id for id-less
// rows of NON-stable lists.
//
// The renderer keys on `item.id` at every depth (React key, dnd-kit sortable id,
// and the `item.id === updated.id` edit predicate), so a nested row without one
// silently breaks reorder and makes editing one id-less row rewrite all of them.
// `mapConfigLists` is the recursive walk; this is only the per-list rule.
//
// Called on read (reloadValues) and on write (setConfig / mergeConflictByPath) —
// by the server, and by a demo scope's in-browser backend (config_v2/web) —
// idempotent, and returns a NEW doc object (never mutates the input).
export function normalizeCollectionItems(
  doc: Record<string, unknown>,
  fields: FieldsRecord,
): Record<string, unknown> {
  return mapConfigLists(doc, fields, (arr, field) => {
    // Legacy-rank migration: a document written before array-order-is-canonical
    // carries a fractional `rank` string on each item. Sort by it ONCE so array
    // order becomes authoritative, then the `.map` below drops `rank` from every
    // item — idempotent (after the first read+write the file is array-ordered and
    // rank-free). Items without any `rank` keep their array order (stable sort).
    let items = arr;
    if (items.some((it) => typeof it.rank === "string")) {
      items = [...items].sort((a, b) => {
        const ra = typeof a.rank === "string" ? a.rank : null;
        const rb = typeof b.rank === "string" ? b.rank : null;
        if (ra === null || rb === null) return 0;
        return Rank.compare(Rank.from(ra), Rank.from(rb));
      });
    }

    return items.map((item, index) => {
      const out = { ...item };
      // Array position is the canonical order now — the legacy rank is dropped.
      delete out.rank;

      // A `stableIdentity` list's ids are DURABLE EXTERNAL KEYS owned by the
      // consumer (e.g. the DataView views list keys per-view saved order), so we
      // never synthesize them — an id-less row is left exactly as authored.
      if (field.stableIdentity) return out;

      if (!out.id || typeof out.id !== "string") {
        // Deterministic id so repeated reads of the same (override-less) document
        // are idempotent. A random uuid here changes on every read — including the
        // unconditional watcher reconcile — which churns the React `key={item.id}`,
        // remounts list rows, and wipes any in-progress field edit. Seed the id from
        // the item's stable content + position; once the user edits, the value is
        // persisted to an override and read back verbatim.
        //
        // `content` still holds this row's nested arrays exactly as authored —
        // `mapConfigLists` seeds nested ids only AFTER this returns, which is what
        // keeps the hash identical to the pre-nesting one.
        const { id: _id, ...content } = out;
        out.id = `auto-${computeHash([index, content] as unknown as JsonValue)}`;
      }
      return out;
    });
  });
}
