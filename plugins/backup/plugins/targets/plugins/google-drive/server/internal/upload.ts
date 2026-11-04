import { stat } from "@plugins/packages/plugins/timed-fs/core";

export async function uploadToDrive(
  archivePath: string,
  folderId: string,
  filename: string,
  accessToken: string,
): Promise<{ fileId: string; webViewLink: string }> {
  const fileStat = await stat(archivePath);

  const initRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "application/gzip",
        "X-Upload-Content-Length": String(fileStat.size),
      },
      body: JSON.stringify({
        name: filename,
        parents: [folderId],
      }),
    },
  );
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => "");
    throw new Error(`Drive upload init: ${initRes.status} ${text}`);
  }
  const uploadUrl = initRes.headers.get("Location");
  if (!uploadUrl) {
    throw new Error("Drive upload init: missing Location header");
  }

  const file = Bun.file(archivePath);
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(fileStat.size),
    },
    body: file.stream(),
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => "");
    throw new Error(`Drive upload: ${uploadRes.status} ${text}`);
  }

  const result = (await uploadRes.json()) as {
    id: string;
    webViewLink: string;
  };
  return { fileId: result.id, webViewLink: result.webViewLink };
}
