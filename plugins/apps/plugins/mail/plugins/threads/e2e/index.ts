/**
 * e2e barrel for the mail threads list: the synthetic-thread fixture, for a
 * script that needs mail rows in a worktree deploy's database (seeded with an
 * `e2e-` prefix, refused on main, deleted by `cleanup()`), importable as
 * `@plugins/apps/plugins/mail/plugins/threads/e2e`.
 */
export { openThreadFixture } from "./fixture";
export type { SeededThread, ThreadFixture } from "./fixture";
