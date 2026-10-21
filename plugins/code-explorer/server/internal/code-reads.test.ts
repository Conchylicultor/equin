import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCheckoutRoot } from "./checkout-root";
import { resolveInsideRoot } from "./contained-path";
import { handleImageContent } from "./image-handler";

// Fixture:
//   base/
//     repo/          (git init; a.txt, sub/b.txt, pic.png)
//     link-to-repo -> repo
//     plain/         (not a checkout)
//     outside.txt / outside.png
let base: string;
let repo: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "code-reads-test-")));
  repo = join(base, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, "a.txt"), "inside");
  writeFileSync(join(repo, "sub", "b.txt"), "nested");
  writeFileSync(join(repo, "pic.png"), "png-bytes");
  mkdirSync(join(base, "plain"));
  writeFileSync(join(base, "outside.txt"), "secret");
  writeFileSync(join(base, "outside.png"), "png-bytes");
  symlinkSync(repo, join(base, "link-to-repo"));
  const init = Bun.spawnSync(["git", "init", "-q", repo]);
  expect(init.exitCode).toBe(0);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveCheckoutRoot", () => {
  test("accepts a checkout's toplevel", async () => {
    expect(await resolveCheckoutRoot(repo)).toBe(repo);
  });

  test("accepts a symlink to the toplevel, answering the real path", async () => {
    expect(await resolveCheckoutRoot(join(base, "link-to-repo"))).toBe(repo);
  });

  test("rejects a folder inside a checkout", async () => {
    expect(await resolveCheckoutRoot(join(repo, "sub"))).toBeNull();
  });

  test("rejects a folder that is not in a checkout", async () => {
    expect(await resolveCheckoutRoot(join(base, "plain"))).toBeNull();
  });

  test("rejects a missing or relative path", async () => {
    expect(await resolveCheckoutRoot(join(base, "nope"))).toBeNull();
    expect(await resolveCheckoutRoot("repo")).toBeNull();
  });
});

describe("resolveInsideRoot", () => {
  test("resolves a relative path inside the root", () => {
    expect(resolveInsideRoot(repo, "sub/b.txt")).toBe(join(repo, "sub/b.txt"));
  });

  test("rejects absolute, ~, escaping, empty and NUL paths", () => {
    for (const p of [
      join(repo, "a.txt"),
      "~/x",
      "~",
      "../outside.txt",
      "sub/../../outside.txt",
      "",
      "a\0b",
    ]) {
      expect(resolveInsideRoot(repo, p)).toBeNull();
    }
  });
});

describe("GET /image reads", () => {
  const image = (path: string) => {
    const query = new URLSearchParams({ path }).toString();
    const url = `http://x/api/code/${encodeURIComponent(repo)}/image?${query}`;
    return handleImageContent(new Request(url), { worktree: repo });
  };

  test("serves a relative path in a checkout addressed by its root", async () => {
    const res = await image("pic.png");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png-bytes");
  });

  test("rejects an absolute path without a ref", async () => {
    expect((await image(join(base, "outside.png"))).status).toBe(400);
  });

  test("rejects a ~ path without a ref", async () => {
    expect((await image("~/Desktop/shot.png")).status).toBe(400);
  });

  test("404s a worktree path that is not a checkout root", async () => {
    const res = await handleImageContent(
      new Request("http://x/image?path=b.png"),
      { worktree: join(repo, "sub") },
    );
    expect(res.status).toBe(404);
  });
});
