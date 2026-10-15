import { buildViewConfigRegistrations } from "@plugins/primitives/plugins/data-view/plugins/view-core/server";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { dataViews } from "../../shared/data-views.generated";
import { extraFields } from "./descriptors";
import { viewMigrations } from "../../shared/view-migrations";

/**
 * One `ConfigV2.Register` contribution per DataView id, each planted under its
 * OWN defining plugin (the consuming plugin's tree; server-side identity,
 * independent of web). The generic engine (view-core) builds the registrations
 * from data-view's own manifest entries (each carrying its `pluginId`).
 *
 * Built here (not in the barrel) so `server/index.ts` stays loop-free per the
 * barrel-purity rule.
 */
export const dataViewConfigRegistrations = buildViewConfigRegistrations(
  dataViews.map((v) => ({ id: v.id, pluginId: asPluginId(v.pluginId) })),
  extraFields,
  viewMigrations,
);
