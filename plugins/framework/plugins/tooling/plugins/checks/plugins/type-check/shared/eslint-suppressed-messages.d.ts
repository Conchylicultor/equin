// ESLint's `Linter#getSuppressedMessages()` (lib/linter/linter.js: the
// messages the last `verify` dropped because a directive suppressed them) is
// public API, but its type declarations (10.14) omit it. `./lint-engine.ts`
// reads it to keep a directive file's raw typed parts whole: every problem,
// suppressed ones included.
//
// A declaration-only file: an augmentation is seen by every file without being
// imported, so in a source file every edit to it would re-check the whole repo
// (`type-check/no-global-declaration-in-source`).
import type {} from "eslint";

declare module "eslint" {
  interface Linter {
    getSuppressedMessages(): Linter.SuppressedLintMessage[];
  }
}
