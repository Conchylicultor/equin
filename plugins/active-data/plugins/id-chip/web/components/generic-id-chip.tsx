import type { ComponentType } from "react";
import type { Hint } from "@plugins/hints/core";
import { useHintAnchor, useHintMoment } from "@plugins/hints/web";
import type { IdPresenter } from "@plugins/ids/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Icon } from "@plugins/ui/plugins/icons/web";

/**
 * The chip a presenter renders by default: the referent's title, led by the
 * kind's icon, opening it on click (a push beside the surface holding the
 * text) — a link, so ⌘/middle-click opens it in a new browser tab.
 *
 * Every arm that is not a found referent — loading, failed, missing — renders
 * the id exactly as written, unstyled: it is spliced into a sentence, so a
 * placeholder would move the prose as the read settles, and a chip that opens
 * nothing is worse than the text the model wrote.
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
): ComponentType<{ content: string; attrs: Record<string, string> }> {
  const { useReferent, useTarget, icon } = presenter;
  function GenericIdChip({ content }: { content: string }) {
    const id = content.trim();
    const referent = useReferent(id);
    const target = useTarget();
    const anchorRef = useHintAnchor(hint?.anchor);
    useHintMoment(hint, referent.status === "found");
    if (referent.status !== "found") return <>{id}</>;
    return (
      <LinkChip
        ref={anchorRef}
        activation={target(id)}
        tooltip={`${referent.title} · ${id}`}
        leading={icon ? <Icon icon={icon} /> : undefined}
      >
        {referent.title}
      </LinkChip>
    );
  }
  GenericIdChip.displayName = `IdChip(${presenter.kind.prefix})`;
  return GenericIdChip;
}
