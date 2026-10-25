import { basename } from "node:path";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { getConfig } from "@plugins/config_v2/server";
import { getTokenFromCentral } from "@plugins/auth/server";
import type { BackupArchive, BackupTargetResult } from "@plugins/backup/core";
import { googleDriveBackupConfig } from "../../shared/config";
import { GOOGLE_DRIVE_SCOPES } from "../../shared/scopes";
import { ensureFolder } from "./folder";
import { uploadToDrive } from "./upload";
import { pruneOldBackups } from "./retention";

export async function runGoogleDriveTarget(
  archive: BackupArchive,
): Promise<BackupTargetResult> {
  const { enabled, keepLast } = getConfig(googleDriveBackupConfig);
  if (!enabled) {
    return { targetId: "google-drive", ok: true, detail: "disabled" };
  }

  const tokenResult = await getTokenFromCentral({
    providerId: "google",
    scopes: [...GOOGLE_DRIVE_SCOPES],
  });

  if (!tokenResult.ok) {
    if (tokenResult.needsConsent) {
      return {
        targetId: "google-drive",
        ok: false,
        needsConsent: true,
        detail: `Google account not connected or missing Drive scope (${tokenResult.reason})`,
        consent: { providerId: "google", scopes: [...GOOGLE_DRIVE_SCOPES] },
      };
    }
    return {
      targetId: "google-drive",
      ok: false,
      detail: "message" in tokenResult ? tokenResult.message : "unknown error",
    };
  }

  const { accessToken } = tokenResult;
  const folderId = await ensureFolder(accessToken);

  const filename = `${PRODUCT_NAME}-backup-${basename(archive.stagingDir)}.tar.gz`;
  const { webViewLink } = await uploadToDrive(
    archive.archivePath,
    folderId,
    filename,
    accessToken,
  );

  const { failures } = await pruneOldBackups(folderId, keepLast, accessToken);

  // The upload succeeded, but if retention could not delete old archives the
  // run is degraded, not ok. The schema has no per-target partial state, so
  // report ok:false with a detail that preserves the upload link.
  if (failures.length > 0) {
    return {
      targetId: "google-drive",
      ok: false,
      detail: `Uploaded (${webViewLink}), but retention failed to delete ${failures.length} old backup(s): ${failures.join("; ")}`,
    };
  }

  return { targetId: "google-drive", ok: true, detail: webViewLink };
}
