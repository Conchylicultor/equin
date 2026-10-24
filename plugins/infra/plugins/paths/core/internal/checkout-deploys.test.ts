import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { deploysForCheckout, resolveCheckoutDeploy } from "./checkout-deploys";
import { SERVER_CORE_RELATIVE } from "./paths";

// Every test owns its own data root and its own checkouts on disk, because both
// sides of the match are real paths: the scan resolves symlinks through
// `realpathSync`, so a fixture whose directories do not exist would be testing a
// different comparison than the one that runs.

const ORIGINAL_ROOT = process.env.SINGULARITY_DIR;
const fixtures: string[] = [];

function fixture(): {
  /** A checkout root with a real `server-core` dir under it. */
  checkout: (name: string) => string;
  /** Write `<ns>/spec.json`, verbatim when given a string. */
  register: (ns: string, spec: object | string) => string;
  /**
   * A path that exists and cannot be resolved — two symlinks pointing at each
   * other, so `realpathSync` gives ELOOP.
   *
   * Stands in for every non-ENOENT resolution fault a `server` field can carry
   * on a real box (EACCES on a path component, EIO from a dead network mount).
   * A symlink cycle is the one that needs no permissions and no mounts, so it
   * is the same failure everywhere the suite runs.
   */
  loop: (name: string) => string;
  /** The registry dir itself, for the entries that are not namespaces. */
  worktrees: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "checkout-deploys-"));
  fixtures.push(dir);
  process.env.SINGULARITY_DIR = join(dir, "data");
  // The registry layout is spelled here rather than taken from
  // `worktreeArtifacts.spec`, which takes a `Namespace` — and one case below
  // registers a directory whose name is deliberately not one.
  const worktrees = join(dir, "data", "worktrees");
  return {
    checkout: (name) => {
      const root = join(dir, "checkouts", name);
      mkdirSync(join(root, SERVER_CORE_RELATIVE), { recursive: true });
      return root;
    },
    register: (ns, spec) => {
      mkdirSync(join(worktrees, ns), { recursive: true });
      const path = join(worktrees, ns, "spec.json");
      writeFileSync(
        path,
        typeof spec === "string" ? spec : JSON.stringify(spec),
      );
      return path;
    },
    loop: (name) => {
      const a = join(dir, `${name}-a`);
      const b = join(dir, `${name}-b`);
      symlinkSync(b, a);
      symlinkSync(a, b);
      return a;
    },
    worktrees,
  };
}

/** What a deploy of `root` writes into its spec's `server` field. */
const serverOf = (root: string): string => join(root, SERVER_CORE_RELATIVE);

/** Run `fn` with `console.warn` captured rather than printed. */
function capturingWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

afterEach(() => {
  if (ORIGINAL_ROOT === undefined) delete process.env.SINGULARITY_DIR;
  else process.env.SINGULARITY_DIR = ORIGINAL_ROOT;
});

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

