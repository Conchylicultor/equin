import type { ReactElement } from "react";
import type {
  FrameResolution,
  FrameSourceProps,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { Counterpart, useCounterpartKinds } from "../slots";
import type { CounterpartResolution } from "../types";
import { malformedDeclaration, noDeclaration } from "./notices";
import { declareCounterpartLaunch } from "./declare-launch";

/**
 * The canvas's "Real app" frame: the real thing the prototype declares it
 * mocks (`<meta name="mocks" content="<kind>:<ref>">`), dispatched to whichever
 * kind plugin handles the tag. A prototype that declares nothing, or declares
 * it malformed, gets the notice saying how to — in the frame, where the author
 * is looking for the comparison — and a launch for an agent to declare it,
 * which the canvas's Compare button opens. This file names no kind.
 *
 * The declaration is one-directional — the prototype names its counterpart.
 * Prototypes are host-global and outside git while kinds and their catalogs are
 * per-worktree, so the lookup can only ever happen at runtime, and "this
 * worktree has no such thing" is an ordinary answer, not a fault.
 */
export function RealAppSource({
  meta,
  children,
}: FrameSourceProps): ReactElement {
  const kinds = useCounterpartKinds();
  const decl = meta.mocks;
  if (decl.kind !== "declared") {
    const notice =
      decl.kind === "malformed"
        ? malformedDeclaration(decl, kinds)
        : noDeclaration(kinds);
    return (
      <>
        {children({
          status: "unresolved",
          ...notice,
          launch: declareCounterpartLaunch(meta, kinds),
        })}
      </>
    );
  }
  return (
    <Counterpart.Kind.Dispatch kind={decl.tag} target={decl.ref} meta={meta}>
      {(resolution) => children(toFrame(resolution))}
    </Counterpart.Kind.Dispatch>
  );
}

/** A kind's answer, as the canvas frame reads it. */
function toFrame(resolution: CounterpartResolution): FrameResolution {
  if (resolution.status !== "found") return resolution;
  const { title, subtitle, badge, href, render } = resolution;
  return {
    status: "found",
    tag: [badge ?? title, subtitle].filter((s) => s !== undefined).join(" · "),
    ...(href === undefined ? {} : { href }),
    render,
  };
}
