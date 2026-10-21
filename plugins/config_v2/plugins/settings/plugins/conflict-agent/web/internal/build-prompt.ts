import { USER_CONFIG_DIR_DISPLAY } from "@plugins/infra/plugins/paths/plugins/display/core";
import { APP_SCOPE_DIR, scopeAppId } from "@plugins/config_v2/core";
import type {
  ConfigConflictContext,
  ConfigConflictField,
} from "@plugins/config_v2/plugins/settings/web";

/**
 * The key alone, never its two values.
 *
 * This used to print `mine: <json>, upstream: <json>`, clipped at 200 chars — and
 * a config value is routinely a whole list of objects, so the agent got three
 * truncated blobs instead of the documents they came from. It then had to guess
 * at what the ellipsis ate. The files themselves are named below; an agent that
 * can read them needs the key, not a preview of it.
 */
function fieldLine(field: ConfigConflictField): string {
  const suffix = field.description ? ` — ${field.description}` : "";
  return `- \`${field.key}\`${suffix}`;
}

/** A titled bullet list, or nothing at all — never a heading over an empty list. */
function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  return [`${title}\n${lines.join("\n")}`];
}

function subject(conflict: ConfigConflictContext): string {
  const scope = conflict.scopeId ? `, scope \`${conflict.scopeId}\`` : "";
  return `the **${conflict.name}** config (\`${conflict.storePath}\`${scope})`;
}

/**
 * The store path with the scope's own `@app/<id>/` segment spliced in ahead of the
 * filename — the same encoding the user-layer store writes on disk (`configFileRelPath`), so a scoped
 * conflict names the file it is actually about rather than the base one.
 */
function scopedStorePath(conflict: ConfigConflictContext): string {
  const appId = scopeAppId(conflict.scopeId);
  if (!appId) return conflict.storePath;
  const cut = conflict.storePath.lastIndexOf("/");
  const dir = cut < 0 ? "" : `${conflict.storePath.slice(0, cut)}/`;
  const name = conflict.storePath.slice(cut + 1);
  return `${dir}${APP_SCOPE_DIR}/${appId}/${name}`;
}

/**
 * The two files that disagree, by absolute path, plus the repo file the upstream
 * side was propagated from.
 *
 * Naming the paths is the point: the prompt is not trying to summarize the two
 * documents, it is telling the agent where to read them in full. It also spells
 * the per-worktree fork, because an agent that "fixed" the conflict by editing
 * its own checkout's copy would report success and change nothing for the user.
 */
function pathsBlock(conflict: ConfigConflictContext): string {
  const stored = scopedStorePath(conflict);
  const base = `${USER_CONFIG_DIR_DISPLAY}/<worktree>`;
  return [
    "The two files that disagree — read both:",
    `- my values: \`${base}/${stored}\``,
    `- the new upstream default: \`${base}/${stored.replace(/\.jsonc$/, ".origin.jsonc")}\``,
    "",
    `That upstream file is propagated by \`./singularity build\` from the repo's \`config/${conflict.storePath}\`, which is the version-controlled default.`,
    "My config layer is forked per worktree, so the copy in your own checkout is NOT the one I am looking at — editing it changes nothing for me.",
  ].join("\n");
}

/**
 * The standing rule, on every variant: resolve the conflict by hand.
 *
 * The prompt used to end with "fix any code-level cause in the repo" and "fix
 * that at the source rather than papering over it in my config" — and, on the
 * invalid variant, offered "say exactly what that fix would be". Every one of
 * those put a repo change on the table, and an agent handed a two-file merge
 * went and rewrote the config engine's merge instead. Resolving a conflict is
 * reading two documents and deciding per field; nothing here asks about code, so
 * nothing here mentions it.
 */
const RESOLVE_BY_HAND =
  "**Resolve this by hand, and change no code.** Read the two files, decide field by field, and report. " +
  "Do not edit plugin source, tests, schemas or descriptors, and do not `./singularity build` or push. " +
  "The only file you may edit is the repo config named above, and only when I ask you to promote my values into it.";