describe("deploysForCheckout", () => {
  test("returns every namespace a checkout serves, its own app first", () => {
    const fx = fixture();
    const main = fx.checkout("singularity");
    fx.register("sonata", {
      server: serverOf(main),
      composition: "sonata",
    });
    fx.register("singularity", {
      server: serverOf(main),
      composition: "singularity",
    });

    expect(deploysForCheckout(main)).toEqual([
      {
        namespace: asNamespace("singularity"),
        composition: "singularity",
        isMainComposition: true,
      },
      {
        namespace: asNamespace("sonata"),
        composition: "sonata",
        isMainComposition: false,
      },
    ]);
  });

  test("a spec with no composition key is the main app (the legacy shape)", () => {
    const fx = fixture();
    const root = fx.checkout("singularity");
    fx.register("singularity", { server: serverOf(root) });

    expect(deploysForCheckout(root)).toEqual([
      {
        namespace: asNamespace("singularity"),
        composition: "singularity",
        isMainComposition: true,
      },
    ]);
  });

  test("another checkout's spec is not this checkout's deploy", () => {
    const fx = fixture();
    const main = fx.checkout("singularity");
    const worktree = fx.checkout("att-1");
    fx.register("singularity", { server: serverOf(main) });
    fx.register("att-1", { server: serverOf(worktree) });

    expect(deploysForCheckout(worktree).map((d) => d.namespace)).toEqual([
      asNamespace("att-1"),
    ]);
  });

  test("the central namespace is excluded by its server path alone", () => {
    const fx = fixture();
    const main = fx.checkout("singularity");
    mkdirSync(join(main, "plugins/framework/plugins/central-core"), {
      recursive: true,
    });
    fx.register("central", {
      server: join(main, "plugins/framework/plugins/central-core"),
    });

    expect(deploysForCheckout(main)).toEqual([]);
  });

  test("a directory name that is not a namespace is skipped, not thrown on", () => {
    const fx = fixture();
    const root = fx.checkout("singularity");
    // A legal directory a human or another tool left behind: `isNamespace` says
    // no, and `asNamespace` would throw and take every caller on the box down.
    fx.register("Not A Namespace", { server: serverOf(root) });
    fx.register("singularity", { server: serverOf(root) });

    expect(deploysForCheckout(root).map((d) => d.namespace)).toEqual([
      asNamespace("singularity"),
    ]);
  });

  test("a namespace dir with no spec.json is skipped even when nothing matches", () => {
    const fx = fixture();
    const root = fx.checkout("att-never-built");
    // Six of the ~70 dirs on a working box are in exactly this state.
    mkdirSync(join(fx.worktrees, "head-check"), { recursive: true });

    expect(deploysForCheckout(root)).toEqual([]);
  });

  test("a malformed spec is reported, not raised, once something matched", () => {
    const fx = fixture();
    const root = fx.checkout("singularity");
    fx.register("singularity", { server: serverOf(root) });
    const broken = fx.register("att-2", "{ not json");

    const { result, warnings } = capturingWarnings(() =>
      deploysForCheckout(root),
    );
    expect(result.map((d) => d.namespace)).toEqual([
      asNamespace("singularity"),
    ]);
    expect(warnings.join("\n")).toContain(broken);
  });

  test("a malformed spec throws when nothing matched — it may be the one", () => {
    const fx = fixture();
    const root = fx.checkout("att-3");
    const broken = fx.register("att-3", "{ not json");

    expect(() => deploysForCheckout(root)).toThrow(broken);
  });

  test("a server path that cannot be resolved is reported, not raised, once something matched", () => {
    const fx = fixture();
    const root = fx.checkout("singularity");
    fx.register("singularity", { server: serverOf(root) });
    // Somebody else's spec, and its fault is somebody else's: letting it out of
    // the scan would break every caller in every checkout on the machine.
    const broken = fx.register("att-tangled", { server: fx.loop("tangled") });

    const { result, warnings } = capturingWarnings(() =>
      deploysForCheckout(root),
    );
    expect(result.map((d) => d.namespace)).toEqual([
      asNamespace("singularity"),
    ]);
    expect(warnings.join("\n")).toContain(
      `${broken}: server path unresolvable (ELOOP)`,
    );
  });

  test("a server path that cannot be resolved throws when nothing matched", () => {
    const fx = fixture();
    const root = fx.checkout("att-tangled");
    const broken = fx.register("att-tangled", { server: fx.loop("tangled") });

    expect(() => deploysForCheckout(root)).toThrow(broken);
  });

  test("a spec whose server is not a path is malformed, not absent", () => {
    const fx = fixture();
    const root = fx.checkout("att-4");
    fx.register("att-4", { web: "/somewhere" });

    expect(() => deploysForCheckout(root)).toThrow(/"server" is not a path/);
  });

  test("a checkout reached through a symlink matches its own spec", () => {
    const fx = fixture();
    const real = fx.checkout("singularity");
    fx.register("singularity", { server: serverOf(real) });
    // The writer resolved `server` against git's toplevel; this reader comes in
    // through a symlink, as a `REPO_ROOT` derived from `import.meta.dir` can.
    const linked = join(real, "..", "linked");
    symlinkSync(real, linked);

    expect(deploysForCheckout(linked).map((d) => d.namespace)).toEqual([
      asNamespace("singularity"),
    ]);
  });
});

