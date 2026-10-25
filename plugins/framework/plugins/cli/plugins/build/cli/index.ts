import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The command the whole agent workflow runs on: `./equin build` is how a
 * checkout's work becomes a running app at `http://<worktree>.localhost:9000`.
 *
 * It is a leaf with two postures over one pipeline — deploy this checkout into
 * the live dev cluster (the default), or produce a composition's artifact set
 * hermetically (`--hermetic --composition`, which is what `release` shells
 * into). The posture branch is the literal first statement of `./run.ts`, so
 * the deploy machinery (progress log, op profiler, run ledger, verdict guard,
 * deploy receipt) is structurally absent from the hermetic path rather than
 * skipped by scattered guards.
 *
 * Not `detachable`: build is an op command, and the orphan guard exiting it
 * when its invoking shell dies is what stops an abandoned build from sitting on
 * the build lock and a host grant. The detached self-restart build exempts
 * itself through `EQUIN_BUILD_DETACHED` instead.
 */
export default defineCliCommand({
  name: "build",
  description:
    "Build the app. Default posture: deploy THIS checkout into the live dev cluster " +
    "(frontend + backend + gateway registration) — the checkout's own app, or the " +
    "compositions named by --composition. With --hermetic: produce those compositions' " +
    "artifact sets and touch no cluster at all.",
  options: [
    {
      flags: "--hermetic",
      description:
        "Produce artifacts only — filtered registries, generated migrations and one web dist per " +
        "composition — with the whole deploy half structurally absent (no Postgres, no DB fork, " +
        "no gateway, no run ledger), so it runs on a bare host from a fresh `git clone`. Requires " +
        "--composition; refuses the deploy-only flags. The phase `release` runs.",
    },
    {
      flags: "--composition <name...>",
      description:
        "Composition(s) to build INSTEAD of this checkout's own app: one shared install/codegen/" +
        "validation pass, one dist each. Deploying, each is served at " +
        "http://<composition>.<checkout>.localhost:9000 with its own empty database. With " +
        "--hermetic the names come from the compositions manifest COMPILED INTO THE CODE; " +
        "deploying, they come from THIS CHECKOUT'S resolved config, so a composition created in " +
        "Studio is servable but not releasable.",
    },
    {
      flags: "--migration-name <slug>",
      description:
        "Name for a new migration (required if any plugin schema has changed)",
    },
    {
      flags: "--reset-migration",
      description:
        "Drop branch-local SCHEMA migration files (those on no published main — local main or <remote>/main — that carry a drizzle snapshot) before generating. Recovers from snapshot-chain Y-forks after rebasing onto main. Data/backfill migrations (snapshot-less) are preserved.",
    },
    {
      flags: "--custom-migration",
      description:
        "Create a snapshot-less DATA/BACKFILL migration (DML only). Generates an empty SQL file with no drizzle snapshot; edit it to add UPDATE/INSERT/DELETE before the next build applies it. The file is re-hashed on each build and enforced DML-only by the data-migration-dml-only check. Stays out of the snapshot chain, so it never Y-forks and is push-safe.",
    },
    {
      flags: "--migration-answers <json>",
      description:
        'JSON array of answers for drizzle-kit rename/create prompts. Each entry is {"action":"create"} or {"action":"rename","from":"<source_name>"}. Run without this flag first to see detected prompts.',
    },
    {
      flags: "--no-restart",
      description: "Skip asking the gateway to restart the backend",
    },
    {
      flags: "--skip-checks",
      description:
        "Skip the post-build full check pass — the alwaysRun subset still runs " +
        "(faster dev iteration; checks still gate `push`).",
    },
    {
      flags: "--allow-main",
      description:
        "DANGER: allow running build from the main branch. Agents MUST NOT pass this flag without explicit user approval in the current conversation.",
    },
    {
      flags: "--no-minify",
      description:
        "Skip esbuild minification (debugging). The minify flag is an artifact-hash input.",
    },
  ],
  run: () => import("./run"),
});
