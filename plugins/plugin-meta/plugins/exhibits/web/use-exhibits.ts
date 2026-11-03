import { useMemo } from "react";
import {
  loadExhibits,
  lookupExhibit,
  type Exhibit,
  type ExhibitLookup,
} from "@plugins/plugin-meta/plugins/exhibits/core";
import { useQueryResource } from "@plugins/network/plugins/live/plugins/live-state/web";

/** The catalog as a read: not known yet, or every contributed exhibit. */
export type ExhibitsResult =
  { kind: "loading" } | { kind: "ready"; exhibits: readonly Exhibit[] };

/** One exhibit by id: not known yet, or the lookup's found / missing / ambiguous. */
export type ExhibitResult = { kind: "loading" } | ExhibitLookup<Exhibit>;

const LOADING = { kind: "loading" } as const;

/**
 * Every exhibit in this worktree's catalog.
 *
 * The catalog is code: it changes only with a new dist, which reloads the page.
 * So it loads once per page and never refetches (`staleTime` / `gcTime`
 * Infinity), and a failure is not retried — a strict load that failed (a
 * contribution that throws or exports a malformed exhibit) fails identically
 * every time. That failure throws here, into the caller's error boundary: a
 * broken catalog must not read as an empty one.
 */
export function useExhibits(): ExhibitsResult {
  const read = useQueryResource({
    queryKey: ["plugin-meta.exhibits", "catalog"],
    queryFn: loadExhibits,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const result = useMemo(
    (): ExhibitsResult | { kind: "failed"; error: Error } =>
      read.status === "error"
        ? { kind: "failed", error: read.error }
        : read.status === "loading"
          ? LOADING
          : { kind: "ready", exhibits: read.data },
    [read],
  );
  if (result.kind === "failed") throw result.error;
  return result;
}

/** Look one exhibit up by id. Render a found one with `<ExhibitView>`. */
export function useExhibit(id: string): ExhibitResult {
  const catalog = useExhibits();
  return useMemo(
    () =>
      catalog.kind === "loading"
        ? catalog
        : lookupExhibit(catalog.exhibits, id),
    [catalog, id],
  );
}
