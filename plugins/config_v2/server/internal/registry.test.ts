/**
 * The portable registry over its two host services, with no file in sight: the
 * user layer is `createMemoryConfigStore()` (wrapped to record every `edit`),
 * the committed layer a fixture answering `hasScope` from a set.
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
  type ConfigDocumentTuple,
} from "./registry";
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
    hasScope: (storePath, appId) =>
      committedScopes.has(`${storePath}|${appId}`),
  }),
];
const run = <T>(fn: () => T | Promise<T>) => withHostServices(providers, fn);

const file = (
  storePath: string,
  f: ConfigFileRef["file"],
  scopeId?: string,
): ConfigFileRef => ({ storePath, ...(scopeId ? { scopeId } : {}), file: f });
const read = (ref: ConfigFileRef) => memory.proxy(ref).read();
// Write a document file the way the build propagates one.
function seed(ref: ConfigFileRef, content: JsonValue, hash?: string): void {
  memory.proxy(ref).write(content, hash ?? computeHash(content));
}

const ALPHA_ORIGIN = { enabled: true, title: "committed" };
const changes: ConfigDocumentTuple[] = [];
let offChanges: () => void = () => {};

beforeAll(async () => {
  seed(file(ALPHA, "origin"), ALPHA_ORIGIN);
  seed(file(BETA, "origin"), { title: "b" });
  // A committed scope the build propagated before boot: rehydrated by init.
  seed(file(BETA, "origin", "app:mail"), { title: "mail" });
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
    run(() => {
      expect(getConfig(beta, "app:mail")).toEqual({ title: "mail" });
      expect(getConfigScopeIds(beta)).toEqual(["app:mail"]);
    }));
});

describe("writes", () => {
  test("a base write anchors a full override to the origin, through edit", () =>
    run(async () => {
      changes.length = 0;
      await setConfig(alpha, "title", "mine", { writer });
      expect(read(file(ALPHA, "override"))).toEqual({
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
      // `expect(p).rejects` is typed `void` under bun:test, so the rejection
      // is caught by hand.
      const refused = await setConfigByPath(ALPHA, "enabled", "not-a-bool", {
        writer,
      }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refused).toBeInstanceOf(Error);
      expect(edits.length).toBe(before);
      expect(getConfig(alpha).enabled).toBe(true);
    }));

  test("a reset leaving nothing the origin does not say removes the override", () =>
    run(async () => {
      await resetConfigByPath(ALPHA, "title", { writer });
      expect(memory.proxy(file(ALPHA, "override")).exists()).toBe(false);
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
      expect(read(file(ALPHA, "origin", "app:pages"))?.content).toEqual(
        ALPHA_ORIGIN,
      );
      expect(getConfig(alpha, "app:pages").enabled).toBe(false);
      expect(getConfig(alpha).enabled).toBe(true);
      expect(getConfigScopeIds(alpha)).toEqual(["app:pages"]);
      expect(changes).toContainEqual({ path: ALPHA, scopeId: "app:pages" });
    }));
});

describe("conflict resolution", () => {
  // A stale override (written against an older origin) plus the merge base
  // propagate captured: the override no longer wins.
  function conflict(): void {
    const ancestor = { enabled: true, title: "old" };
    seed(file(ALPHA, "ancestor"), ancestor);
    seed(
      file(ALPHA, "override"),
      { enabled: false, title: "old" },
      computeHash(ancestor),
    );
  }

  test("acknowledge restamps the override and drops the ancestor", () =>
    run(async () => {
      conflict();
      await reloadConfigDocument(ALPHA, "");
      expect(getConfig(alpha)).toEqual(ALPHA_ORIGIN);
      acknowledgeConflictByPath(ALPHA, { writer });
      expect(read(file(ALPHA, "override"))?.hash).toBe(
        computeHash(ALPHA_ORIGIN),
      );
      expect(memory.proxy(file(ALPHA, "ancestor")).exists()).toBe(false);
      expect(getConfig(alpha)).toEqual({ enabled: false, title: "old" });
      expect(lastEdits(1)).toEqual(["acknowledge-conflict"]);
    }));

  test("merge takes each side's change and resolves when nothing collides", () =>
    run(async () => {
      conflict();
      await reloadConfigDocument(ALPHA, "");
      const result = mergeConflictByPath(ALPHA, { writer });
      expect(result).toEqual({ resolved: true, conflictKeys: [] });
      expect(read(file(ALPHA, "override"))).toEqual({
        content: { enabled: false, title: "committed" },
        hash: computeHash(ALPHA_ORIGIN),
      });
      expect(memory.proxy(file(ALPHA, "ancestor")).exists()).toBe(false);
      expect(lastEdits(1)).toEqual(["merge-conflict"]);
    }));

  test("delete-override drops the override and the ancestor", () =>
    run(async () => {
      conflict();
      await reloadConfigDocument(ALPHA, "");
      deleteOverrideByPath(ALPHA, { writer });
      expect(memory.proxy(file(ALPHA, "override")).exists()).toBe(false);
      expect(memory.proxy(file(ALPHA, "ancestor")).exists()).toBe(false);
      expect(getConfig(alpha)).toEqual(ALPHA_ORIGIN);
      expect(lastEdits(1)).toEqual(["delete-override"]);
    }));
});

describe("scope fork and removal", () => {
  test("fork writes origin and override from the scope's values; removal drops the scope", () =>
    run(async () => {
      await forkDescriptorScope(ALPHA, "app:docs", { writer });
      expect(read(file(ALPHA, "origin", "app:docs"))?.content).toEqual(
        ALPHA_ORIGIN,
      );
      expect(read(file(ALPHA, "override", "app:docs"))?.content).toEqual(
        ALPHA_ORIGIN,
      );
      expect(getConfigScopeIds(alpha)).toContain("app:docs");

      await removeDescriptorScope(ALPHA, "app:docs", { writer });
      expect(memory.proxy(file(ALPHA, "origin", "app:docs")).exists()).toBe(
        false,
      );
      expect(getConfigScopeIds(alpha)).not.toContain("app:docs");
      expect(hasConfigDocument(ALPHA, "app:docs")).toBe(false);
      expect(lastEdits(2)).toEqual([
        "fork-descriptor-scope",
        "remove-descriptor-scope",
      ]);
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
      expect(memory.proxy(file(BETA, "override", "app:mail")).exists()).toBe(
        false,
      );
      expect(memory.proxy(file(BETA, "origin", "app:mail")).exists()).toBe(
        true,
      );
      expect(getConfig(beta, "app:mail")).toEqual({ title: "mail" });
      expect(getConfigScopeIds(beta)).toEqual(["app:mail"]);
    }));
});

describe("reloadConfigDocument", () => {
  test("a base document rewritten behind the registry is re-read", () =>
    run(async () => {
      changes.length = 0;
      seed(
        file(ALPHA, "override"),
        { enabled: true, title: "restored" },
        computeHash(ALPHA_ORIGIN),
      );
      await reloadConfigDocument(ALPHA, "");
      expect(getConfig(alpha).title).toBe("restored");
      expect(changes).toContainEqual({ path: ALPHA });
    }));

  test("a scoped document whose files were removed leaves the registry", () =>
    run(async () => {
      await forkDescriptorScope(ALPHA, "app:tmp", { writer });
      memory.remove(file(ALPHA, "origin", "app:tmp"));
      memory.remove(file(ALPHA, "override", "app:tmp"));
      await reloadConfigDocument(ALPHA, "app:tmp");
      expect(hasConfigDocument(ALPHA, "app:tmp")).toBe(false);
      expect(getConfigScopeIds(alpha)).not.toContain("app:tmp");
    }));
});
