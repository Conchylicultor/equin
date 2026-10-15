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
 * The rewrites of a DataView's saved `views` rows, threaded into every per-id
 * `viewsDescriptor` (web and server alike). ONE identity-stable module
 * constant, like the sibling `extraFields` (the descriptor cache keys by id).
 */
export const viewMigrations: readonly ConfigMigration[] = [treeViewToTable];
