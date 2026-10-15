import { defineDetailSections } from "@plugins/primitives/plugins/detail-sections/web";

/**
 * The sections of one deployment's pane. The pane itself owns no content — the
 * overview (this plugin) and the remote-deploy surface with its log output (the
 * `remote-deploy` sibling) are all contributions, exactly as
 * `CompositionDetail` is in Studio.
 *
 * The PHASES of a deploy are deliberately not a slot: converge → build → ship is
 * a closed, ordered sequence the server runs, and the UI only reports which leg
 * is live. The sections are the open set.
 */
export const DeploymentDetail = defineDetailSections<{
  deploymentId: string;
}>();
