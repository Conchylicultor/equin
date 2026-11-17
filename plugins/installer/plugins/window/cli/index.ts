import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `./equin installer window` — build the installer window from this checkout
 * and open it over a DRY RUN of this checkout's install.sh: the real window,
 * the real process model (events on fd 3, decisions on fd 4), a scripted
 * install that touches nothing. Never a real install: install.sh run from a
 * checkout installs THAT checkout, which on a developer's machine would
 * re-register the running gateway from a worktree.
 */
export default defineCliCommand({
  name: "installer",
  description: "The equin installer window",
  subcommands: [
    defineCliCommand<[], { pace?: string; fail?: string }>({
      name: "window",
      description:
        "Build the installer window and open it over a dry run of this checkout's install.sh (nothing is installed)",
      options: [
        {
          flags: "--pace <seconds>",
          description: "Seconds between the dry run's lines (default 0.4)",
          defaultValue: "0.4",
        },
        {
          flags: "--fail <step>",
          description:
            "Fail that step's first attempt (tools, mise, clone, toolchain, start, build), to try Try again / Quit",
        },
      ],
      run: () => import("./internal/window"),
    }),
  ],
});
