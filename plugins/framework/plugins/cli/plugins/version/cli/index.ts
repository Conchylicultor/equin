import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `./equin version status|cut` — releases: the checkpoints a clone is told
 * about and updates to, instead of every commit on upstream's main.
 *
 * A GROUP, like `upstream`: it routes and never runs, so bare `version` prints
 * its subcommand help by construction. (`release` was taken: that name is the
 * artifact packaging in `plugins/release`.)
 */
export default defineCliCommand({
  name: "version",
  description:
    "Releases: which one local main is on, the newest upstream has, and cutting a new one",
  subcommands: [
    defineCliCommand<[], object>({
      name: "status",
      description:
        "Print the release local main is on and the newest release upstream has cut (fetching upstream's " +
        "release tags). On the checkout that publishes releases, the newest one it has cut. Reads only.",
      run: () => import("./status"),
    }),
    defineCliCommand<[], { message?: string; dryRun?: boolean }>({
      name: "cut",
      description:
        "Cut a release: tag main's HEAD with an annotated `v<YYYY.MM.DD>` tag (`.2`, `.3`… for another the same " +
        "UTC day) and push it to the publish remote. Run in main's checkout. Refused unless this checkout can " +
        "publish, main's HEAD is pushed, what main serves is that HEAD, and main's last build of it passed — so " +
        "a release is always a main that built and passed its checks.",
      options: [
        {
          flags: "-m, --message <text>",
          description:
            "The tag's one-line message (default: `<product> <version>`).",
        },
        {
          flags: "--dry-run",
          description:
            "Run every check and print the tag that would be cut, creating and pushing nothing.",
        },
      ],
      run: () => import("./cut"),
    }),
  ],
});
