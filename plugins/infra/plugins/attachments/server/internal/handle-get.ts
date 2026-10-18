import { getAttachment } from "./operations";
import { AttachmentBlobs } from "./blobs";

export async function handleGet(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = params.id;
  if (!id) return new Response("missing id", { status: 400 });

  const row = await getAttachment(id);
  if (!row) return new Response("not found", { status: 404 });

  const file = await AttachmentBlobs.get().read(row.diskPath);
  if (file === null) {
    return new Response("file missing on disk", { status: 410 });
  }

  return new Response(file, {
    headers: {
      "content-type": row.mime,
      "content-disposition": `inline; filename="${row.filename.replace(/"/g, "")}"`,
      "cache-control": "private, max-age=3600",
    },
  });
}
