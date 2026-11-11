import { useMemo, type ReactNode } from "react";
import { encode } from "uqr";
import {
  ownerMarkUrl,
  ownerUnmarkUrl,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import {
  SiteCard,
  SiteCardBody,
  type SiteProps,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { publicUrls } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { NewTabLink } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { useShipsAnalytics } from "../internal/use-analytics-available";

const TITLE = "Your devices";

/**
 * **Your devices** — how the site's owner keeps their own reading out of the
 * visitor counts: open the mark link once in each browser they read the site
 * in (the QR code carries it to a phone). The site stores a flag in that
 * browser and every later visit from it is counted under "You", never
 * "Visitors" (collect's `audience.ts`). Absent when the site ships no
 * analytics.
 */
export function OwnerDevicesCard({ deployment }: SiteProps): ReactNode {
  const ships = useShipsAnalytics(deployment.id);
  // Only `yes` has anything to mark; the traffic cards beside it already
  // show the gate's loading and failure.
  if (ships.kind !== "yes") return null;
  const [siteUrl] = publicUrls(deployment.hostnames);
  return (
    <SiteCard title={TITLE}>
      <SiteCardBody>
        {siteUrl === undefined ? (
          <Text variant="caption" tone="muted">
            This site has no hostname yet, so there is no page to open on your
            devices.
          </Text>
        ) : (
          <MarkLinks siteUrl={siteUrl} />
        )}
      </SiteCardBody>
    </SiteCard>
  );
}

function MarkLinks({ siteUrl }: { siteUrl: string }): ReactNode {
  const mark = ownerMarkUrl(siteUrl);
  return (
    <Stack gap="sm">
      <Text variant="caption" tone="muted">
        Open this link once on each browser you read the site in. Your visits
        from it then count under “You”, not as visitors.
      </Text>
      <NewTabLink href={mark}>
        <Text as="span" variant="label">
          Mark this browser as mine
        </Text>
      </NewTabLink>
      <Text variant="caption" tone="muted">
        On your phone, scan:
      </Text>
      <Center>
        <QrCode text={mark} label={`QR code of ${mark}`} />
      </Center>
      <Text variant="caption" tone="faint">
        A private window or cleared site data forgets the mark.{" "}
        <NewTabLink href={ownerUnmarkUrl(siteUrl)}>Unmark a browser</NewTabLink>
      </Text>
    </Stack>
  );
}

/**
 * `text` as a QR code: dark modules on a light tile whatever the theme, since
 * a phone camera reads dark-on-light reliably and the inverse often not.
 */
function QrCode({ text, label }: { text: string; label: string }): ReactNode {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 2 });
    const parts: string[] = [];
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) parts.push(`M${x} ${y}h1v1h-1z`);
      }),
    );
    return { size: qr.size, path: parts.join("") };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-40 rounded-md bg-white text-black"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
