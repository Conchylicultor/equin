import { declaredApps } from "@plugins/apps-core/server";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { getAppIconPng, installableApp, parseAppIconFile } from "../../core";
import { appIconPng } from "./icon-png";

/**
 * `GET /api/apps/:appId/icon/:file` (`getAppIconPng`, needsMachine) — a raw
 * handler: a binary answer with its own cache header.
 */
export const handleAppIcon = machineHandler(getAppIconPng, (_req, params) => {
  const app = installableApp(declaredApps, params.appId ?? "");
  const size = parseAppIconFile(params.file ?? "");
  if (app === undefined || size === null) {
    return new Response(
      `No icon "${params.file}" for app "${params.appId}" (sizes: 192, 512, 1024 PNG; listed apps only).`,
      { status: 404 },
    );
  }
  return new Response(appIconPng(app, size), {
    headers: {
      "content-type": "image/png",
      "cache-control": "no-cache",
    },
  });
});
