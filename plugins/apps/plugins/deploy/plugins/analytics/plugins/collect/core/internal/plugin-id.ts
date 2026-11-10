import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";

/**
 * This plugin's own id: the plugin whose presence in a composition means the
 * deployed site records visits. Named by id because membership is a question
 * about the plugin graph (the deploy app's tabs ask whether a deployment's
 * closure includes it); `plugin-id.test.ts` pins that the id still names this
 * folder, so a move or rename fails a test instead of hiding every tab.
 */
export const COLLECT_PLUGIN_ID = asPluginId("apps.deploy.analytics.collect");

/**
 * The one event every section-reach records (`useSectionReach` on the web
 * side): `section_reach`, its `section` prop naming which — `<page>/<key>`
 * (`landing/hero`). In core so a reader of the hits (the Sessions tab's
 * timeline) names the same event the tracker writes.
 */
export const SECTION_REACH_EVENT = "section_reach";
/** The prop of {@link SECTION_REACH_EVENT} naming the section. */
export const SECTION_REACH_PROP = "section";
