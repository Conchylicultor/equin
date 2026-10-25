import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import {
  CONTACT_EMAIL,
  CONTACT_MAILTO,
} from "@plugins/apps/plugins/website/plugins/shell/core";

/**
 * The address inside the card's sentence — a `mailto:` link ending the
 * sentence, with a copy icon that appears on hover (or keyboard focus) just
 * past the full stop. The icon is placed outside the text's box, so at rest it
 * takes no room and the sentence reads as plain prose.
 */
export function MailAddress() {
  return (
    <span className={cn("relative whitespace-nowrap", hoverRevealGroup)}>
      <a
        href={CONTACT_MAILTO}
        className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-current"
      >
        {CONTACT_EMAIL}
      </a>
      .
      <Placed
        as="span"
        // Just past the full stop, centred on the line.
        x={{ start: "calc(100% + 0.25rem)" }}
        y={{ center: "50%" }}
        className={hoverRevealTarget}
      >
        <CopyButton text={CONTACT_EMAIL} tooltip="Copy address" aspect="icon" />
      </Placed>
    </span>
  );
}
