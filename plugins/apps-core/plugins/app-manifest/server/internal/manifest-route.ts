import { declaredApps } from "@plugins/apps-core/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { appManifestFor, getAppManifest, installableApp } from "../../core";

/** `GET /api/apps/:appId/manifest.webmanifest` — 404 for an app that cannot be installed. */
export const handleAppManifest = implement(getAppManifest, ({ params }) => {
  const app = installableApp(declaredApps, params.appId);
  if (app === undefined) {
    throw new HttpError(
      404,
      `No installable app "${params.appId}" (unknown, or unlisted).`,
    );
  }
  return appManifestFor(app);
});
