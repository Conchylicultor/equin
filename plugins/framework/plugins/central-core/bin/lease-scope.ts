import { AsyncLocalStorage } from "node:async_hooks";
import { installFsAwait } from "@plugins/packages/plugins/timed-fs/core";
import {
  installLeaseContextRuntime,
  whileWaiting,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";

// ── Before any plugin loads: central's yieldable-slot scope ─────────────────
//
// Central runs the same resource runtime as a worktree server, so its reads
// pass the same yieldable read-admission gate (resource-runtime CLAUDE.md,
// *Waiters hold no slot*). A wait on another caller's work (`whileWaiting` —
// an `inflight` join, a shared memo's compute) gives its slot back only when
// the semaphore can find which slot the waiting code holds: the ambient lease
// scope, which a host installs. The worktree server installs it with its
// profiler (`runtime-profiler/server`'s install); central loads no profiler,
// so without this every central read waiting on another one held its slot for
// the whole wait. Installed here, at the entry, before any gate runs.
const leaseAls = new AsyncLocalStorage<LeaseScope>();

installLeaseContextRuntime({
  run: (scope, fn) => leaseAls.run(scope, fn),
  current: () => leaseAls.getStore(),
});

// A read waiting on the disk waits like one waiting on another caller's work:
// every awaited timed-fs call gives the slot back while it is pending — as on
// the worktree server (runtime-profiler/server's install says why).
installFsAwait((pending) => whileWaiting(pending));
