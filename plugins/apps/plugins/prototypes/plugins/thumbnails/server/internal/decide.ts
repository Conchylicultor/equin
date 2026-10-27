import type { ThumbnailState } from "../../core";
import { ThumbnailRenderError } from "./errors";
import type { ThumbnailRendererImpl } from "./renderer";

/** What `decideThumbnail` needs of the host's renderer: whether there is one. */
export type RendererAvailability =
  | { readonly kind: "renders" }
  | Extract<ThumbnailRendererImpl, { kind: "unavailable" }>;

/** What one prototype's current fingerprint implies, given what we know. */
export interface ThumbnailDecision {
  state: ThumbnailState;
  /** Whether this prototype needs a render enqueued. */
  render: boolean;
}

/**
 * The whole staleness policy, in one pure function.
 *
 * Four rules, and the second is the one worth naming: a prototype that already
 * failed **at these exact bytes** keeps its failure instead of being re-rendered
 * every time anything else in the tree is saved — otherwise one permanently
 * broken mock would launch a browser on every keystroke elsewhere. New bytes
 * always get a fresh attempt, which is what makes "fix it and save" work.
 */
export function decideThumbnail(
  key: string,
  cached: boolean,
  previous: ThumbnailState | undefined,
  renderer: RendererAvailability,
): ThumbnailDecision {
  if (cached) return { state: { status: "ready", key }, render: false };

  if (previous?.status === "failed" && previous.key === key) {
    return { state: previous, render: false };
  }

  // A host that cannot render says so on the card — never `rendering`, which
  // would promise a picture nothing is going to make.
  if (renderer.kind === "unavailable") {
    return {
      state: { status: "unavailable", message: renderer.message },
      render: false,
    };
  }

  // `waiting-for-browser` falls through on purpose: it is not a verdict about
  // these bytes, so every sync — including the one the browser's install
  // triggers when it settles — renders again.

  return { state: { status: "rendering" }, render: true };
}

/**
 * Is what the browser produced worth keeping? `null` means yes — screenshot it.
 *
 * The precedence matters and is the reason this is a named function rather than
 * two `if`s buried in the render: when a required script failed, that is *why*
 * the page is empty, and "react.development.js did not load" is the actionable
 * message. Reporting blankness first would bury the cause under the symptom.
 */
export function classifyRenderOutcome(
  name: string,
  failedCritical: readonly string[],
  painted: boolean,
): ThumbnailRenderError | null {
  if (failedCritical.length > 0) {
    return new ThumbnailRenderError(
      "subresource-failed",
      `${name} could not load ${failedCritical.length} required file(s): ${failedCritical.join(", ")}`,
    );
  }
  if (!painted) {
    return new ThumbnailRenderError(
      "blank-page",
      `${name} rendered an empty page`,
    );
  }
  return null;
}
