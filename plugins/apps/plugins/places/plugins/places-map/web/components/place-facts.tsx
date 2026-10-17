import type { ReactNode } from "react";
import {
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleProvider,
  useCollapsibleContext,
} from "@plugins/primitives/plugins/collapsible/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { PlaceRichDetails } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  compactCount,
  openLine,
  weekRows,
  type OpenTone,
} from "../internal/place-facts";

const starIcon = symbol("star");
const hoursIcon = symbol("schedule");
const phoneIcon = symbol("call");
const webIcon = symbol("language");

/** The open-now line's colour per tone; the rest of the line stays muted. */
const TONE_CLASS: Record<OpenTone, string> = {
  open: "text-success",
  soon: "text-warning",
  closed: "text-destructive",
};

/** The open-now clock: re-read each minute, so "Closes soon" turns up on time. */
const MINUTE_MS = 60_000;

/** "4.7 ★★★★★ (182k) · €€" — Google's rating, its count, the price ramp. */
export function RatingLine({
  details,
}: {
  details: PlaceRichDetails;
}): ReactNode {
  const { rating, ratingCount, priceLevel } = details;
  if (rating === undefined && priceLevel === undefined) return null;
  return (
    <Cluster gap="2xs" align="center">
      {rating !== undefined ? (
        <>
          <Text variant="caption" tone="strong">
            {rating.toFixed(1)}
          </Text>
          <Line className="text-warning" aria-label={`${rating} out of 5`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Icon
                key={n}
                icon={starIcon}
                active={n <= Math.round(rating)}
                className={cn(
                  "size-3.5",
                  n > Math.round(rating) && "opacity-35",
                )}
              />
            ))}
          </Line>
          {ratingCount !== undefined ? (
            <Text
              variant="caption"
              tone="muted"
            >{`(${compactCount(ratingCount)})`}</Text>
          ) : null}
        </>
      ) : null}
      {priceLevel !== undefined && priceLevel > 0 ? (
        <Text variant="caption" tone="muted">
          {`${rating !== undefined ? "· " : ""}${"€".repeat(priceLevel)}`}
        </Text>
      ) : null}
    </Cluster>
  );
}

/** "● Open · closes 22:30" under the name, read in the place's own clock. */
export function OpenNowLine({
  details,
}: {
  details: PlaceRichDetails;
}): ReactNode {
  const now = useNow(MINUTE_MS);
  if (details.hours === undefined) return null;
  const line = openLine(details.hours, details.utcOffsetMinutes, new Date(now));
  return (
    <Line className="gap-xs">
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          TONE_CLASS[line.tone],
        )}
      />
      <Text variant="caption" tone="strong" className={TONE_CLASS[line.tone]}>
        {line.word}
      </Text>
      {line.rest !== null ? (
        <Text variant="caption" tone="muted">{`· ${line.rest}`}</Text>
      ) : null}
    </Line>
  );
}

/** One fact of the card: its icon, the fact, an action on the right. */
export function InfoRow({
  icon,
  children,
  action,
}: {
  icon: IconRef;
  children: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <Stack
      direction="row"
      align="center"
      gap="md"
      className="min-h-10 border-t py-xs first:border-t-0"
    >
      <Icon icon={icon} className="size-5 text-muted-foreground" />
      <Fill>{children}</Fill>
      {action}
    </Stack>
  );
}

/**
 * The opening-hours row: today's state, folding out Google's whole week
 * (Monday first, the place's today in bold).
 */
export function HoursRow({
  details,
}: {
  details: PlaceRichDetails;
}): ReactNode {
  const now = useNow(MINUTE_MS);
  const { hours } = details;
  if (hours === undefined) return null;
  const line = openLine(hours, details.utcOffsetMinutes, new Date(now));
  return (
    <CollapsibleProvider>
      <HoursTrigger tone={line.tone} word={line.word} rest={line.rest} />
      <CollapsibleContent>
        <Stack gap="2xs" className="pb-xs pl-xl">
          {weekRows(hours, details.utcOffsetMinutes, new Date(now)).map((r) => (
            <Line key={r.day} className="gap-md">
              <Fill>
                <Text variant="caption" tone={r.today ? "strong" : "muted"}>
                  {r.day}
                </Text>
              </Fill>
              <Text variant="caption" tone={r.today ? "strong" : "muted"}>
                {r.hours}
              </Text>
            </Line>
          ))}
        </Stack>
      </CollapsibleContent>
    </CollapsibleProvider>
  );
}

function HoursTrigger({
  tone,
  word,
  rest,
}: {
  tone: OpenTone;
  word: string;
  rest: string | null;
}): ReactNode {
  const ctx = useCollapsibleContext();
  if (ctx === null)
    throw new Error("HoursTrigger outside its CollapsibleProvider");
  return (
    <Line
      as="button"
      type="button"
      aria-expanded={ctx.open}
      aria-controls={ctx.contentId}
      onClick={ctx.toggle}
      className="min-h-10 w-full gap-md border-t py-xs text-left first:border-t-0"
    >
      <Icon icon={hoursIcon} className="size-5 text-muted-foreground" />
      <Fill>
        <Text variant="body">
          <span className={cn("font-semibold", TONE_CLASS[tone])}>{word}</span>
          {rest !== null ? ` · ${rest}` : null}
        </Text>
      </Fill>
      <CollapsibleChevron open={ctx.open} />
    </Line>
  );
}

/** The phone row: a `tel:` link and a copy button. */
export function PhoneRow({ phone }: { phone: string }): ReactNode {
  return (
    <InfoRow
      icon={phoneIcon}
      action={<CopyButton text={phone} tooltip="Copy number" />}
    >
      <Button
        variant="link"
        aspect="inline"
        render={<a href={`tel:${phone.replaceAll(" ", "")}`} />}
      >
        {phone}
      </Button>
    </InfoRow>
  );
}

/** The website row: its host, opening the site in a new tab. */
export function WebsiteRow({ website }: { website: string }): ReactNode {
  const host = new URL(website).host.replace(/^www\./, "");
  return (
    <InfoRow icon={webIcon}>
      <Button
        variant="link"
        aspect="inline"
        render={<a href={website} target="_blank" rel="noreferrer" />}
      >
        {host}
      </Button>
    </InfoRow>
  );
}
