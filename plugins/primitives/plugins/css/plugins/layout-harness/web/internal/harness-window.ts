import type { FixtureMutation } from "@plugins/primitives/plugins/css/plugins/layout-harness/plugins/geometry/core";
import type { MeasuredFixture } from "@plugins/primitives/plugins/css/plugins/layout-harness/core";

/**
 * The browser-side globals the measurer page (`entry.tsx`) installs on
 * `window` and the driver (`measure-page.ts`) reads. A type both sides cast
 * `window` to, not a `Window` augmentation: a global declaration makes every
 * edit to the file holding it re-check the whole repo. Over `typeof window`, so
 * the cast is a narrowing: its members are required.
 */
export type HarnessWindow = typeof window & {
  /** True once `loadExhibits()` resolved and the globals below are installed. */
  __fixturesReady: boolean;
  /** Mount a fixture at `width`, optionally applying a falsification mutation. */
  __renderFixture: (
    id: string,
    width: number,
    falsify?: FixtureMutation,
  ) => void;
  /** Read the `[data-geo]` boxes of the currently mounted fixture. */
  __measure: () => MeasuredFixture;
};
