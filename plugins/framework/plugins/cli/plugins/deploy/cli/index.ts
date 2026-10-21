/**
 * `./singularity deploy converge|ship` — the two verbs over a deployment.
 *
 * **converge** makes a host serve a composition: run user, dir layout, the
 * `env` EnvironmentFile, Caddy, the systemd unit, the firewall.
 * **ship** puts a bundle on it and activates it behind a health gate.
 *
 * Design: `research/2026-07-29-global-composition-production-deployment.md`
 * (D3 + D4). Three properties of that design shape this command:
 *
 * - **Nothing about the install is authored.** Every path, user and unit name
 *   comes from `deriveInstall` (`deployments/core/derive.ts`); a path spelled
 *   twice is a path that eventually disagrees with itself. The unit *template*
 *   is `deriveInstall(SYSTEMD_INSTANCE)` — the same function of `"%i"` — so
 *   the template and the real instance's paths cannot drift.
 * - **Converge is one generated script, not a checked-in `bootstrap.sh`.** It
 *   is a pure function of the deployment row, uploaded and run as the server's
 *   LOGIN user (root — it creates users and writes `/etc`); the run user is a
 *   different, unprivileged, derived one, and that split is the whole point.
 *   There is no file on the box a human is expected to edit.
 * - **Refusals come before any host mutation**, each named. A server we have
 *   never reached, a non-Debian host, a composition carrying owner data behind
 *   a public hostname, or a closure needing `infra/secrets` are all refused by
 *   name rather than compared against a null.
 *
 * ### Where the CLI reads its inputs, and why the two transports differ
 *
 * - The **deployment record** goes over HTTP to this checkout's own backend,
 *   through the endpoint contracts the plugin publishes in `core/` *for this
 *   consumer*. That keeps `assertKnownComposition`, the hostname/port
 *   validation and the unique-constraint → 409 mapping as the single writer of
 *   that table. (It is also the only option: the deployments *server* barrel
 *   eagerly imports the backend's server graph — `config_v2/server` registers
 *   its live values and reads its user layer through host services only a
 *   booted backend provides (the desktop's `config_v2#machine` resolves the
 *   config dir from the process's runtime namespace, which a CLI process does
 *   not have) — so a CLI cannot import that table.)
 * - The **server row + its health row** are read straight from the DB, because
 *   they have no core-level wire contract: `servers`/`health` keep theirs in
 *   plugin-private `shared/`, and the TOFU-pinned `hostKeyLine` is
 *   deliberately withheld from the wire. The CLI needs that pin — connecting
 *   with `hostKey: { mode: "learn" }` would silently accept a changed host key,
 *   i.e. weaker verification than the probe already established.
 *
 * Both resolve against `checkoutNamespace(REPO_ROOT)` — the namespace this
 * CHECKOUT owns, minted from git — so the CLI acts on exactly the namespace
 * whose Deploy app you are looking at: bare on a checkout that is `main`, or the
 * spawning backend's own worktree when the D5 UI shells out (which spawns the
 * child with `cwd` at that same checkout).
 */
import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

export default defineCliCommand({
  name: "deploy",
  description:
    "Converge a host to serve a composition, and ship bundles to it (Deploy app deployments)",
  subcommands: [
    defineCliCommand<[string], { server: string }>({
      name: "converge",
      description:
        "Make a server serve a composition: run user, dir layout, env file, Caddy site, systemd unit, firewall. Idempotent — re-run to repair drift.",
      arguments: [
        {
          name: "<composition>",
          description: "Composition name (as in the `compositions` config)",
        },
      ],
      options: [
        {
          flags: "--server <server>",
          description: "Registered deploy server (id, or its name)",
          required: true,
        },
      ],
      run: () => import("./converge"),
    }),
    defineCliCommand<[string], { server: string; release?: string }>({
      name: "ship",
      description:
        "Upload a release bundle to a converged host and activate it behind a health gate (reverts on failure)",
      arguments: [
        {
          name: "<composition>",
          description: "Composition name (as in the `compositions` config)",
        },
      ],
      options: [
        {
          flags: "--server <server>",
          description: "Registered deploy server (id, or its name)",
          required: true,
        },
        {
          flags: "--release <run-id>",
          description:
            "Release run to ship (default: the `latest-<platform>` symlink for <composition>-web, which only a packed run ever claims)",
        },
      ],
      run: () => import("./ship"),
    }),
  ],
});
