/**
 * `./equin test`'s exit when the tests ran and some failed (a runner exited
 * non-zero): a verdict about the code, distinct from `1` — the run itself
 * could not be done (a path in neither runner's scope, no test files, a
 * crash). A caller that supervises runs (Debug → Tests' Run now and idle
 * batches) reads it as data, never as a broken job.
 */
export const TESTS_FAILED_EXIT = 2;
