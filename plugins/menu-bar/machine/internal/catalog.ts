import { declaredApps } from "@plugins/apps-core/server";
import { appIconSvg } from "@plugins/apps-core/plugins/app-manifest/machine";
import {
  APP_ICON_SIZES,
  appIconPath,
  installableApp,
} from "@plugins/apps-core/plugins/app-manifest/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import { getAppCatalog, type AppCatalog, type CatalogApp } from "../../core";

/**
 * An app as the native helper installs it. Its fingerprint hashes everything
 * the shim is written from on this side — id, name, base path and the icon's
 * picture — so a renamed app, a moved one or a changed icon is a stale shim.
 */
function catalogApp(app: AppRef): CatalogApp {
  return {
    id: app.id,
    name: app.name,
    basePath: app.basePath,
    hash: hashHex(
      JSON.stringify([app.id, app.name, app.basePath, appIconSvg(app)]),
    ),
    icons: APP_ICON_SIZES.map((size) => ({
      size,
      path: appIconPath(app.id, size),
    })),
  };
}

/** Every installable app (listed; unlisted ones such as the panel are not). */
export function appCatalog(): AppCatalog {
  return {
    apps: declaredApps.flatMap((d) => {
      const app = installableApp(declaredApps, d.app.id);
      return app === undefined ? [] : [catalogApp(app)];
    }),
  };
}

/** `GET /api/menu-bar/apps` (`getAppCatalog`, needsMachine). */
export const handleAppCatalog = implementMachine(getAppCatalog, () =>
  appCatalog(),
);
