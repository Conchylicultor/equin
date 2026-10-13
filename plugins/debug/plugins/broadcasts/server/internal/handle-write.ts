import { writeFile } from "node:fs/promises";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { writeBroadcasts } from "../../shared/endpoints";
import { broadcastsPath } from "./broadcasts-file";

export const handleWrite = implement(writeBroadcasts, async ({ body }) => {
  const path = await broadcastsPath();
  await writeFile(path, JSON.stringify(body.entries, null, 2) + "\n", "utf-8");
  return { ok: true as const };
});
