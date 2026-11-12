/**
 * The portable registry over its two host services, with no file in sight: the
 * user layer is `createMemoryConfigStore()` (wrapped to record every `edit`),
 * the committed layer a fixture answering `document` from a set.
 *
 * `initRegistry` reads its registrations from collected contributions, so the
 * suite fakes a collect of its own two descriptors (cleared after, so no later
 * suite reads them), and provides the services through `withHostServices` —
 * scoped to each call, never the process-wide unbooted set the preload owns.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import {
  clearCollectedContributions,
  withHostServices,
} from "@plugins/framework/plugins/server-core/core/testing";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import {
  computeHash,
  createMemoryConfigStore,
  defineConfig,
  type ConfigDocRef,
  type ConfigFileRef,
  type ConfigStoreImpl,
  type JsonValue,
} from "../../core";
import { ConfigV2 } from "./contribution";
import { ConfigGitLayer, ConfigStore } from "./host-services";
import {
  acknowledgeConflictByPath,
  deleteOverrideByPath,
  getConfig,
  hasConfigDocument,
  initRegistry,
  mergeConflictByPath,
  onDocumentChange,
  reloadConfigDocument,
  resetConfigByPath,
  setConfig,
  setConfigByPath,
  shutdownRegistry,
  watchConfig,
  type ConfigDocumentTuple,
} from "./registry";
import { configValuesServed } from "./resource";
import { getConfigScopeIds } from "./resource";
import { forkDescriptorScope, removeDescriptorScope } from "./scope-fork";

const alpha = defineConfig({
  name: "alpha",
  fields: {
    enabled: boolField({ label: "Enabled", default: true }),
    title: textField({ label: "Title", default: "hello" }),
  },
});
const beta = defineConfig({
  name: "beta",
  fields: { title: textField({ label: "Title", default: "b" }) },
});

const PLUGIN = "registry-test";
const ALPHA = `${PLUGIN}/alpha.jsonc`;
const BETA = `${PLUGIN}/beta.jsonc`;
const writer = systemOrigin("registry-test");

const memory = createMemoryConfigStore();
const edits: { doc: ConfigDocRef; operation: string }[] = [];
// The memory store, recording every write the registry routes through `edit`
// — the hook the desktop's agent-write ledger hangs off.
const store: ConfigStoreImpl = {
  ...memory,
  edit: (doc, w, operation, mutate) => {
    edits.push({ doc, operation });
    return memory.edit(doc, w, operation, mutate);
  },
};
// The committed layer: `<storePath>|<appId>` pairs the repo commits a scope for.
const committedScopes = new Set<string>();
const providers = [
  ConfigStore.provide(store),
  ConfigGitLayer.provide({
    document: (storePath) =>
      Promise.resolve({
        base: {},
        scopes: Object.fromEntries(
          [...committedScopes]
            .map((pair) => pair.split("|"))
            .filter(([sp]) => sp === storePath)
            .map(([, appId]) => [appId!, {}]),
        ),
      }),
    watch: () => Promise.resolve(() => {}),
  }),
];
const run = <T>(fn: () => T | Promise<T>) => withHostServices(providers, fn);

const file = (
  storePath: string,
  f: ConfigFileRef["file"],
  scopeId?: string,
): ConfigFileRef => ({ storePath, ...(scopeId ? { scopeId } : {}), file: f });
const read = (ref: ConfigFileRef) => memory.read(ref);
const exists = async (ref: ConfigFileRef) => (await memory.read(ref)) !== null;
// Write a document file the way the build propagates one.
function seed(
  ref: ConfigFileRef,
  content: JsonValue,
  hash?: string,
): Promise<void> {
  return memory.write(ref, content, hash ?? computeHash(content));
}

const ALPHA_ORIGIN = { enabled: true, title: "committed" };
const changes: ConfigDocumentTuple[] = [];
let offChanges: () => void = () => {};

beforeAll(async () => {
  await seed(file(ALPHA, "origin"), ALPHA_ORIGIN);
  await seed(file(BETA, "origin"), { title: "b" });
  // A committed scope the build propagated before boot: rehydrated by init.
  await seed(file(BETA, "origin", "app:mail"), { title: "mail" });
  collectContributions([
    {
      id: PLUGIN,
      contributions: [
        ConfigV2.Register({ descriptor: alpha, pluginId: asPluginId(PLUGIN) }),
        ConfigV2.Register({ descriptor: beta, pluginId: asPluginId(PLUGIN) }),
      ],
    },
  ]);
  await run(() => initRegistry());
  offChanges = onDocumentChange((doc) => changes.push(doc));
});

afterAll(() => {
  offChanges();
  shutdownRegistry();
  clearCollectedContributions();
});

function lastEdits(n: number): string[] {
  return edits.slice(-n).map((e) => e.operation);
}

describe("reads", () => {
  test("a base read resolves the propagated origin", () =>
    run(() => {
      expect(getConfig(alpha)).toEqual(ALPHA_ORIGIN);
      expect(hasConfigDocument(ALPHA)).toBe(true);
    }));

  test("a scope with no document of its own tracks the base", () =>
    run(() => {
      expect(getConfig(alpha, "app:pages")).toEqual(ALPHA_ORIGIN);
      expect(hasConfigDocument(ALPHA, "app:pages")).toBe(false);
    }));

  test("a committed scope found at init reads its own document", () =>
    run(async () => {
      expect(getConfig(beta, "app:mail")).toEqual({ title: "mail" });
      expect(await getConfigScopeIds(beta)).toEqual(["app:mail"]);
    }));
});

describe("writes", () => {
  test("a base write anchors a full override to the origin, through edit", () =>
    run(async () => {
      changes.length = 0;
      await setConfig(alpha, "title", "mine", { writer });
      expect(await read(file(ALPHA, "override"))).toEqual({
        content: { enabled: true, title: "mine" },
        hash: computeHash(ALPHA_ORIGIN),
      });
      expect(getConfig(alpha).title).toBe("mine");
      expect(lastEdits(1)).toEqual(["set-field:title"]);
      expect(changes).toContainEqual({ path: ALPHA });
    }));

  test("a value the field's schema refuses is not written", () =>
    run(async () => {
      const before = edits.length;
      expect(
        setConfigByPath(ALPHA, "enabled", "not-a-bool", { writer }),
      ).rejects.toBeInstanceOf(Error);
      expect(edits.length).toBe(before);
      expect(getConfig(alpha).enabled).toBe(true);
    }));

  test("a reset leaving nothing the origin does not say removes the override", () =>
    run(async () => {
      await resetConfigByPath(ALPHA, "title", { writer });
      expect(await exists(file(ALPHA, "override"))).toBe(false);
      expect(getConfig(alpha)).toEqual(ALPHA_ORIGIN);
      expect(lastEdits(1)).toEqual(["reset-field:title"]);
    }));

  test("a first scoped write forks the scope from the base", () =>
    run(async () => {
      changes.length = 0;
      await setConfig(alpha, "enabled", false, {
        writer,
        scopeId: "app:pages",
      });
      expect((await read(file(ALPHA, "origin", "app:pages")))?.content).toEqual(
        ALPHA_ORIGIN,
      );
      expect(getConfig(alpha, "app:pages").enabled).toBe(false);
      expect(getConfig(alpha).enabled).toBe(true);
      expect(await getConfigScopeIds(alpha)).toEqual(["app:pages"]);
      expect(changes).toContainEqual({ path: ALPHA, scopeId: "app:pages" });
    }));
});

describe("conflict resolution", () => {
  // A stale override (written against an older origin) plus the merge base
  // propagate captured: the override no longer wins.
  async function conflict(): Promise<void> {
    const ancestor = { enabled: true, title: "old" };
    await seed(file(ALPHA, "ancestor"), ancestor);
    await seed(
      file(ALPHA, "override"),
      { enabled: false, title: "old" },
      computeHash(ancestor),
    );
  }

  test("acknowledge restamps the override and drops the ancestor", () =>
    run(async () => {
      await conflict();
      await reloadConfigDocument(ALPHA, "");
      expect(getConfig(alpha)).toEqual(ALPHA_ORIGIN);
      await acknowledgeConflictByPath(ALPHA, { writer });
      expect((await read(file(ALPHA, "override")))?.hash).toBe(
        computeHash(ALPHA_ORIGIN),
      );
      expect(await exists(file(ALPHA, "ancestor"))).toBe(false);
      expect(getConfig(alpha)).toEqual({ enabled: false, title: "old" });
      expect(lastEdits(1)).toEqual(["acknowledge-conflict"]);
    }));

  test("merge takes each side's change and resolves when nothing collides", () =>
    run(async () => {
      await conflict();
      await reloadConfigDocument(ALPHA, "");
      const result = await mergeConflictByPath(ALPHA, { writer });
      expect(result).toEqual({ resolved: true, conflictKeys: [] });
      expect(await read(file(ALPHA, "override"))).toEqual({
        content: { enabled: false, title: "committed" },
        hash: computeHash(ALPHA_ORIGIN),
      });
      expect(await exists(file(ALPHA, "ancestor"))).toBe(false);
      expect(lastEdits(1)).toEqual(["merge-conflict"]);
    }));

  test("delete-override drops the override and the ancestor", () =>
    run(async () => {
      await conflict();
      await reloadConfigDocument(ALPHA, "");
      await deleteOverrideByPath(ALPHA, { writer });
      expect(await exists(file(ALPHA, "override"))).toBe(false);
      expect(await exists(file(ALPHA, "ancestor"))).toBe(false);
      expect(getConfig(alpha)).toEqual(ALPHA_ORIGIN);
      expect(lastEdits(1)).toEqual(["delete-override"]);
    }));

  test("a write from what the app shows is refused and leaves the parked override", () =>
    run(async () => {
      await conflict();
      await reloadConfigDocument(ALPHA, "");
      const before = await read(file(ALPHA, "override"));
      const editCount = edits.length;
      expect(
        setConfigByPath(ALPHA, "title", "from-screen", { writer }),
      ).rejects.toThrow("has a conflict");
      expect(await read(file(ALPHA, "override"))).toEqual(before);
      expect(edits.length).toBe(editCount);
    }));

  test("a write from the override edits the parked document and keeps the conflict", () =>
    run(async () => {
      await conflict();
      await reloadConfigDocument(ALPHA, "");
      await setConfigByPath(ALPHA, "title", "edited", {
        writer,
        fromOverride: true,
      });
      expect(await read(file(ALPHA, "override"))).toEqual({
        content: { enabled: false, title: "edited" },
        hash: computeHash({ enabled: true, title: "old" }),
      });
      expect(getConfig(alpha)).toEqual(ALPHA_ORIGIN);
    }));
});

describe("scope fork and removal", () => {
  test("fork writes origin and override from the scope's values; removal drops the scope", () =>
    run(async () => {
      await forkDescriptorScope(ALPHA, "app:docs", { writer });
      expect((await read(file(ALPHA, "origin", "app:docs")))?.content).toEqual(
        ALPHA_ORIGIN,
      );
      expect(
        (await read(file(ALPHA, "override", "app:docs")))?.content,
      ).toEqual(ALPHA_ORIGIN);
      expect(await getConfigScopeIds(alpha)).toContain("app:docs");

      await removeDescriptorScope(ALPHA, "app:docs", { writer });
      expect(await exists(file(ALPHA, "origin", "app:docs"))).toBe(false);
      expect(await getConfigScopeIds(alpha)).not.toContain("app:docs");
      expect(hasConfigDocument(ALPHA, "app:docs")).toBe(false);
      expect(lastEdits(2)).toEqual([
        "fork-descriptor-scope",
        "remove-descriptor-scope",
      ]);
    }));

  test("a scoped write queued behind a removal re-forks the scope with a live entry", () =>
    run(async () => {
      await forkDescriptorScope(ALPHA, "app:race", { writer });
      // Both start at once: the write queues on the document lock the removal
      // holds, so it must find the entry gone and build a fresh one.
      await Promise.all([
        removeDescriptorScope(ALPHA, "app:race", { writer }),
        setConfig(alpha, "title", "after", { writer, scopeId: "app:race" }),
      ]);
      expect(hasConfigDocument(ALPHA, "app:race")).toBe(true);
      expect(getConfig(alpha, "app:race").title).toBe("after");
      await removeDescriptorScope(ALPHA, "app:race", { writer });
    }));

  test("removing a git-backed scope falls back to its committed document", () =>
    run(async () => {
      committedScopes.add(`${BETA}|mail`);
      await setConfig(beta, "title", "runtime", {
        writer,
        scopeId: "app:mail",
      });
      expect(getConfig(beta, "app:mail").title).toBe("runtime");

      await removeDescriptorScope(BETA, "app:mail", { writer });
      expect(await exists(file(BETA, "override", "app:mail"))).toBe(false);
      expect(await exists(file(BETA, "origin", "app:mail"))).toBe(true);
      expect(getConfig(beta, "app:mail")).toEqual({ title: "mail" });
      expect(await getConfigScopeIds(beta)).toEqual(["app:mail"]);
    }));
});

describe("reloadConfigDocument", () => {
  test("a base document rewritten behind the registry is re-read", () =>
    run(async () => {
      changes.length = 0;
      await seed(
        file(ALPHA, "override"),
        { enabled: true, title: "restored" },
        computeHash(ALPHA_ORIGIN),
      );
      await reloadConfigDocument(ALPHA, "");
      expect(getConfig(alpha).title).toBe("restored");
      expect(changes).toContainEqual({ path: ALPHA });
    }));

  test("a rewrite that resolves to the same values moves the files' readers only", () =>
    run(async () => {
      const heard: unknown[] = [];
      const watch = watchConfig(alpha, (v) => heard.push(v));
      const notified: unknown[] = [];
      const notify = configValuesServed.notify;
      configValuesServed.notify = (p) => {
        notified.push(p);
        notify(p);
      };
      try {
        const same = { ...getConfig(alpha) };
        heard.length = 0; // watchConfig answers once on subscribe
        changes.length = 0;
        // The same document written again: the stamp moves, the values do not.
        await seed(file(ALPHA, "override"), same, computeHash(ALPHA_ORIGIN));
        await reloadConfigDocument(ALPHA, "");
        expect(changes).toContainEqual({ path: ALPHA }); // the raw file moved …
        expect(heard).toEqual([]); // … no subscriber and no values tuple did
        expect(notified).toEqual([]);

        await seed(
          file(ALPHA, "override"),
          { ...same, title: "moved" },
          computeHash(ALPHA_ORIGIN),
        );
        await reloadConfigDocument(ALPHA, "");
        expect(heard).toHaveLength(1);
        expect(notified).toContainEqual({ path: ALPHA });
      } finally {
        configValuesServed.notify = notify;
        watch.dispose();
      }
    }));

  test("an override hand-written without a hash is applied and stamped with its origin's", () =>
    run(async () => {
      // What a person or an agent writes straight into the user layer: no
      // `// @hash` header. It is applied, not refused, and stamped so the next
      // origin change surfaces it as a conflict like any other override.
      await memory.write(
        file(ALPHA, "override"),
        { enabled: false, title: "by hand" },
        null,
      );
      await reloadConfigDocument(ALPHA, "");
      expect(getConfig(alpha)).toEqual({ enabled: false, title: "by hand" });
      expect(await read(file(ALPHA, "override"))).toEqual({
        content: { enabled: false, title: "by hand" },
        hash: computeHash(ALPHA_ORIGIN),
      });
      expect(lastEdits(1)).toEqual(["stamp-unstamped-override"]);
      await deleteOverrideByPath(ALPHA, { writer });
    }));

  test("an override that does not parse is never applied nor rewritten", () =>
    run(async () => {
      const broken = {
        content: { enabled: false },
        hash: null,
        syntaxErrors: ["JSONC syntax error: CommaExpected at line 3"],
      };
      const ref = file(ALPHA, "override");
      // The memory store holds what it is given: stand the parsed broken file in.
      const realRead = store.read;
      store.read = (r) =>
        r.storePath === ref.storePath && r.file === "override" && !r.scopeId
          ? Promise.resolve(broken)
          : realRead(r);
      try {
        await memory.write(ref, { enabled: false }, null); // moves the stamp
        const before = edits.length;
        await reloadConfigDocument(ALPHA, "");
        expect(getConfig(alpha)).toEqual(ALPHA_ORIGIN);
        expect(edits.length).toBe(before); // not stamped
      } finally {
        store.read = realRead;
      }
      await deleteOverrideByPath(ALPHA, { writer });
    }));

  test("a scoped document whose files were removed leaves the registry", () =>
    run(async () => {
      await forkDescriptorScope(ALPHA, "app:tmp", { writer });
      await memory.remove(file(ALPHA, "origin", "app:tmp"));
      await memory.remove(file(ALPHA, "override", "app:tmp"));
      await reloadConfigDocument(ALPHA, "app:tmp");
      expect(hasConfigDocument(ALPHA, "app:tmp")).toBe(false);
      expect(await getConfigScopeIds(alpha)).not.toContain("app:tmp");
    }));
});
