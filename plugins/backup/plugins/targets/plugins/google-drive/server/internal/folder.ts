import {
  LEGACY_PRODUCT_NAMES,
  PRODUCT_NAME,
} from "@plugins/framework/plugins/product-name/core";

const FOLDER_NAME = `${PRODUCT_NAME} Backups`;
/**
 * The folder's names before the product was renamed. An install that backed up
 * under one has its archives there, so that folder is renamed in place rather
 * than a new, empty one created beside it.
 */
const LEGACY_FOLDER_NAMES = LEGACY_PRODUCT_NAMES.map((n) => `${n} Backups`);
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";

/** The three Drive calls resolving the backup folder needs. */
export interface DriveFolders {
  /** The id of a live (untrashed) folder with exactly this name, if any. */
  find(name: string): Promise<string | null>;
  rename(id: string, name: string): Promise<void>;
  create(name: string): Promise<string>;
}

/**
 * The backup folder's id: the current-named folder, else a legacy-named one
 * renamed to the current name, else a new one.
 */
export async function resolveFolder(drive: DriveFolders): Promise<string> {
  const current = await drive.find(FOLDER_NAME);
  if (current !== null) return current;
  for (const legacy of LEGACY_FOLDER_NAMES) {
    const id = await drive.find(legacy);
    if (id === null) continue;
    await drive.rename(id, FOLDER_NAME);
    return id;
  }
  return drive.create(FOLDER_NAME);
}

function driveFolders(accessToken: string): DriveFolders {
  const auth = { Authorization: `Bearer ${accessToken}` };
  return {
    async find(name) {
      const res = await fetch(
        `${FILES_URL}?q=${encodeURIComponent(
          `name='${name}' and mimeType='${FOLDER_MIME}' and trashed=false`,
        )}&fields=files(id)`,
        { headers: auth },
      );
      if (!res.ok) throw new Error(`Drive folder search: ${res.status}`);
      const { files } = (await res.json()) as { files: { id: string }[] };
      return files[0]?.id ?? null;
    },
    async rename(id, name) {
      const res = await fetch(`${FILES_URL}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`Drive folder rename: ${res.status}`);
    },
    async create(name) {
      const res = await fetch(FILES_URL, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
      });
      if (!res.ok) throw new Error(`Drive folder create: ${res.status}`);
      const created = (await res.json()) as { id: string };
      return created.id;
    },
  };
}

let cachedFolderId: string | null = null;

export async function ensureFolder(accessToken: string): Promise<string> {
  if (cachedFolderId) return cachedFolderId;
  cachedFolderId = await resolveFolder(driveFolders(accessToken));
  return cachedFolderId;
}
