import type { ComponentType } from "react";
import type { Hint } from "@plugins/hints/core";
import { useHintAnchor, useHintMoment } from "@plugins/hints/web";
import type { IdPresenter } from "@plugins/ids/web";
import {
  usePaneToggle,
  type PaneTarget,
} from "@plugins/primitives/plugins/pane/web";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { splitIdChipToken } from "../../core";
import type { IdChipQualifier } from "../internal/id-chip";

/**
 * The chip a presenter renders by default: the referent's title, led by the
 * kind's icon, opening its pane on click (a column beside the surface holding
 * the text; a second click closes it) — a link, so ⌘/middle-click opens it in
 * a new browser tab.
 *
 * Every arm that is not a found referent — loading, failed, missing — renders
 * the id exactly as written, unstyled: it is spliced into a sentence, so a
 * placeholder would move the prose as the read settles, and a chip that opens
 * nothing is worse than the text the model wrote.
 *
 * With a `qualifier`, a token written with one (`proto-…?pane=floating`)
 * opens the qualifier's pane and reads `<title> · <qualifier label>`; the id
 * alone is the plain chip.
 *
 * With a `hint`, every resolved chip anchors and requests it (the newest
 * rendered chip wins the anchor), so it shows on the first one the user meets.
 *
 * Built once per presenter (at the family's module eval), so the component's
 * identity is a module constant.
 */
export function genericIdChip(
  presenter: IdPresenter,
  hint?: Hint,
  qualifier?: IdChipQualifier,
): ComponentType<{ content: string; attrs: Record<string, string> }> {
  const { useReferent, icon, kind } = presenter;
  // Chosen once per chip family (a module constant), so every render of the
  // chip calls the same hook.
  const useTarget: Hook<(id: string, written: string) => PaneTarget> =
    qualifier?.usePane ?? presenter.usePane;
  function GenericIdChip({ content }: { content: string }) {
    const written = content.trim();
    const { id, qualifier: rest } = splitIdChipToken(kind, written);
    const referent = useReferent(id);
    const target = usePaneToggle()(useTarget(id, rest));
    const anchorRef = useHintAnchor(hint?.anchor);
    useHintMoment(hint, referent.status === "found");
    if (referent.status !== "found") return <>{written}</>;
    const title =
      qualifier !== undefined && rest !== ""
        ? `${referent.title} · ${qualifier.label(rest)}`
        : referent.title;
    return (
      <LinkChip
        ref={anchorRef}
        activation={target}
        tooltip={`${title} · ${id}`}
        leading={icon ? <Icon icon={icon} /> : undefined}
      >
        {title}
      </LinkChip>
    );
  }
  GenericIdChip.displayName = `IdChip(${presenter.kind.prefix})`;
  return GenericIdChip;
}