/**
 * Point at the user's own typed guidance. The launch popover appends it verbatim
 * under a `## Context` heading, so the prompt names that heading rather than
 * describing it — and the sentence is a no-op when nothing was typed, which is
 * what lets this be a fixed line in a builder that never sees the text.
 *
 * It goes LAST on purpose. What the user typed is the specific instruction for
 * this one conflict; everything above it is boilerplate attached to every
 * conflict, and the boilerplate must not outrank it.
 */
const FOLLOW_MY_CONTEXT =
  "Anything I added under `## Context` below is the guidance for this conflict — follow it, and let it override anything above.";

/**
 * Turn a config conflict into the first turn of an agent task: what broke, which
 * fields disagree, where to read them, and what the agent is being asked to decide.
 *
 * Pure and total over the context — so the prompt can be built (and tested)
 * without a popover, a draft, or a live config resource.
 */
export function buildConflictPrompt(conflict: ConfigConflictContext): string {
  const blocks: string[] =
    conflict.kind === "invalid"
      ? invalidBlocks(conflict)
      : hashBlocks(conflict);
  return blocks.join("\n\n");
}

function hashBlocks(conflict: ConfigConflictContext): string[] {
  const conflicting = conflict.fields.filter((f) => f.status === "conflict");
  const upstreamOnly = conflict.fields.filter(
    (f) => f.status === "upstream-changed",
  );

  return [
    `Resolve the config conflict on ${subject(conflict)}.`,
    "Upstream defaults for this config changed while I had my own overrides, so the app is currently running the upstream values and my overrides are parked.",
    ...section(
      "Fields we both changed (these need a decision):",
      conflicting.map(fieldLine),
    ),
    ...section(
      "Fields upstream changed that I had not touched:",
      upstreamOnly.map(fieldLine),
    ),
    pathsBlock(conflict),
    "For each field above, tell me whether to keep my value or take the new default, and why. Reading what changed upstream and why (`git log` on the repo config) is useful context for that answer.",
    RESOLVE_BY_HAND,
    FOLLOW_MY_CONTEXT,
  ];
}

function invalidBlocks(conflict: ConfigConflictContext): string[] {
  const issues = conflict.issues ?? [];

  return [
    `Resolve the invalid stored config on ${subject(conflict)}.`,
    "The stored document no longer validates against the current schema, so the app has fallen back to the built-in defaults and my stored values are not being used.",
    ...section(
      "Schema issues:",
      issues.map((issue) => `- \`${issue.path}\` — ${issue.message}`),
    ),
    pathsBlock(conflict),
    "Reconcile my stored document against the current one by hand, and tell me what each value should become for it to validate again. Reading what changed upstream and why (`git log` on the repo config) is useful context for that answer.",
    RESOLVE_BY_HAND,
    FOLLOW_MY_CONTEXT,
  ];
}

/**
 * The one-line summary the launch popover shows above the extra-context box:
 * what the agent is about to be asked, in the user's terms. Deliberately says
 * how many fields carry a DECISION rather than how many differ — the count the
 * banner itself reports, so the popover cannot contradict the banner that
 * opened it.
 */
export function describeConflict(conflict: ConfigConflictContext): string {
  if (conflict.kind === "invalid") {
    const n = conflict.issues?.length ?? 0;
    return n > 0
      ? `${conflict.storePath} no longer validates against its schema (${n} issue${n === 1 ? "" : "s"}).`
      : `${conflict.storePath} no longer validates against its schema.`;
  }
  const decisions = conflict.fields.filter((f) => f.status === "conflict");
  if (decisions.length > 0) {
    return `Upstream defaults for ${conflict.storePath} moved — ${decisions.length} field${decisions.length === 1 ? "" : "s"} need${decisions.length === 1 ? "s" : ""} a decision.`;
  }
  return `Upstream defaults for ${conflict.storePath} moved under my overrides.`;
}
