/**
 * What `AppsLayout` does when the URL matches no registered app — the ONE rule
 * behind both the canonicalization `replaceState` and the surface the tabs area
 * paints. They were previously two derivations reading the same signals; a
 * single resolver makes them incapable of disagreeing.
 *
 * The redirect is DESTRUCTIVE (it overwrites the address bar) so it fires in
 * exactly one case — bare `/`, where there is nothing to destroy and the
 * instant cold-start matters. A non-bare unmatched path is a *broken link*, not
 * a path to canonicalize: silently rewriting it to the default app throws away
 * the only evidence of what went wrong (e.g. a legacy `/tasks/t/<id>` that lost
 * its `/agents` prefix landing on the homepage with no explanation). It gets an
 * error surface instead, with the URL preserved.
 *
 *  - matched app OR no home (no app at all) ⇒ nothing to canonicalize; render.
 *  - bare `/`, home registered             ⇒ redirect immediately (nothing to
 *                                            destroy; keeps cold-start instant).
 *  - bare `/`, home NOT registered         ⇒ loading until the tier settles,
 *                                            then app-load error (a shell failed)
 *                                            or home-missing — NEVER another app.
 *  - non-bare, deferred tier NOT settled   ⇒ loading (an app shell owning this
 *                                            URL may still register).
 *  - non-bare, settled, an app shell failed⇒ app-load error (the app is broken,
 *                                            not the link — offer a reload).
 *  - non-bare, settled, healthy            ⇒ not-found (genuinely no such route).
 */
export type UnmatchedUrlOutcome =
  /** The URL resolves (or there is nothing to canonicalize to) — paint the app. */
  | "render"
  /** Bare root — rewrite the address bar to the default app's path. */
  | "redirect"
  /** Unmatched, but the deferred tier may still register the owning app. */
  | "loading"
  /** Unmatched because an app shell failed to load. */
  | "load-error"
  /** Unmatched, settled, healthy — no app owns this URL. */
  | "not-found"
  /** Bare root, settled, healthy, yet the composition's home app never registered. */
  | "home-missing";

export function resolveUnmatchedUrl(opts: {
  /** An app's `path` prefix owns the current URL (`matchAppForPath` resolved). */
  matched: boolean;
  /** The composition's home app: registered, absent (no app), or declared but unregistered. */
  home: "app" | "none" | "unregistered";
  /** The current pathname is the bare root `/`. */
  isBareRoot: boolean;
  /** The deferred plugin tier has fully settled. */
  deferredComplete: boolean;
  /** Any app shell under `apps/plugins/` failed to load (coarse by design). */
  anyAppShellLoadError: boolean;
}): UnmatchedUrlOutcome {
  if (opts.matched || opts.home === "none") return "render";
  if (opts.isBareRoot && opts.home === "app") return "redirect";
  if (!opts.deferredComplete) return "loading";
  if (opts.anyAppShellLoadError) return "load-error";
  return opts.isBareRoot ? "home-missing" : "not-found";
}
