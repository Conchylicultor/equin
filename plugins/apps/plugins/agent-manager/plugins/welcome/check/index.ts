import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join } from "path";

interface CheckResult {
  ok: boolean;
  message?: string;
  hint?: string;
}

interface Check {
  id: string;
  description: string;
  run(): Promise<CheckResult>;
}

const pluginDir = join(import.meta.dir, "..");

/**
 * Sanity-check that welcome's package.json is marked private. Plugins are
 * workspace-internal — accidentally publishing one would leak the registry's
 * structure under a vendored name. Cheap to enforce, hard to catch otherwise.
 */
const packageIsPrivate: Check = {
  id: "welcome:package-private",
  description: "welcome plugin's package.json is marked private",
  async run(): Promise<CheckResult> {
    const pkgPath = join(pluginDir, "package.json");
    if (!existsSync(pkgPath)) {
      return { ok: false, message: "welcome plugin is missing package.json" };
    }
    let data: { private?: unknown };
    try {
      data = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch (err) {
      return { ok: false, message: `package.json is not valid JSON: ${err}` };
    }
    if (data.private !== true) {
      return {
        ok: false,
        message: "plugins/apps/plugins/agent-manager/plugins/welcome/package.json must set \"private\": true",
        hint: "Plugins are workspace-internal; publishing one is never intended.",
      };
    }
    return { ok: true };
  },
};

export default packageIsPrivate;
