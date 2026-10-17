import {
  defineConfigMigration,
  type ConfigMigration,
  type JsonValue,
} from "@plugins/config_v2/core";

type JsonObject = { [key: string]: JsonValue };
const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Every saved tree view becomes a nested table in outline presentation — the
 * tree-table plan's P4 (`research/2026-10-13-global-tree-table.md`): a tree is
 * a table with no columns, and the table carries every tree option.
 *
 * A row's `view: { type: "tree", …opts }` is rewritten to
 * `{ type: "table", presentation: "outline", …opts }` (in that key order): every other key (`sort`,
 * `filter`, `groupBy`, `filterScope`, `visibleFields`, `hideWhenEmpty`, …) is
 * carried over unchanged, so the view keeps what it shows and how; a row with
 * no picked `icon` gets the tree's (`account-tree`), so its switcher tab keeps
 * its glyph. Any other
 * row — and a document already in the new shape — is returned as is
 * (idempotent; a table row is never touched).
 */
export const treeViewToTable = defineConfigMigration({
  id: "tree-view-to-table",
  apply: (doc) => {
    if (!isObject(doc) || !Array.isArray(doc.views)) return doc;
    let changed = false;
    const views = doc.views.map((row) => {
      if (!isObject(row) || !isObject(row.view) || row.view.type !== "tree") {
        return row;
      }
      changed = true;
      // `type`, then `presentation`, then the rest in their order: the shape
      // the committed rows are hand-edited to. A config's hash is over its
      // serialized JSON, key order included, so a user origin migrated here
      // must serialize exactly as the new committed origin propagates —
      // otherwise every saved override of these surfaces turns stale (a
      // conflict whose origin wins, hiding the user's own views).
      const rest = Object.fromEntries(
        Object.entries(row.view).filter(([key]) => key !== "type"),
      );
      return {
        ...row,
        // A row with no picked icon showed the tree type's glyph in the view
        // switcher; it keeps it rather than turning into a table's.
        ...(row.icon == null ? { icon: "account-tree" } : {}),
        view: { type: "table", presentation: "outline", ...rest },
      };
    });
    return changed ? { ...doc, views } : doc;
  },
});

/**
 * Every saved `visibleFields` list becomes a `properties` list — the Properties
 * fix (`research/2026-10-17-primitives-data-view-properties-keep-order.md`):
 * `visibleFields` held only the VISIBLE ids, so a hidden field had no position
 * and came back at the end of its band; `properties` holds every field in order,
 * each shown unless `hidden: true`.
 *
 * `visibleFields: ["a", "b"]` is rewritten to
 * `properties: [{ "id": "a" }, { "id": "b" }]` AT THE SAME KEY POSITION (the
 * config hash is over the serialized JSON, so a migrated user origin must
 * serialize exactly as the rewritten committed row does). Lossless with no
 * field catalog: under `properties` a field the list does not name is hidden,
 * which is exactly what absence from `visibleFields` meant. A non-array
 * `visibleFields` (which always read as unconfigured) is dropped. A row without
 * the key — and a document already migrated — is returned as is (idempotent).
 */
export const visibleFieldsToProperties = defineConfigMigration({
  id: "visible-fields-to-properties",
  apply: (doc) => {
    if (!isObject(doc) || !Array.isArray(doc.views)) return doc;
    let changed = false;
    const views = doc.views.map((row) => {
      if (
        !isObject(row) ||
        !isObject(row.view) ||
        !("visibleFields" in row.view)
      ) {
        return row;
      }
      changed = true;
      const view: JsonObject = {};
      for (const [key, value] of Object.entries(row.view)) {
        if (key !== "visibleFields") view[key] = value;
        else if (Array.isArray(value)) {
          view.properties = value.map((id) => ({ id }));
        }
      }
      return { ...row, view };
    });
    return changed ? { ...doc, views } : doc;
  },
});

/**
 * The rewrites of a DataView's saved `views` rows, threaded into every per-id
 * `viewsDescriptor` (web and server alike). ONE identity-stable module
 * constant, like the sibling `extraFields` (the descriptor cache keys by id).
 */
export const viewMigrations: readonly ConfigMigration[] = [
  treeViewToTable,
  visibleFieldsToProperties,
];
