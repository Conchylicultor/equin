import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/** Baked into `RELEASE.json` when `--port` is absent. */
const DEFAULT_PORT = 9100;

export default defineCliCommand({
  name: "release",
  description:
    "Emit a portable, self-contained app artifact (compiled binaries + vendored native PG/PgBouncer/gateway) that serves a composition on a fresh host",
  options: [
    {
      flags: "--composition <name>",
      description: "Composition to release",
      required: true,
    },
    {
      flags: "--target <target>",
      description: "Release target: web (tauri is F5)",
      defaultValue: "web",
    },
    {
      flags: "--dev",
      description:
        "Emit the staged directory only; skip the single-binary pack",
    },
    {
      flags: "--out <dir>",
      description:
        "Output directory (default: the canonical versioned releases run dir for <name>-<target>)",
    },
    {
      flags: "--port <port>",
      description: "Listen port baked into RELEASE.json",
      defaultValue: String(DEFAULT_PORT),
    },
    {
      flags: "--platform <tag>",
      // The tags are SPELLED here rather than read from `PLATFORM_TAGS`: that
      // list lives behind `@plugins/release/core`, which reaches zod, and a
      // declaration loads on every `./equin` invocation
      // (`cli:command-declarations-light`). Only this help string restates the
      // set — the closed list still validates `--platform` at run time, from
      // `PLATFORM_TAGS` itself, in `run.ts`.
      description:
        "Target platform — darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64 (default: this host). Cross-building keeps build inputs off production hosts.",
    },
  ],
  run: () => import("./run"),
});
