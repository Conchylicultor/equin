import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `./equin deps …` — prewarm, inspect, clean up and upgrade optional
 * dependencies from a terminal. `list`, `install` and `remove` read the
 * generated declaration registry and run the host-only engine directly — no
 * backend is booted; install uses the same `ensureDep` a supervised job does.
 * `upgrade` boots this checkout's backend in `exec` mode, because updaters are
 * still server contributions.
 */
export default defineCliCommand({
  name: "deps",
  description:
    "Optional dependencies installed on demand (Python envs, …): list, install, remove, upgrade",
  subcommands: [
    defineCliCommand({
      name: "list",
      description:
        "Every declared dependency with its state on this machine (absent / installing / ready / failed), size and identity",
      run: () => import("./internal/list"),
    }),
    defineCliCommand<[string], { json?: boolean }>({
      name: "install",
      description:
        "Install a dependency now (a no-op when it is already installed at its current identity); waits for another process installing it",
      arguments: [{ name: "<id>", description: "The dependency's id" }],
      options: [
        {
          flags: "--json",
          description:
            "Print one JSON line { id, identity, dir } on stdout once it is ready (progress goes to stderr) — for host code that cannot import the deps engine",
        },
      ],
      run: () => import("./internal/install"),
    }),
    defineCliCommand<[string]>({
      name: "remove",
      description:
        "Remove a dependency's install at its current identity, back to absent (refused while it is being installed)",
      arguments: [{ name: "<id>", description: "The dependency's id" }],
      run: () => import("./internal/remove"),
    }),
    defineCliCommand<[string | undefined], { only?: string }>({
      name: "upgrade",
      description:
        "Move updaters' locks (mise, uv, …) to the newest releases, proving it first: the full check and test " +
        "suites plus the moved inputs' smoke tests run before and after the move, and a failure only the new " +
        "releases have — twice — is a regression, which puts every lock back. With no updater named, every " +
        "updater moves at once behind ONE baseline and ONE candidate run (receipt deps-upgrade.json); naming one " +
        "moves only it (deps-upgrade-<updater>.json). Receipts land in the worktree data dir. Refuses to run in " +
        "the main checkout. Takes about as long as two full check + test runs.",
      arguments: [
        {
          name: "[updater]",
          description:
            "The updater's id (mise, uv, …); omit to upgrade every updater together",
        },
      ],
      options: [
        {
          flags: "--only <names>",
          description:
            "Comma-separated names to consider (default: everything outdated); needs an updater. Use it to find which one a regression comes from.",
        },
      ],
      run: () => import("./internal/upgrade"),
    }),
  ],
});
