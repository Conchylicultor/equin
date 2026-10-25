import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeFolder } from "./folder-status";

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "midi-folder-status-")));
  mkdirSync(join(root, "ok"));
  writeFileSync(join(root, "file.mid"), "");
  mkdirSync(join(root, "locked"));
  chmodSync(join(root, "locked"), 0o000);
});

afterAll(() => {
  chmodSync(join(root, "locked"), 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("probeFolder", () => {
  test("a readable folder is ok, keyed by its real path", () => {
    expect(probeFolder(join(root, "ok"))).toEqual({
      state: "ok",
      path: join(root, "ok"),
      dir: join(root, "ok"),
    });
  });

  test("nothing at the path is missing", () => {
    expect(probeFolder(join(root, "gone")).state).toBe("missing");
  });

  test("a component above the folder being a file is missing", () => {
    expect(probeFolder(join(root, "file.mid", "sub")).state).toBe("missing");
  });

  test("a file is not a folder", () => {
    expect(probeFolder(join(root, "file.mid")).state).toBe("not-a-folder");
  });

  // Root reads every folder whatever its mode, so the refusal only exists
  // for an ordinary user.
  test.skipIf(process.getuid?.() === 0)(
    "a folder the OS refuses to open is denied, with the errno",
    () => {
      const status = probeFolder(join(root, "locked"));
      expect(status.state).toBe("denied");
      if (status.state === "denied") expect(status.code).toBe("EACCES");
    },
  );
});
