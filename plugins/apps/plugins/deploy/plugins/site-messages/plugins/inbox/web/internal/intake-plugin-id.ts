import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";

/**
 * The plugin whose presence in a composition means the deployed site takes
 * messages. Named by id because membership is a question about the plugin
 * graph; `intake-plugin-id.test.ts` pins that the id still names that
 * plugin's folder, so a move or rename fails a test instead of hiding the
 * section.
 */
export const INTAKE_PLUGIN_ID = asPluginId("apps.deploy.site-messages.intake");
