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
  description: "The equin installer: its window, and its time estimates",
  subcommands: [
    defineCliCommand<[], { pace?: string; fail?: string; notice?: boolean }>({
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
          flags: "--fail <step[:how]>",
          description:
            "Fail that step's first attempt (mise, clone, toolchain, start, build), to try the pause: plain (unknown), :sigkill (the sandbox rule, under sandbox-exec), :vanish (the security rule, with a security product running) or :quiet (a stall, past the watchdog's deadline)",
        },
        {
          flags: "--notice",
          description:
            "Have the start step report a part left out (the login services), to try the banner and Add it now",
        },
      ],
      run: () => import("./internal/window"),
    }),
    defineCliCommand<
      [],
      { from?: string[]; only?: string[]; fromJson?: boolean }
    >({
      name: "estimates",
      description:
        "Regenerate the install's per-step time estimates (installer/core/estimates.json and install.sh's copy) as medians of real installs' timing files",
      options: [
        {
          flags: "--from <dir...>",
          description:
            "Also read the install run dirs under these dirs (<run>/timing.json, else <run>/events.jsonl — runs collected from other machines)",
        },
        {
          flags: "--only <step...>",
          description:
            "Measure only these step ids; every other step's estimate is null (its measured runs predate a change to it)",
        },
        {
          flags: "--from-json",
          description:
            "Only rewrite install.sh's estimates block from the committed estimates.json",
        },
      ],
      run: () => import("./internal/estimates"),
    }),
  ],
});
