/**
 * The proof that every read Settings → Config makes, but the raw files, is
 * answered by a host without the computer (a browser host, the demo): the
 * config_v2 server closure BOOTS portably on PGlite and the memory stores, and
 * the nav's two maps (`config-v2.modified-counts`, `config-v2.conflict-locations`)
 * and the detail pane's per-descriptor reads (`config-v2.values`, `.tiers`,
 * `.conflicts`, `.scopes`) all load. The nav's rows need no read at all — they
 * are built from the web registrations (`web/internal/config-tree.ts`)
 * — and `config-v2.raw-file` is machine-only by declaration (`needsMachine`),
 * which the pane renders as "not available".
 *
 * Boots in a FRESH bun process (this same file, re-run as a child): a boot
 * registers its graph process-wide. Same shape as task-category's
 * portable-boot test.
 *
 * Run: `./equin test plugins/config_v2/plugins/settings`.
 *
 * It lives here, not in config_v2: test-host itself imports config_v2.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { loadResourceByKey } from "@plugins/framework/plugins/server-core/core";
import { bootPluginGraph } from "@plugins/framework/plugins/server-core/core/testing";
import {
  registryClosureOf,
  withPortableHost,
} from "@plugins/framework/plugins/browser-server/plugins/test-host/server/testing";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

setDefaultTimeout(300_000);

// config_v2 itself, and one portable plugin that registers a config of its own
// (in the demo's worker graph), so the per-descriptor reads have a descriptor.
const SUBJECTS = ["config_v2", "apps/plugins/keyboard-party/plugins/party"];

const IN_CHILD = process.env.PORTABLE_BOOT_CHILD === "1";

if (!IN_CHILD) {
  test("Settings → Config's reads are answered portably (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PORTABLE_BOOT_CHILD: "1",
          BOOTS_OWN_PLUGIN_GRAPH: "1",
        },
        timeoutMs: 240_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `portable boot child exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
  });
}

describe.if(IN_CHILD)("Settings → Config's reads on a portable host", () => {
  beforeAll(async () => {
    await bootPluginGraph({
      mode: "exec",
      entries: await withPortableHost(registryClosureOf(SUBJECTS)),
    });
  });

  test("the nav's modified-count and conflict maps load", async () => {
    const modified = await loadResourceByKey("config-v2.modified-counts");
    expect(typeof modified).toBe("object");
    const conflicts = await loadResourceByKey("config-v2.conflict-locations");
    expect(typeof conflicts).toBe("object");
  });

  test("a registered descriptor's values, tiers, conflict and scopes load", async () => {
    const scopes = (await loadResourceByKey("config-v2.scopes")) as Record<
      string,
      string[]
    >;
    const path = Object.keys(scopes)[0];
    expect(path).toBeDefined();
    const values = await loadResourceByKey("config-v2.values", { path: path! });
    expect(typeof values).toBe("object");
    const tiers = await loadResourceByKey("config-v2.tiers", { path: path! });
    expect(typeof tiers).toBe("object");
    const conflict = await loadResourceByKey("config-v2.conflicts", {
      path: path!,
    });
    expect(conflict).toBeNull();
  });
});
