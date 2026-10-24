import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

const DEFAULT_PORT = 9100;

/**
 * The launcher a packaged app ships with: one process that brings up a gateway,
 * an embedded Postgres and the app's own backend under an isolated
 * `SINGULARITY_DIR`, then stays up serving.
 *
 * DETACHABLE, AND THE ONLY COMMAND THAT IS. `bin/index.ts` arms the orphan
 * guard for every invocation — a CLI process dies with the shell that started
 * it, so an op can never sit on a host lock after its invoker is gone. That is
 * exactly wrong here: `serve-app` boots a runtime whose whole job is to outlive
 * the shell (`nohup ./equin serve-app … &` is the sanctioned way to start
 * a packaged app), and under the guard it would exit 140 the moment its
 * invoking shell went away. Declaring `detachable` makes the mapper disarm the
 * guard as the command begins, which is the one place "is this command meant to
 * outlive its shell" is knowable — the bootstrap that arms it runs before argv
 * is parsed.
 */
export default defineCliCommand<
  [],
  {
    name: string;
    port: string;
    repoRoot?: string;
    server?: string;
    composition?: string;
    web: string;
    logLevel: string;
  }
>({
  name: "serve-app",
  description:
    "Boot a packaged app's full runtime (gateway + embedded PG + app DB) under an isolated data root",
  detachable: true,
  options: [
    {
      flags: "--name <name>",
      description: "App namespace (subdomain)",
      defaultValue: "sonata",
    },
    {
      flags: "--port <port>",
      description: "Gateway listen port",
      defaultValue: String(DEFAULT_PORT),
    },
    {
      // No commander default, unlike every other option here: the value is
      // `REPO_ROOT`, which lives behind a *server* barrel, and a declaration is
      // reached on every single `./equin` invocation — so it may import
      // no server barrel at all (`cli:command-declarations-light`). The default
      // therefore moves into the action (`opts.repoRoot ?? REPO_ROOT`), and the
      // help text states it so the behaviour stays discoverable from
      // `serve-app --help`.
      flags: "--repo-root <path>",
      description:
        "Root of the code/bundle tree (gateway + server-core + web dist) (default: the repo root)",
    },
    {
      flags: "--server <path>",
      description: "Absolute path to the backend working dir",
    },
    // Which app the backend boots. Defaults to `--name`, which is what the
    // namespace meant back when the backend picked its registry by looking for
    // a `server.composition.<name>.generated.ts` on disk; naming it explicitly
    // is what replaced that guess. Separate from `--name` because a namespace is
    // `<composition>.<checkout>` and only a single-label one is also an id.
    {
      flags: "--composition <id>",
      description:
        "Composition whose filtered server registry the backend boots (default: --name)",
    },
    // REQUIRED, with no default. `serve-app` boots under an isolated
    // SINGULARITY_DIR (see the action), and every derivable dist path
    // (`worktreeArtifacts.webDist(...)`) resolves inside THAT root — which holds
    // no dist, because nothing ever built into it. A checkout-relative default
    // is equally wrong: no checkout carries a dist any more. There is no correct
    // default, so demand the path rather than invent one.
    {
      flags: "--web <path>",
      description: "Absolute path to the built web dist",
      required: true,
    },
    {
      flags: "--log-level <level>",
      description: "Gateway log level: debug|info|warn|error",
      defaultValue: "info",
    },
  ],
  run: () => import("./run"),
});
