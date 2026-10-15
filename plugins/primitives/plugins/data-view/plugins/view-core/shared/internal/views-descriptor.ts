import { defineConfig } from "@plugins/config_v2/core";
import type {
  ConfigDescriptor,
  ConfigMigration,
} from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";
import { listField } from "@plugins/fields/plugins/list/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { iconField } from "@plugins/fields/plugins/icon/plugins/config/core";
import { variantField } from "@plugins/fields/plugins/variant/plugins/config/core";

/**
 * The ONE `views` config descriptor instance per consumer surface id.
 *
 * A consumer's named view-instances (Notion-style "Cards / All / Board") live in
 * a per-surface config_v2 `views` list — a git-committable, per-app-scopable
 * list of `{ name, view }` rows. Each row's `view` is the polymorphic `variant`
 * field: its value is `{ type, ...options }`, the discriminant `type` selecting
 * the view-type and the rest carrying that type's saved options. Storage is
 * opaque/passthrough at the config boundary (the variant field validates only
 * `type`); per-type validation of the options blob happens downstream on the web
 * against the chosen view-type's schema (this shared module is server-imported
 * and carries no per-type registry — that is injected by the consumer's own UI).
 *
 * `useConfig`/`useSetConfig` match a config registration by descriptor
 * **reference identity** (`reg.descriptor === descriptor`), so the descriptor
 * passed to `ConfigV2.WebRegister` and the one later read via `useConfig` MUST be
 * the same object. This module-level cache builds-once-and-reuses per id —
 * exactly the `reorder/web/internal/descriptors.ts` precedent. (Reference
 * stability only matters within a runtime; the server's identity is independent.)
 *
 * Engine-private (`shared/`): only the view-core web + server barrels import this
 * indirectly. The server build pulls no web code — `variantField` is called
 * without its web-only `useVariants` registry, so the descriptor stays
 * server-safe.
 *
 * **Generic extension point (`extraFields`).** A consumer may inject its own
 * sibling config fields next to `views` — opaque to the engine, which never
 * names or reads them. This preserves the seam: the engine still does not know
 * about `sort`/`filter`/presets; the consumer declares the field and reads it
 * back itself (data-view injects `sortPresets`). The internal id cache is
 * belt-and-suspenders: the canonical reference holders are the maps built once
 * in the consumer (`buildViewDescriptors` web; the per-entry server
 * registrations), and a single consumer passes one stable `extraFields`
 * module-constant per runtime, so keying the cache by id alone keeps identity.
 */
const cache = new Map<string, ConfigDescriptor>();

export function viewsDescriptor(
  id: string,
  extraFields?: FieldsRecord,
  migrations?: readonly ConfigMigration[],
): ConfigDescriptor {
  let descriptor = cache.get(id);
  if (!descriptor) {
    descriptor = defineConfig({
      // The id IS the descriptor name — one distinct store path per surface
      // (`config/primitives/data-view/<id>.jsonc`), mirroring how reorder's
      // `slotId` is its directive name. Every id is registered (under the
      // consumer's plugin) so `useConfig` never throws.
      name: id,
      scope: "app",
      // Consumer-owned rewrites of the saved rows (opaque here, like
      // `extraFields`): a stable module-constant per runtime, for the same
      // cache reason.
      migrations,
      source: "view",
      // Config is the SINGLE SOURCE OF TRUTH for a surface's views — there is no
      // code synthesis of default view-instances, so a DataView whose config has
      // zero rows renders a "No views configured" placeholder at runtime.
      // `./singularity build` seeds the override; these lines ride along as the
      // file's own comments and are what `config:overrides-authored` echoes back
      // when the seeded values have not yet been reviewed.
      requiresAuthoredOverride: {
        guidance: [
          'Author "views" as terse { name, view } rows — one per view-type the',
          "call site's `views={[…]}` whitelist enables, plus extra named",
          "sort/filter views where the domain warrants one.",
          '"view" is { type, sort?, filter?, …opts }; "sort" is a list of',
          '{ fieldId, direction }; "filter" is a FilterGroup tree.',
          "Give every row an explicit bare-slug id — it keys the saved per-view",
          "row order, so a derived one would orphan it on rename.",
          "Worked example: config/apps/sonata/library/sonata.library.jsonc",
        ],
      },
      fields: {
        views: listField({
          label: "Views",
          // View ids key `data_view_row_order` (per-view saved manual order), so
          // they must be stable/explicit — not content+index-derived seeds.
          stableIdentity: true,
          itemFields: {
            name: textField({ label: "Name" }),
            // The switcher glyph; null (the default) = the view-type's icon.
            icon: iconField({ label: "Icon" }),
            view: variantField({ label: "View" }),
          },
        }),
        // Consumer-injected sibling fields (opaque to the engine). The
        // `extraFields` is a stable module-constant per id, so the per-id cache
        // never returns a descriptor built with a different field set.
        ...extraFields,
      },
    });
    cache.set(id, descriptor);
  }
  return descriptor;
}
