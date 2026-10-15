import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DeploymentDetail } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { ClientFields } from "@plugins/network/plugins/live/web";
import { releaseFields } from "../core";
import { RemoteDeploySection } from "./components/remote-deploy-section";
import { OutputSection } from "./components/output-section";
import { ReleaseFieldResolver } from "./components/release-field";
import { releasePresentation } from "./internal/presentation";

export default {
  description:
    "Deploy one composition to its remote server: a single Deploy button launching the `update` sequence (converge → build a platform-pinned candidate unless one is already current → ship that pinned run id), the three-phase report of the running deploy, what is currently built and how it relates to HEAD, the public URLs to inspect the deployed app, the phase-following deploy/build log output section, and the `Release` client field (`releaseFields`) of the deployments list.",
  contributions: [
    DeploymentDetail.Section({
      id: "deploy",
      label: "Deploy to server",
      component: RemoteDeploySection,
    }),
    DeploymentDetail.Section({
      id: "output",
      label: "Output",
      component: OutputSection,
    }),
    ClientFields.Resolve({
      fields: releaseFields,
      component: ReleaseFieldResolver,
    }),
    releasePresentation,
  ],
} satisfies PluginDefinition;
