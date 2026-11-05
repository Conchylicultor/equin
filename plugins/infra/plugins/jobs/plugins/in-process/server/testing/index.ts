// A fresh in-process queue for a suite that runs real jobs end to end without
// graphile: provide it with `withHostServices([JobQueue.provide(queue)], …)`,
// `start()` it, and run it dry with `settleJobQueue()`.
export { createMemoryQueue } from "../internal/memory-queue";
