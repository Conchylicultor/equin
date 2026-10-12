import { Icon } from "@plugins/ui/plugins/icons/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import type { DateMentionFields } from "../../core";
import { formatMention } from "../internal/format-date";
import { symbol } from "@plugins/ui/plugins/icons/core";

const calendarTodayIcon = symbol("calendar-today");
const notificationsActiveIcon = symbol("notifications-active");

/**
 * The date-mention token as a chip, and nothing else — no popover, no editing,
 * no Lexical.
 *
 * Three surfaces render exactly this: the live editor's own decorator (with the
 * picker wrapped AROUND it), a non-editable editor, and every surface that
 * mounts no Lexical at all (page history, diffs, the public site) through the
 * `renderToken` half of `../internal/register`. One component, so the read-only
 * spelling of a date mention cannot drift from the editable one — and so it
 * cannot be MISSING, which is what it was: `[[date:…]]` rendered as literal
 * brackets on every read surface, because that renderer named its two token
 * types by hand and nobody added the third.
 *
 * `activation` is a required key rather than defaulted, because the two
 * callers want genuinely opposite things and neither is the obvious default:
 * the editable chip passes `undefined` so the press BUBBLES to the popover
 * trigger that owns it, and the read-only chip passes a no-op action, which
 * LinkChip isolates — the press stops at the chip instead of reaching whatever
 * it is embedded in. A date does not navigate, so it is never a `LinkTarget`.
 */
export function DateMentionChip({
  iso,
  reminderId,
  activation,
}: DateMentionFields & { activation: Activation | undefined }) {
  const isReminder = reminderId !== null;
  const icon = isReminder ? notificationsActiveIcon : calendarTodayIcon;
  return (
    <LinkChip
      leading={
        <Center as="span" className="size-3.5">
          <Icon icon={icon} className="size-3.5" />
        </Center>
      }
      activation={activation}
    >
      {/* The label stays ABSOLUTE — a chip sitting in prose has to say which day
          it means; only the `@` menu's options carry relative labels. */}
      {formatMention(new Date(iso), isReminder)}
    </LinkChip>
  );
}
