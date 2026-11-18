import { SOURCE_REPO } from "@plugins/framework/plugins/product-name/core";
import {
  GitHubEvents,
  workflowFileOf,
} from "@plugins/integrations/plugins/github-events/server";
import { parseReleaseTag } from "@plugins/upstream/plugins/release/core";
import { RELEASE_WORKFLOW } from "../../core";

const workflow = workflowFileOf(RELEASE_WORKFLOW);

/**
 * The release workflow of the product's repo, and its Releases: a failed run
 * is reported, and the publisher's releases row shows what GitHub published.
 * A failed release tag's report names the re-publish.
 */
export const releaseWorkflowWatch = GitHubEvents.Watch({
  repo: SOURCE_REPO,
  workflow,
  releases: true,
  // installer-release.yml's `run-name` is the ref it builds.
  headIsRunName: true,
  remedy: ({ repo, head }) =>
    parseReleaseTag(head).kind === "release"
      ? [
          `Once fixed, re-publish the release: \`gh workflow run ${workflow} -R ${repo} -f ref=${head} -f replace=true\`.`,
        ]
      : [],
});
