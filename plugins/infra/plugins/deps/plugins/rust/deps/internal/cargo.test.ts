import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import {
  defineDep,
  depState,
  ensureDep,
} from "@plugins/infra/plugins/deps/deps";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import {
  cargoBinary,
  cargoBuild,
  cargoBuildArgv,
  cargoCommand,
  cargoEnv,
  crateTargetDir,
} from "./cargo";

const exec = execContextForTests();
let base: string;
let root: string;
let store: { cacheRoot: string; locksRoot: string };
/** Unique per test, so its dir in the shared cargo-target cache is its own. */
let crate: string;

const CARGO_TOML = `[package]
name = "hello"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "hello"
path = "src/main.rs"
`;
const CARGO_LOCK = `version = 4

[[package]]
name = "hello"
version = "0.1.0"
`;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "deps-rust-test-"));
  root = join(base, "repo");
  store = { cacheRoot: join(base, "cache"), locksRoot: join(base, "locks") };
  crate = `plugins/rust-kind-test-${Math.random().toString(36).slice(2, 10)}/rust`;
  mkdirSync(join(root, crate, "src"), { recursive: true });
  expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
  writeFileSync(join(root, crate, "Cargo.toml"), CARGO_TOML);
  writeFileSync(join(root, crate, "Cargo.lock"), CARGO_LOCK);
  writeFileSync(
    join(root, crate, "src", "main.rs"),
    'fn main() { println!("hello from the rust kind"); }\n',
  );
  // The checkout's toolchain: the kind runs cargo/rustc through mise's shims
  // from the repo root, so the throwaway repo carries this checkout's pins.
  copyFileSync(join(REPO_ROOT, "mise.toml"), join(root, "mise.toml"));
  copyFileSync(join(REPO_ROOT, "mise.lock"), join(root, "mise.lock"));
  writeFileSync(join(root, ".gitignore"), "plugins/**/rust/target/\n");
  process.env.MISE_TRUSTED_CONFIG_PATHS = root;
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(crateTargetDir(crate), { recursive: true, force: true });
  delete process.env.MISE_TRUSTED_CONFIG_PATHS;
});

function dep(source: ReturnType<typeof cargoBuild>) {
  return defineDep({
    id: "rust-test",
    owner: "infra/deps/rust",
    description: "",
    sizeHint: "",
    source,
    updates: { none: "built from this checkout's own source" },
  });
}

