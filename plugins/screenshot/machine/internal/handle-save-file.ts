import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { saveScreenshotFile } from "../../shared/endpoints";

const DIR = join(tmpdir(), "singularity-screenshots");

export const handleSaveFile = implementMachine(
  saveScreenshotFile,
  async ({ body, params, req }) => {
    const id = params.id;
    if (!id) throw new HttpError(400, "missing id");
    if (!/^[A-Za-z0-9-]+$/.test(id)) {
      throw new HttpError(400, "invalid id");
    }
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/png")) {
      throw new HttpError(400, "expected content-type: image/png");
    }
    const bytes = new Uint8Array(await body.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new HttpError(400, "empty body");
    }
    await mkdir(DIR, { recursive: true });
    const path = join(DIR, `${id}.png`);
    await Bun.write(path, bytes);
    return { path };
  },
);
