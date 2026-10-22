import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { ComponentType } from "react";
import type {
  ResourceError,
  ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type {
  FixedTheme,
  SubTheme,
  Theme,
  ThemeId,
  TokenGroupDescriptor,
} from "../core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

export interface VariantGroupContribution {
  id: string;
  componentLabel: string;
  /**
   * A pluggable component's visual variant picker (sidebar framing, tab bar,
   * progress bar, window titlebar) — a choice that survives a theme swap. Token
   * values are never picked here: they belong to the theme a scope selects.
   */
  component: ComponentType;
}

/**
 * A token group: the CSS variables it declares and their schema defaults. Its
 * VALUES come from the theme a scope selects (`useResolvedTheme`), never from a
 * per-group setting.
 */
export interface TokenGroupContribution {
  id: string;
  label: string;
  descriptor: TokenGroupDescriptor;
}

/** A catalog row a browse source offers before it is saved (a tweakcn community theme). */
export interface ThemeSourceEntry {
  id: string;
  label: string;
  tags: string[];
  /** The entry's color-palette token values (`primary`, `background`, …) per mode — enough to draw a swatch. */
  preview: { light: Record<string, string>; dark: Record<string, string> };
  /** Set when this entry is already saved — the resident theme it became. */
  savedThemeId?: ThemeId;
}

/**
 * Where themes beyond the code ones come from. Theme-engine names no source:
 * each arrives through this slot.
 *
 * - `resident` — themes that exist now and can be selected and painted (the
 *   saved-themes table). `useThemes` is a read: `loading` is distinct from "no
 *   themes" (the painter injects nothing while any resident source is loading,
 *   so a half-loaded list is never painted as final), and `error` is distinct
 *   from both (the source's last-known themes — its `stale` — still paint, and
 *   the failure is carried on `ThemesState.failures` for a surface to render).
 * - `browse` — a catalog to pick from, read the same way. An entry becomes
 *   selectable only once the source's adopt (`useAdopt()`) has saved it, which
 *   resolves to the resident theme's id.
 */
export type ThemeSourceContribution =
  | {
      kind: "resident";
      id: string;
      useThemes: Hook<() => ResourceResult<Theme[]>>;
    }
  | {
      kind: "browse";
      id: string;
      useEntries: Hook<() => ResourceResult<ThemeSourceEntry[]>>;
      /**
       * The source's adopt, bound to the subtree's transport and live-state
       * pipeline: save the entry and resolve to the resident theme it became —
       * already in `useThemes()` when this settles, so the caller can select it
       * straight away. Rejects with the endpoint's error; the caller surfaces it.
       */
      useAdopt: Hook<() => (entryId: string) => Promise<ThemeId>>;
    };

/** A theme source whose read failed: which one, why, and how to retry it. */
export interface ThemeSourceFailure {
  sourceId: string;
  error: ResourceError;
  refetch: () => Promise<void>;
}

export type ThemesState =
  | { pending: true }
  | {
      pending: false;
      themesById: ReadonlyMap<ThemeId, Theme>;
      /**
       * Resident sources whose read FAILED. Their last-known themes (if any)
       * are in `themesById`; the rest are unknown. Never a reason to stop
       * painting — the app would blank — so the state still settles, and a
       * surface listing themes renders these as errors with Retry.
       */
      failures: readonly ThemeSourceFailure[];
    };

/**
 * Every theme that can be selected right now: the code themes
 * (`ThemeEngine.Theme`) plus every resident source's. Pending while any
 * resident source is still loading; a FAILED source contributes its stale
 * themes (if any) and a `failures` entry, and never holds the state pending.
 *
 * Two themes claiming one id is a bug, not a precedence rule, so it throws.
 *
 * The state (and its map) is the SAME object for as long as its inputs are (the
 * slot list and each source's list keep their identity until they change), so
 * a consumer can memoize a resolution on it instead of redoing it every render.
 */
export function useThemes(): ThemesState {
  const codeThemes = ThemeEngine.Theme.useContributions();
  // ThemeSource contributions are static slot entries; the count never
  // changes, so calling each resident source's hook here keeps hook order stable.
  const resident = ThemeEngine.ThemeSource.useContributions().flatMap((s) =>
    s.kind === "resident" ? [{ id: s.id, read: s.useThemes() }] : [],
  );
  const lists: (readonly Theme[])[] = [];
  const failures: ThemeSourceFailure[] = [];
  for (const { id, read } of resident) {
    switch (read.status) {
      case "loading":
        return THEMES_PENDING;
      case "error":
        lists.push(read.stale ?? NO_THEMES);
        failures.push({
          sourceId: id,
          error: read.error,
          refetch: read.refetch,
        });
        break;
      case "ready":
        lists.push(read.data);
    }
  }
  return themesStateOf(codeThemes, lists, failures);
}

const THEMES_PENDING: ThemesState = { pending: true };
const NO_THEMES: readonly Theme[] = [];

// The last state built per code-theme list, with the resident lists and
// failures it came from: reused while every one is the same object.
const builtStates = new WeakMap<
  readonly Theme[],
  {
    resident: readonly (readonly Theme[])[];
    failures: readonly ThemeSourceFailure[];
    state: ThemesState;
  }
>();

function sameFailures(
  a: readonly ThemeSourceFailure[],
  b: readonly ThemeSourceFailure[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (f, i) =>
        f.sourceId === b[i]!.sourceId &&
        f.error === b[i]!.error &&
        f.refetch === b[i]!.refetch,
    )
  );
}

function themesStateOf(
  codeThemes: readonly Theme[],
  resident: readonly (readonly Theme[])[],
  failures: readonly ThemeSourceFailure[],
): ThemesState {
  const built = builtStates.get(codeThemes);
  if (
    built &&
    built.resident.length === resident.length &&
    built.resident.every((list, i) => list === resident[i]) &&
    sameFailures(built.failures, failures)
  ) {
    return built.state;
  }
  const themesById = new Map<ThemeId, Theme>();
  for (const theme of [...codeThemes, ...resident.flat()]) {
    if (themesById.has(theme.id)) {
      throw new Error(
        `[theme-engine] two themes claim the id "${theme.id}" — theme ids must be unique across code themes and every ThemeSource.`,
      );
    }
    themesById.set(theme.id, theme);
  }
  const state: ThemesState = { pending: false, themesById, failures };
  builtStates.set(codeThemes, { resident, failures, state });
  return state;
}

export const ThemeEngine = {
  VariantGroup: defineRenderSlot<VariantGroupContribution>({
    docLabel: (p) => p.componentLabel,
  }),
  TokenGroup: defineSlot<TokenGroupContribution>({ docLabel: (p) => p.label }),
  Theme: defineSlot<Theme>({ docLabel: (p) => p.label }),
  /**
   * Sub-themes (`defineSubTheme`): painted for as long as they are
   * contributed, whether or not a region wears one yet, so the server paints
   * them into the first frame too and a region that mounts later never repaints.
   */
  SubTheme: defineSlot<SubTheme>({ docLabel: (p) => p.label }),
  /**
   * Fixed themes (`defineFixedTheme`): whole themes a region always wears,
   * whatever its scope selects (the app chrome). Painted for as long as they
   * are contributed, like sub-themes, so they are in the first frame too.
   */
  FixedTheme: defineSlot<FixedTheme>({ docLabel: (p) => p.label }),
  ThemeSource: defineSlot<ThemeSourceContribution>({ docLabel: (p) => p.id }),
};
