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
import { parse as parseJsonc } from "jsonc-parser";
import {
  effective,
  readonlyProxy,
  readTypedConfig,
  CONFIG_HASH_RE,
} from "@plugins/config_v2/core";
import type {
  ConfigDescriptor,
  ConfigProxy,
  ConfigValues,
  JsonValue,
} from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";

export function fileConfigProxy(filePath: AppPath): ConfigProxy {
  return {
    read() {
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, "utf-8");
      const match = CONFIG_HASH_RE.exec(raw);
      const hash = match ? match[1]! : null;
      const body = match ? raw.slice(match[0].length) : raw;
      const content = parseJsonc(body) as JsonValue;
      return { content, hash };
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

/**
 * The RESOLVED value a worktree's backend would read for one config, computed
 * off disk with no server runtime — for build-time consumers (the CLI's
 * build's target resolver) that must see git-layer defaults AND user-layer edits,
 * not `descriptor.fields.<x>.defaultValue` (the code-defaults-only bug-shape).
 *
 * Precedence is NEVER reimplemented here: the runtime reads the USER layer via
 * `readTypedConfig(descriptor, userOrigin, userOverwrites)` (config_v2's
 * registry), and the git layer only reaches that user layer through
 * `propagateConfigToUser`. This mirrors exactly that chain AS OF THIS
 * CHECKOUT'S GIT LAYER: the git-effective document IS the origin (what
 * propagation will write), layered via the same pure primitives (`effective` +
 * `readTypedConfig`), so an already-propagated user origin left stale by a
 * newer commit is never read in its place.
 *
 * `hierarchyPath` is the config's owning-plugin path (`asPath(pluginId)`) —
 * the descriptor does not carry its plugin identity, so the caller supplies it.
 *
 * `userConfigDir` is the namespace's user-config directory, already resolved —
 * see {@link propagateConfigToUser} for why it is not a data root plus a name.
 */
export function readEffectiveConfigFromDisk<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  opts: {
    root: AppPath;
    userConfigDir: AppPath;
    hierarchyPath: string;
  },
): ConfigValues<F> {
  const root = opts.root;
  const gitDir = joinAppPath(root, "config", opts.hierarchyPath);
  const gitOrigin = fileConfigProxy(
    joinAppPath(gitDir, `${descriptor.name}.origin.jsonc`),
  );
  const gitOverwrites = fileConfigProxy(
    joinAppPath(gitDir, `${descriptor.name}.jsonc`),
  );

  const userDir = joinAppPath(opts.userConfigDir, opts.hierarchyPath);
  const userOrigin = fileConfigProxy(
    joinAppPath(userDir, `${descriptor.name}.origin.jsonc`),
  );
  const userOverwrites = fileConfigProxy(
    joinAppPath(userDir, `${descriptor.name}.jsonc`),
  );

  // The origin is the git-effective document — what `propagateConfigToUser`
  // writes into the user layer — never the user origin already on disk. That
  // file is only as fresh as the LAST propagation, and the build reads this
  // before its own propagation stage: a field added to the descriptor since
  // then is absent from it and silently heals to its default. A user override
  // still wins only while its `// @hash` matches the git-effective document,
  // exactly as it will at runtime once this build has propagated. The user
  // origin stands only when the git layer has no document at all.
  const gitEff = effective(gitOrigin, gitOverwrites);
  const origin: ConfigProxy =
    gitEff !== undefined ? readonlyProxy(gitEff) : userOrigin;
  return readTypedConfig(descriptor, origin, userOverwrites);
}
