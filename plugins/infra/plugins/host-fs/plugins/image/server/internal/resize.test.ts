import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { makeResizedHandler } from "./resize";
import { sizeOf, uprightSize } from "./sizes";

let root: string;
let cache: string;
const handle = makeResizedHandler(() => cache);

/** A 400×200 JPEG whose EXIF says "turn a quarter" (shown 200×400). */
async function turnedJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 400, height: 200, channels: 3, background: "#c33" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

function get(path: string, edge: number | string, v = "x") {
  const q = new URLSearchParams({ path, edge: String(edge), v });
  return handle(new Request(`http://localhost/api/host-fs/image/resized?${q}`));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "host-fs-image-"));
  cache = join(root, ".cache");
  writeFileSync(join(root, "turned.jpg"), await turnedJpeg());
  writeFileSync(
    join(root, "alpha.png"),
    await sharp({
      create: {
        width: 50,
        height: 50,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer(),
  );
  writeFileSync(join(root, "garbage.jpg"), "not an image");
  writeFileSync(join(root, "notes.txt"), "hello");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resized", () => {
  test("rotates upright and shrinks to the edge", async () => {
    const res = await get(join(root, "turned.jpg"), 160);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const meta = await sharp(await res.bytes()).metadata();
    expect([meta.width, meta.height]).toEqual([80, 160]);
  });

  test("never enlarges", async () => {
    const res = await get(join(root, "turned.jpg"), 2560);
    const meta = await sharp(await res.bytes()).metadata();
    expect([meta.width, meta.height]).toEqual([200, 400]);
  });

  test("keeps transparency as WebP", async () => {
    const res = await get(join(root, "alpha.png"), 160);
    expect(res.headers.get("content-type")).toBe("image/webp");
  });

  test("a second request is a cache hit; a new version is a new copy", async () => {
    const path = join(root, "turned.jpg");
    await get(path, 320);
    const before = readdirSync(cache).length;
    await get(path, 320);
    expect(readdirSync(cache).length).toBe(before);
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await get(path, 320);
    expect(readdirSync(cache).length).toBe(before + 1);
  });

  test("immutable only for the version the URL names", async () => {
    const path = join(root, "alpha.png");
    const stale = await get(path, 160, "0-0");
    expect(stale.headers.get("cache-control")).toBe("no-cache");
    const file = Bun.file(path);
    const { mtimeMs } = await file.stat();
    const fresh = await get(path, 160, `${mtimeMs}-${file.size}`);
    expect(fresh.headers.get("cache-control")).toContain("immutable");
  });

  test("failures are statuses", async () => {
    expect((await get(join(root, "garbage.jpg"), 160)).status).toBe(415);
    expect((await get(join(root, "nope.jpg"), 160)).status).toBe(404);
    expect((await get(root, 160)).status).toBe(400);
    expect((await get(join(root, "turned.jpg"), 100)).status).toBe(400);
    expect((await get("relative.jpg", 160)).status).toBe(400);
  });
});

describe("sizes", () => {
  test("upright sizes, read from the headers", async () => {
    expect(await sizeOf(join(root, "alpha.png"))).toEqual({
      kind: "known",
      width: 50,
      height: 50,
    });
    expect(await sizeOf(join(root, "garbage.jpg"))).toEqual({
      kind: "unreadable",
    });
    expect(await sizeOf(join(root, "turned.jpg"))).toEqual({
      kind: "known",
      width: 200,
      height: 400,
    });
  });

  test("a missing file has no size", async () => {
    expect(await sizeOf(join(root, "nope.jpg"))).toBeNull();
  });

  test("uprightSize", () => {
    expect(uprightSize({ width: 3, height: 2, orientation: 8 })).toEqual({
      kind: "known",
      width: 2,
      height: 3,
    });
    expect(uprightSize({ width: 3 })).toEqual({ kind: "unreadable" });
  });
});
