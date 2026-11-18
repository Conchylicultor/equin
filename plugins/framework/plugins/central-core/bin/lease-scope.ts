import { AsyncLocalStorage } from "node:async_hooks";
import { installFsUse } from "@plugins/packages/plugins/timed-fs/core";
import { installSpawnUse } from "@plugins/infra/plugins/spawn/core";
import {
  installLeaseContextRuntime,
  usingSlot,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";

// ── Before any plugin loads: central's use-scoped slot scope ───────────────
//
// Central runs the same resource runtime as a worktree server, so its reads
// pass the same read-admission gate, whose slot is held only around a read's
// own resource uses (resource-runtime CLAUDE.md, *A slot covers only its
// uses*). A use finds its slot through the ambient lease scope, which a host
// installs: the worktree server with its profiler (`runtime-profiler/server`'s
// install); central loads no profiler, so it is installed here, at the entry,
// before any gate runs. Without it every central read held its slot for its
// whole run.
const leaseAls = new AsyncLocalStorage<LeaseScope>();

installLeaseContextRuntime({
  run: (scope, fn) => leaseAls.run(scope, fn),
  current: () => leaseAls.getStore(),
});

// A file call is a use of the disk: inside a live read it holds the read's
// slot for its own length, and a child process a `read-spawn` slot — as on the
// worktree server (runtime-profiler/server's install says why).
installFsUse((start) => usingSlot("fs", start));
installSpawnUse((start) => usingSlot("spawn", start));