describe("resolveCheckoutDeploy", () => {
  test("with no composition it resolves the checkout's own app", () => {
    const fx = fixture();
    const root = fx.checkout("singularity");
    fx.register("sonata", { server: serverOf(root), composition: "sonata" });
    fx.register("singularity", { server: serverOf(root) });

    const resolution = resolveCheckoutDeploy(root);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") throw new Error("unreachable");
    expect(resolution.deploy.namespace).toBe(asNamespace("singularity"));
  });

  test("a never-built checkout resolves to none, with nothing to offer", () => {
    const fx = fixture();
    const other = fx.checkout("singularity");
    fx.register("singularity", { server: serverOf(other) });

    expect(resolveCheckoutDeploy(fx.checkout("att-5"))).toEqual({
      kind: "none",
      others: [],
      scanned: 1,
    });
  });

  test("the none arm counts what it examined, so a full registry cannot read as an empty one", () => {
    const fx = fixture();
    const root = fx.checkout("att-9");
    fx.register("singularity", { server: serverOf(fx.checkout("main")) });
    fx.register("sonata", {
      server: serverOf(fx.checkout("other")),
      composition: "sonata",
    });
    // Registered, with nothing in it yet: still a namespace this scan looked at.
    mkdirSync(join(fx.worktrees, "head-check"), { recursive: true });
    // Not a namespace, so never a candidate — and so never part of the count a
    // refusal quotes.
    fx.register("Not A Namespace", { server: serverOf(root) });

    expect(resolveCheckoutDeploy(root)).toEqual({
      kind: "none",
      others: [],
      scanned: 3,
    });
  });

  test("a composition-only build leaves the checkout's own app unserved", () => {
    const fx = fixture();
    const root = fx.checkout("att-6");
    fx.register("sonata.att-6", {
      server: serverOf(root),
      composition: "sonata",
    });

    expect(resolveCheckoutDeploy(root)).toEqual({
      kind: "none",
      others: [
        {
          namespace: asNamespace("sonata.att-6"),
          composition: "sonata",
          isMainComposition: false,
        },
      ],
      scanned: 1,
    });
  });

  test("two namespaces for one composition warn, naming the chosen and the ignored", () => {
    const fx = fixture();
    const root = fx.checkout("att-9");
    // What `./equin build` published, and what a `serve-app --name` (or a
    // spec left behind by a rename) published beside it. Both claim to be this
    // checkout's own app; only one can be.
    fx.register("att-9", { server: serverOf(root) });
    fx.register("preview", { server: serverOf(root) });

    const { result, warnings } = capturingWarnings(() =>
      resolveCheckoutDeploy(root),
    );
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("unreachable");
    expect(result.deploy.namespace).toBe(asNamespace("att-9"));
    expect(warnings.join("\n")).toContain("using att-9, ignoring preview");
  });

  test("a named composition resolves its own namespace", () => {
    const fx = fixture();
    const root = fx.checkout("att-7");
    fx.register("sonata.att-7", {
      server: serverOf(root),
      composition: "sonata",
    });
    fx.register("att-7", { server: serverOf(root) });

    const resolution = resolveCheckoutDeploy(root, "sonata");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") throw new Error("unreachable");
    expect(resolution.deploy.namespace).toBe(asNamespace("sonata.att-7"));
  });

  test("an unknown composition resolves to none, listing what is registered", () => {
    const fx = fixture();
    const root = fx.checkout("att-8");
    fx.register("att-8", { server: serverOf(root) });

    const resolution = resolveCheckoutDeploy(root, "nope");
    expect(resolution.kind).toBe("none");
    if (resolution.kind !== "none") throw new Error("unreachable");
    expect(resolution.others.map((d) => d.composition)).toEqual([
      "singularity",
    ]);
  });
});
