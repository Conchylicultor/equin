import type { ReactNode } from "react";
import type {
  Contribution,
  SealContributions,
} from "@plugins/framework/plugins/web-sdk/core";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  renderAsContribution,
  useSlotOrder,
} from "@plugins/primitives/plugins/slot-render/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { Deployment } from "../../core";
import {
  SiteBanner,
  type SiteBannerContribution,
  type SiteBannerSpec,
  type SiteBannerTone,
} from "../slots";

const TONE_ROW: Record<SiteBannerTone, string> = {
  info: "bg-primary/[0.07]",
  warning: "bg-warning/[0.07]",
  destructive: "bg-destructive/[0.07]",
};
const TONE_ICON: Record<SiteBannerTone, string> = {
  info: "text-primary-text",
  warning: "text-warning",
  destructive: "text-destructive",
};

type Banner = SealContributions<SiteBannerContribution>;

/**
 * The one banner under the production strip: the FIRST contribution, in the
 * slot's layout order, whose `useBanner` answers non-null. Each contribution's
 * hook runs in its own link of a chain — a link that answers `null` renders the
 * next one, a link still `"pending"` renders nothing below it — so hooks never
 * run in a loop, a banner that stops applying simply hands over to the one
 * after it, and a lower banner never flashes before a higher one is known.
 */
export function SiteBannerHost({
  deployment,
}: {
  deployment: Deployment;
}): ReactNode {
  const order = useSlotOrder(SiteBanner);
  const banners = foldResource(order, {
    // A banner is attention, not data: while the order is unknown there is
    // simply none yet.
    loading: (): readonly Banner[] | null => null,
    error: (_error, stale) => stale ?? null,
    ready: (list) => list,
  });
  if (banners === null || banners.length === 0) return null;
  return <BannerLink banners={banners} index={0} deployment={deployment} />;
}

function BannerLink({
  banners,
  index,
  deployment,
}: {
  banners: readonly Banner[];
  index: number;
  deployment: Deployment;
}): ReactNode {
  const banner = banners[index];
  if (!banner) return null;
  return (
    <BannerProbe
      key={banner.id}
      banner={banner}
      useBanner={banner.useBanner}
      deployment={deployment}
      next={
        <BannerLink
          banners={banners}
          index={index + 1}
          deployment={deployment}
        />
      }
    />
  );
}

function BannerProbe({
  banner,
  useBanner,
  deployment,
  next,
}: {
  banner: Banner;
  useBanner: Banner["useBanner"];
  deployment: Deployment;
  next: ReactNode;
}): ReactNode {
  const spec = useBanner({ deployment });
  if (spec === "pending") return null;
  if (spec === null) return next;
  return renderAsContribution(
    SiteBanner,
    banner as unknown as Contribution,
    <BannerView spec={spec} />,
  );
}

/** One banner: a tinted row (icon · title · body · actions) over its optional detail. */
function BannerView({ spec }: { spec: SiteBannerSpec }): ReactNode {
  return (
    <Stack gap="none" className="border-t border-border/60">
      <Inset x="md" y="sm" className={TONE_ROW[spec.tone]}>
        <Stack direction="row" align="center" gap="sm">
          <Rigid className={TONE_ICON[spec.tone]}>
            <Icon icon={spec.icon} />
          </Rigid>
          <Fill>
            <Text as="p" variant="caption" tone="muted">
              <Text as="span" variant="caption" tone="strong">
                {spec.title}
              </Text>
              {spec.body != null && <> {spec.body}</>}
            </Text>
          </Fill>
          {spec.actions != null && (
            <ControlSizeProvider size="sm">
              <Inline gap="xs">{spec.actions}</Inline>
            </ControlSizeProvider>
          )}
        </Stack>
      </Inset>
      {spec.detail != null && (
        <div className="border-t border-border/60">{spec.detail}</div>
      )}
    </Stack>
  );
}
