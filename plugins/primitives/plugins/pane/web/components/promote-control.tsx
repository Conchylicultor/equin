import type { ReactNode } from "react";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import type { AnyPane, PaneExpand } from "../pane";
import { useMorphFromPane } from "../morph-sink";
import { PaneIconAction } from "./pane-icon-action";

/**
 * An Expand the pane's host hands its chrome for this instance, in place of
 * the pane's declared `expand` and its default promote: what the content
 * itself knows to be its fuller view (a MIDI file's preview opens it in
 * Sonata). An action, not a link — the content may have work to do first.
 */
export interface PaneExpandAction {
  /** The button's label ("Open in Sonata"). */
  label: string;
  /** Runs on click; a returned promise holds the button pending. */
  onActivate: () => void | Promise<void>;
}

/**
 * The header's Expand button, one spelling for every chrome that draws it.
 *
 * The host's `override` ({@link PaneExpandAction}) wins, whatever the pane
 * declares (`chrome.promote: false` included): its content named its own.
 * A pane declaring `expand` opens its subject in that app ("Open in Files"),
 * wherever it sits; otherwise — or when that answers `none` for this instance —
 * the default promote ({@link AnyPane.usePromote}): the pane on its own, in its
 * home app. `ancestorsHidden` is the full-pane layout's flag: painted alone, a
 * same-app re-root has nothing on screen to detach from.
 *
 * Every cross-app hop runs as a morph out of this pane's box (`morph-sink.ts`):
 * the pane grows into its place in the app that replaces this one.
 */
export function PromoteControl({
  pane,
  ancestorsHidden,
  override,
}: {
  pane: AnyPane;
  ancestorsHidden: boolean;
  /** The host's own Expand for this instance — wins over everything else. */
  override?: PaneExpandAction | undefined;
}): ReactNode {
  if (override !== undefined) {
    return (
      <PaneIconAction
        label={override.label}
        icon={navIcons.expand}
        onClick={() => override.onActivate()}
      />
    );
  }
  if (!pane._internal.chrome.promote) return null;
  const expand = pane._internal.expand;
  if (expand !== undefined) {
    return (
      <ExpandElsewhere
        pane={pane}
        expand={expand}
        ancestorsHidden={ancestorsHidden}
      />
    );
  }
  return <DefaultPromote pane={pane} ancestorsHidden={ancestorsHidden} />;
}

function ExpandElsewhere({
  pane,
  expand,
  ancestorsHidden,
}: {
  pane: AnyPane;
  expand: PaneExpand;
  ancestorsHidden: boolean;
}): ReactNode {
  const answer = expand.useTarget(pane.useParams());
  const { attach, morph } = useMorphFromPane();
  const label = `Open in ${expand.app.name}`;
  switch (answer.kind) {
    case "ready":
      return (
        <PaneIconAction
          ref={attach}
          label={label}
          icon={navIcons.expand}
          {...linkProps(morph(answer.target))}
        />
      );
    case "pending":
      return <PaneIconAction label={label} icon={navIcons.expand} disabled />;
    case "none":
      return <DefaultPromote pane={pane} ancestorsHidden={ancestorsHidden} />;
  }
}

function DefaultPromote({
  pane,
  ancestorsHidden,
}: {
  pane: AnyPane;
  ancestorsHidden: boolean;
}): ReactNode {
  const promote = pane.usePromote();
  const { attach, morph } = useMorphFromPane();
  if (promote === null) return null;
  if (ancestorsHidden && promote.kind !== "cross-app") return null;
  return (
    <PaneIconAction
      ref={attach}
      label={
        promote.kind === "cross-app"
          ? `Open in ${promote.app.name}`
          : "Expand pane"
      }
      icon={navIcons.expand}
      {...linkProps(promote.kind === "cross-app" ? morph(promote) : promote)}
    />
  );
}
