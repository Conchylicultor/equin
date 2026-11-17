/**
 * The stylesheet facts a class rule is handed, as types only — a leaf, so the
 * lint builder and the toolkit (the lint ENGINE's import closure) name them
 * without reaching the reader's file I/O in `declared-utilities.ts`.
 */

/** What a class rule may know about one custom `@utility`. */
export interface DeclaredUtility {
  /**
   * Its body declares a `transition` or an `animation` (`overlay-enter`,
   * `surface-enter`) — so a `duration-*` beside it times something, the way it
   * does beside a `transition-*` or `animate-*` class.
   */
  readonly animates: boolean;
}

/** Every custom `@utility` app.css declares, by class name. */
export type DeclaredUtilities = ReadonlyMap<string, DeclaredUtility>;
