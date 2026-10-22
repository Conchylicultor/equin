import { declareRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { hostComposition } from "./browser-host.composition";

// ── The FIRST thing the worker does: say which namespace it is ───────────────
//
// Imported as the literal first statement of `./browser-host.ts`, before
// `./seed` statically loads portable server barrels — the same rule the
// desktop's `serve` entry follows (`server-core/bin/declare-namespace.ts`): a
// process states which app it runs as before any plugin is evaluated, and
// portable server code may read it (`runtimeNamespace()`), e.g. to scope a
// ledger a worktree's forked database shares with main to this app's own rows.
//
// A browser host is no gateway namespace, so it runs as its composition — the
// app it serves. Nothing here is forked from another namespace's database, so
// a read scoped to it finds exactly the rows this host wrote.
declareRuntimeNamespace(asNamespace(hostComposition));
