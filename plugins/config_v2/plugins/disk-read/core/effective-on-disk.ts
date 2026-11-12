import {
  readFile,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  effective,
  loadedProxy,
  readonlyProxy,
  readTypedConfig,
  parseOverrideFile,
} from "@plugins/config_v2/core";
import type {
  ConfigDescriptor,
  ConfigFileContent,
  ConfigProxy,
  ConfigValues,
} from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";

interface DiskReadOpts {
  root: AppPath;
  userConfigDir: AppPath;
  hierarchyPath: string;
}

/** The four files a config's resolved value is read from, in resolution order. */
function documentPaths(
  descriptor: Pick<ConfigDescriptor, "name">,
  opts: DiskReadOpts,
): [AppPath, AppPath, AppPath, AppPath] {
  const gitDir = joinAppPath(opts.root, "config", opts.hierarchyPath);
  const userDir = joinAppPath(opts.userConfigDir, opts.hierarchyPath);
  return [
    joinAppPath(gitDir, `${descriptor.name}.origin.jsonc`),
    joinAppPath(gitDir, `${descriptor.name}.jsonc`),
    joinAppPath(userDir, `${descriptor.name}.origin.jsonc`),
    joinAppPath(userDir, `${descriptor.name}.jsonc`),
  ];
}

/**
 * One config file's text as a document: its `// @hash` header (optional — an
 * unstamped hand-written override) and its JSONC body, syntax errors kept so the
 * cascade resolves past an override that does not parse, as the runtime does.
 */
const parseDocument = parseOverrideFile;

function absentAsNull(err: unknown): null {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return null;
  throw err;
}

async function readDocument(path: AppPath): Promise<ConfigFileContent | null> {
  try {
    return parseDocument(await readFile(path, "utf-8"));
  } catch (err) {
    return absentAsNull(err);
  }
}

function readDocumentSync(path: AppPath): ConfigFileContent | null {
  try {
    return parseDocument(readFileSync(path, "utf-8"));
  } catch (err) {
    return absentAsNull(err);
  }
}

/** The resolution itself, over the four documents already read. */
function resolveEffective<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  [
    gitOrigin,
    gitOverwrites,
    userOrigin,
    userOverwrites,
  ]: (ConfigFileContent | null)[],
): ConfigValues<F> {
  // The origin is the git-effective document — what `propagateConfigToUser`
  // writes into the user layer — never the user origin already on disk. That
  // file is only as fresh as the LAST propagation, and the build reads this
  // before its own propagation stage: a field added to the descriptor since
  // then is absent from it and silently heals to its default. A user override
  // still wins only while its `// @hash` matches the git-effective document,
  // exactly as it will at runtime once this build has propagated. The user
  // origin stands only when the git layer has no document at all.
  const gitEff = effective(
    loadedProxy(gitOrigin ?? null),
    loadedProxy(gitOverwrites ?? null),
  );
  const origin: ConfigProxy =
    gitEff !== undefined
      ? readonlyProxy(gitEff)
      : loadedProxy(userOrigin ?? null);
  return readTypedConfig(
    descriptor,
    origin,
    loadedProxy(userOverwrites ?? null),
  );
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
export async function readEffectiveConfigFromDisk<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  opts: DiskReadOpts,
): Promise<ConfigValues<F>> {
  const docs = await Promise.all(
    documentPaths(descriptor, opts).map(readDocument),
  );
  return resolveEffective(descriptor, docs);
}

/**
 * {@link readEffectiveConfigFromDisk}, holding the thread: for a CLI step that
 * may block (the build's target resolver).
 */
export function readEffectiveConfigFromDiskSync<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  opts: DiskReadOpts,
): ConfigValues<F> {
  return resolveEffective(
    descriptor,
    documentPaths(descriptor, opts).map(readDocumentSync),
  );
}
