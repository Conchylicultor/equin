import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// The exclusion set a fork must be told about, served by a BOOTED backend.
//
// Exists for one caller: `./equin db fork`, the escape hatch for a
// worktree created outside the app (`git worktree add`). That runs in a CLI
// process, where server contributions have never been collected — and it cannot
// simply load the plugin registry to collect them, because doing so imports
// `@plugins/database/server`, whose worktree pool is scoped to a runtime
// namespace a CLI process does not have. Reading the set over HTTP from a backend that
// HAS booted keeps one source of truth (the declarations themselves) and one
// failure mode: if no backend is up, the CLI says so instead of quietly forking
// everything.
//
// In `core/` rather than `shared/` because the CLI is a different plugin, and
// `shared/` is plugin-private (boundary rule R10).
// Exported separately from the endpoint because the only consumer is the CLI,
// which cannot use `fetchEndpoint` (web-only) and so parses the response itself.
// Mirrors `ForkExclusions` in `database/admin`. Kept as pure DATA — names and
// keep-lists, never flags and never a callback — because this is the one shape
// that has to survive a JSON round trip. Turning it into `pg_dump` arguments
// needs the source database's catalog and happens inside `forkDatabase`, on
// whichever side is doing the fork.
export const forkExclusionsSchema = z.object({
  tables: z.array(z.string()),
  schemas: z.array(z.object({ schema: z.string(), keep: z.array(z.string()) })),
});

export const getForkExclusions = defineEndpoint({
  route: "GET /api/db/fork-exclusions",
  response: forkExclusionsSchema,
  dedupe: true,
});
