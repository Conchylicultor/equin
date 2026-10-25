import type { ReactNode } from "react";
import { reachesAudience, type Audience } from "../core";
import { useAudience } from "./use-audience";

/**
 * Renders `children` only for the audience a feature declares itself for
 * (`audience`, omitted = everyone) — the declarative gate a host wraps each
 * contribution of an audience-aware slot in, so a contributor states who it is
 * for instead of branching on Developer mode itself.
 *
 * Nothing renders while the audience is unknown: whether a control exists is
 * the question, so there is no stand-in to show (the config is boot-preloaded,
 * so the window is not observable after boot). A failed read throws to the
 * nearest error boundary.
 */
export function ForAudience({
  audience,
  children,
}: {
  audience: Audience | undefined;
  children: ReactNode;
}) {
  const user = useAudience();
  if (audience === undefined || audience === "user") return children;
  if (user.status === "error") throw user.error;
  if (user.status === "loading") return null;
  return reachesAudience(audience, user.data) ? children : null;
}
