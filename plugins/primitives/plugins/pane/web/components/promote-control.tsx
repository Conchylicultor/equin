import type { ReactNode } from "react";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import type { AnyPane, PaneExpand } from "../pane";
import { PaneIconAction } from "./pane-icon-action";

/**
 * The header's Expand button, one spelling for every chrome that draws it.
 *
 * A pane declaring `expand` opens its subject in that app ("Open in Files"),
 * wherever it sits; otherwise — or when that answers `none` for this instance —
 * the default promote ({@link AnyPane.usePromote}): the pane on its own, in its
 * home app. `ancestorsHidden` is the full-pane layout's flag: painted alone, a
 * same-app re-root has nothing on screen to detach from.
 */
export function PromoteControl({
  pane,
  ancestorsHidden,
}: {
  pane: AnyPane;
  ancestorsHidden: boolean;
}): ReactNode {
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
  const label = `Open in ${expand.app.name}`;
  switch (answer.kind) {
    case "ready":
      return (
        <PaneIconAction
          label={label}
          icon={navIcons.expand}
          {...linkProps(answer.target)}
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
  if (promote === null) return null;
  if (ancestorsHidden && promote.kind !== "cross-app") return null;
  return (
    <PaneIconAction
      label={
        promote.kind === "cross-app"
          ? `Open in ${promote.app.name}`
          : "Expand pane"
      }
      icon={navIcons.expand}
      {...linkProps(promote)}
    />
  );
}