describe("cargoBuild", () => {
  test("rejects a crate that is not a plugin's rust/ folder, and a malformed bin", () => {
    expect(() => cargoBuild({ crate: "tauri/src-tauri", bin: "x" })).toThrow(
      "rust/ folder",
    );
    expect(() =>
      cargoBuild({
        crate: "plugins/infra/plugins/deps/plugins/rust/native",
        bin: "x",
      }),
    ).toThrow("rust/ folder");
    expect(() =>
      cargoBuild({
        crate: "plugins/infra/plugins/deps/plugins/rust/rust",
        bin: "a/b",
      }),
    ).toThrow("binary target");
    const then = async () => {};
    expect(() =>
      cargoBuild({
        crate: "plugins/infra/plugins/deps/plugins/rust/rust",
        bin: "x",
        output: "x.app",
        binary: "elsewhere/x",
        then,
      }),
    ).toThrow("inside output");
  });

  test("the built binary is env/<bin>, or the path inside then's output", () => {
    const plain = cargoBuild({
      crate: "plugins/infra/plugins/deps/plugins/rust/rust",
      bin: "tool",
    });
    expect(plain.output).toBe("tool");
    expect(plain.binary).toBe("tool");
    expect(plain.kind).toBe("build");
    const app = cargoBuild({
      crate: "plugins/infra/plugins/deps/plugins/rust/rust",
      bin: "tool",
      output: "Tool.app",
      binary: "Tool.app/Contents/MacOS/tool",
      then: async () => {},
    });
    expect(app.output).toBe("Tool.app");
    expect(app.binary).toBe("Tool.app/Contents/MacOS/tool");
  });

  test("argv: a locked release build of one bin by manifest path", () => {
    expect(
      cargoBuildArgv(
        "/r",
        "plugins/infra/plugins/deps/plugins/rust/rust",
        "tool",
      ),
    ).toEqual([
      "cargo",
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      "/r/plugins/infra/plugins/deps/plugins/rust/rust/Cargo.toml",
      "--bin",
      "tool",
    ]);
    expect(cargoCommand(["update"]).argv).toEqual(["cargo", "update"]);
  });

  test("env: mise's shims first, and the crate's own dir in the shared target cache", () => {
    const env = cargoEnv({
      targetDir: crateTargetDir("plugins/infra/plugins/deps/plugins/rust/rust"),
    });
    expect(env.CARGO_TARGET_DIR).toEndWith(
      "/cargo-target/plugins__infra__plugins__deps__plugins__rust__rust",
    );
    expect(env.PATH?.split(":")[0]).toEndWith("/mise/shims");
    expect(cargoEnv().CARGO_TARGET_DIR).toBe(process.env.CARGO_TARGET_DIR);
  });

  test("identity: every crate file, Cargo.lock required, and the rustc that builds it", async () => {
    const source = cargoBuild({ crate, bin: "hello" });
    const inputs = await source.identityInputs(root);
    expect(Object.keys(inputs).sort()).toEqual([
      `file:${crate}/Cargo.lock`,
      `file:${crate}/Cargo.toml`,
      `file:${crate}/src/main.rs`,
      "target",
      "tool",
    ]);
    expect(inputs.tool).toStartWith("rustc ");
    expect(inputs.tool).toContain("host: ");

    // target/ is ignored: a hand-run build inside the crate is not an input.
    mkdirSync(join(root, crate, "target"), { recursive: true });
    writeFileSync(join(root, crate, "target", "junk"), "x");
    expect(Object.keys(await source.identityInputs(root))).not.toContain(
      `file:${crate}/target/junk`,
    );

    rmSync(join(root, crate, "Cargo.lock"));
    expect((await depState(dep(source), { store, root })).kind).toBe("failed");
  });

  test("builds the crate with the checkout's cargo and copies the binary into env/", async () => {
    const d = dep(cargoBuild({ crate, bin: "hello" }));
    const ready = await ensureDep(d, exec, { store, root });
    const bin = cargoBinary(ready);
    expect(bin).toBe(join(ready.dir, "hello"));
    const out = spawnSync(bin, []);
    expect(out.status).toBe(0);
    expect(out.stdout.toString()).toBe("hello from the rust kind\n");
    // Compiled into the shared cache, not into the crate.
    expect(existsSync(join(crateTargetDir(crate), "release", "hello"))).toBe(
      true,
    );
    expect(existsSync(join(root, crate, "target"))).toBe(false);
  }, 300_000);

  test("then assembles the output from the built binary", async () => {
    const d = dep(
      cargoBuild({
        crate,
        bin: "hello",
        output: "Hello.app",
        binary: "Hello.app/Contents/MacOS/hello",
        then: async (ctx, built) => {
          mkdirSync(join(ctx.output, "Contents", "MacOS"), { recursive: true });
          copyFileSync(built, join(ctx.output, "Contents", "MacOS", "hello"));
        },
      }),
    );
    const ready = await ensureDep(d, exec, { store, root });
    expect(spawnSync(cargoBinary(ready), []).status).toBe(0);
  }, 300_000);

  test("a then that leaves no binary fails the install", async () => {
    const d = dep(
      cargoBuild({
        crate,
        bin: "hello",
        output: "Hello.app",
        binary: "Hello.app/hello",
        then: async (ctx) => {
          mkdirSync(ctx.output, { recursive: true });
        },
      }),
    );
    const err = await ensureDep(d, exec, { store, root }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("without leaving the binary");
  }, 300_000);
});
