import { mkdirSync, writeFileSync, renameSync, unlinkSync } from "fs";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  appPathParent,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { randomUUID } from "crypto";
import { basename, dirname } from "path";
import { parseOverrideFile } from "@plugins/config_v2/core";
import type { ConfigProxy, JsonValue } from "@plugins/config_v2/core";

/**
 * One JSONC config file as a ConfigProxy, read and written in place — the user
 * layer the build's propagation writes through (`propagateGitLayerDocument`).
 * Synchronous, so build tooling only: a backend's config store is
 * `config_v2#machine`'s async file store.
 */
export function fileConfigProxy(filePath: AppPath): ConfigProxy {
  return {
    read() {
      if (!existsSync(filePath)) return null;
      // The lenient override reading (header optional, syntax errors kept),
      // so propagation never stamps — rewrites — a file that does not parse.
      return parseOverrideFile(readFileSync(filePath, "utf-8"));
    },
    write(content: JsonValue, hash: string | null) {
      let str = "";
      if (hash !== null) str += `// @hash ${hash}\n`;
      str += JSON.stringify(content, null, 2) + "\n";
      const tmp = joinAppPath(
        appPathParent(filePath),
        `${basename(filePath)}.tmp-${randomUUID()}`,
      );
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(tmp, str, "utf-8");
        renameSync(tmp, filePath);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch (unlinkErr: unknown) {
          if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT")
            throw unlinkErr;
        }
        throw err;
      }
    },
    exists() {
      return existsSync(filePath);
    },
  };
}
