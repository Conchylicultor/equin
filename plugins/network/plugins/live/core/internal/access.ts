import type { VisitorAccess } from "@plugins/framework/plugins/principal/core";

// `access` on a live declaration — who may read it besides the owner. The same
// vocabulary as an endpoint's (`framework/principal`'s `EndpointAccess`): owner
// by default, never spelled, so a forgotten field is the safe answer; the one
// opt-in is `{ visitor: "<reason>" }`, for what a deployed site's pages read.
// A visitor (anyone through the site's public edge) is refused every other
// resource on every read path — the HTTP read, each socket sub and the boot
// snapshot (resource-runtime's `ResourceDefinition.access`).
// Design: research/2026-11-15-network-live-resource-visitor-access.md.

/** The `access` field every `liveValue` / `liveCollection` spec form takes. */
export interface LiveAccessSpec {
  /**
   * `{ visitor: "<reason>" }`: a deployed site's visitors may read it too —
   * say which of the site's pages read it. Absent: the owner only.
   */
  access?: VisitorAccess;
}

/**
 * The `access` a declaration carries onto its descriptor(s), checked: exactly
 * `{ visitor }` with a non-empty reason (an untyped caller's `"owner"`, a
 * `{ public }`, an empty reason all throw — a resource is never public: no
 * socket is).
 */
export function accessFields(
  owner: string,
  access: unknown,
): { access?: VisitorAccess } {
  if (access === undefined) return {};
  const keys =
    access !== null && typeof access === "object" ? Object.keys(access) : [];
  const reason = (access as { visitor?: unknown } | null)?.visitor;
  if (
    keys.length !== 1 ||
    keys[0] !== "visitor" ||
    typeof reason !== "string" ||
    reason.trim() === ""
  ) {
    throw new Error(
      `${owner}: \`access\` is { visitor: "<reason>" } (which of a deployed ` +
        `site's pages read it) or absent (the owner only) — got ` +
        `${JSON.stringify(access)}`,
    );
  }
  return { access: { visitor: reason } };
}
