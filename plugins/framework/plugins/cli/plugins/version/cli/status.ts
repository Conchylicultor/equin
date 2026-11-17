import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  currentRelease,
  fetchUpstreamStatus,
  OWN_RELEASE_NAMESPACE,
  UPSTREAM_BRANCH,
  upstreamReleaseNamespace,
} from "@plugins/upstream/core";
import { releaseVersion } from "@plugins/upstream/plugins/release/core";

function named(tag: string | null): string {
  return tag === null ? "no release" : releaseVersion(tag);
}

/**
 * `./equin version status` — the release local `main` is on, and the newest
 * one upstream has cut. Reads only: it fetches upstream's main and release
 * tags (the same `fetchUpstreamStatus` the app's daily check runs) and moves
 * nothing of yours.
 */
const run: CliAction<[], object> = async () => {
  const root = await getWorktreeRoot();
  const status = await fetchUpstreamStatus(root);
  switch (status.kind) {
    case "no-upstream": {
      // The author's checkout: its own main IS what clones update to.
      const own = await currentRelease(
        root,
        UPSTREAM_BRANCH,
        OWN_RELEASE_NAMESPACE,
      );
      console.log(
        status.reason === "is-publisher"
          ? `This checkout publishes the releases. Newest cut on main: ${named(own)}.`
          : `On ${named(own)}. No remote, so there is no upstream to update from.`,
      );
      return;
    }
    case "unreachable": {
      // The releases fetched last time, still on disk.
      const own = await currentRelease(
        root,
        UPSTREAM_BRANCH,
        upstreamReleaseNamespace(status.remote),
      );
      console.error(
        `On ${named(own)}. Could not reach ${status.remote} (${status.url}) to ask for a newer one:\n  ${status.detail}`,
      );
      process.exit(1);
      return;
    }
    case "no-release":
      console.log(
        `On ${named(status.current)}. ${status.remote} (${status.url}) has cut no release yet.`,
      );
      return;
    case "current":
      console.log(
        `On ${releaseVersion(status.release)}, the newest release of ${status.remote} (${status.url}).`,
      );
      return;
    case "behind":
      console.log(
        `On ${named(status.current)}. ${status.remote} (${status.url}) has released ${releaseVersion(status.latest)}.\n` +
          `Run \`./equin upstream merge\` in a worktree to bring it in.`,
      );
      return;
  }
};

export default run;
