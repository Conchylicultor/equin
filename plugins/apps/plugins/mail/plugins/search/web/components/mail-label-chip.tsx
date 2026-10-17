import { type ReactElement } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type { MailLabelRef } from "@plugins/apps/plugins/mail/plugins/mail-core/core";

/**
 * One user-label chip on a search row.
 *
 * Two rendering paths keyed on whether Gmail assigned the label a color:
 * - **Colored** (`label.color` non-null): Gmail hands us *its own* hex strings
 *   (bg + text, e.g. `#fb4c2f` / `#ffffff`), which are dynamic external data —
 *   not design tokens — so they can't be a Tailwind `colorClass`. They go
 *   through an inline `style` instead (the sanctioned pattern for user/external
 *   hex, mirroring the `color-picker` swatches). Inline styles win over the
 *   Badge's default variant classes, so the muted fallback bg/text is overridden.
 * - **Uncolored** (`label.color` null): a neutral `variant="muted"` pill.
 *
 * The label name truncates gracefully — `Badge`'s label leaf owns `max-w-full`
 * + an inner `truncate` span, so a very long name ellipsizes inside the chip.
 */
export function MailLabelChip({ label }: { label: MailLabelRef }): ReactElement {
  if (label.color) {
    return (
      <Badge
        shape="pill"
        tooltip={label.name}
        style={{ backgroundColor: label.color, color: label.textColor ?? undefined }}
      >
        {label.name}
      </Badge>
    );
  }
  return (
    <Badge variant="muted" shape="pill" tooltip={label.name}>
      {label.name}
    </Badge>
  );
}
