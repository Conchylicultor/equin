import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  SiteBanner,
  SiteCheck,
  SiteHeader,
  SiteStrip,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { ClientFields } from "@plugins/network/plugins/live/web";
import { releaseFields } from "../core";
import { ReleaseFieldResolver } from "./components/release-field";
import {
  BundleCell,
  DeployButton,
  DeployedCell,
  RunningCell,
  StatusCell,
  useBehindMainBanner,
  useDeployingBanner,
} from "./components/site-parts";
import { useBundleCheck } from "./internal/bundle-check";
import { releasePresentation } from "./internal/presentation";

export default {
  description:
    "Deploy one composition to its remote server, on the site page: the header's Deploy button launching the `update` sequence (converge → build a platform-pinned candidate unless one is already current → ship that pinned run id), labelled by what it would do now (Redeploy / Deploy N commits / Retry deploy / Deploying…); the production strip's Status, Running (sha + subject), Deployed and Bundle cells; the deploying banner (the three legs and the tail of the log the running leg writes) and the behind-main banner; and the `Release` client field (`releaseFields`) of the deployments list.",
  contributions: [
    SiteHeader.Action({ id: "deploy", component: DeployButton }),
    SiteStrip.Cell({ id: "status", label: "Status", component: StatusCell }),
    SiteStrip.Cell({ id: "running", label: "Running", component: RunningCell }),
    SiteStrip.Cell({
      id: "deployed",
      label: "Deployed",
      component: DeployedCell,
    }),
    SiteStrip.Cell({ id: "bundle", label: "Bundle", component: BundleCell }),
    SiteBanner({ id: "deploying", useBanner: useDeployingBanner }),
    SiteBanner({ id: "behind-main", useBanner: useBehindMainBanner }),
    SiteCheck({ id: "bundle", useCheck: useBundleCheck }),
    ClientFields.Resolve({
      fields: releaseFields,
      component: ReleaseFieldResolver,
    }),
    releasePresentation,
  ],
} satisfies PluginDefinition;
