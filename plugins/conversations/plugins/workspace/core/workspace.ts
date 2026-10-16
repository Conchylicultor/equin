import { z } from "zod";

// Where a conversation runs. A closed set, so plain data both runtimes read
// (the open set is a scratch workspace's *profile*, contributed by feature
// plugins). Design: research/2026-10-13-global-agent-workspaces-and-sonata-transcription.md.

export const WorkspaceKindSchema = z.enum(["worktree", "scratch"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

/** What a workspace offers the agent and the surfaces around it. */
export const WorkspaceCapabilitySchema = z.enum([
  "git",
  "db-fork",
  "build",
  "project-context",
]);
export type WorkspaceCapability = z.infer<typeof WorkspaceCapabilitySchema>;

export const WORKSPACE_KINDS: Record<
  WorkspaceKind,
  {
    label: string;
    description: string;
    capabilities: readonly WorkspaceCapability[];
  }
> = {
  worktree: {
    label: "Worktree",
    description:
      "A git checkout of this repo, with its own forked database and deploy.",
    capabilities: ["git", "db-fork", "build", "project-context"],
  },
  scratch: {
    label: "Scratch",
    description: "A plain directory holding only what its profile provides.",
    capabilities: [],
  },
};

/** Every capability, in display order, with its human label. */
export const WORKSPACE_CAPABILITIES: readonly {
  id: WorkspaceCapability;
  label: string;
}[] = [
  { id: "git", label: "git" },
  { id: "db-fork", label: "DB fork" },
  { id: "build", label: "build" },
  { id: "project-context", label: "repo context" },
];

/**
 * The workspace an attempt runs in, as stored on the attempt row. Every
 * conversation of the attempt shares it.
 */
export const WorkspaceSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worktree") }),
  z.object({
    kind: z.literal("scratch"),
    // A scratch profile id (`defineScratchProfile`, workspace/server).
    profile: z.string().min(1),
    // The launch's input, validated by the profile's `inputSchema` when the
    // attempt is created and stored as parsed.
    input: z.unknown(),
  }),
]);
export type WorkspaceSpec = z.infer<typeof WorkspaceSpecSchema>;

/** Whether a workspace of `kind` offers `capability`. */
export function hasCapability(
  kind: WorkspaceKind,
  capability: WorkspaceCapability,
): boolean {
  return WORKSPACE_KINDS[kind].capabilities.includes(capability);
}

/**
 * Throws unless a workspace of `kind` offers `capability` — the boundary assert
 * of a surface that needs it (a git read on a scratch dir is a bug, never an
 * empty answer). `what` names the caller for the message.
 */
export function assertCapability(
  kind: WorkspaceKind,
  capability: WorkspaceCapability,
  what: string,
): void {
  if (!hasCapability(kind, capability)) {
    throw new Error(
      `${what} needs a workspace with "${capability}", but this attempt runs in a ${kind} workspace`,
    );
  }
}

/** Whether a workspace of `kind` offers every one of `required`. */
export function satisfiesCapabilities(
  kind: WorkspaceKind,
  required: readonly WorkspaceCapability[],
): boolean {
  return required.every((c) => hasCapability(kind, c));
}

/** The workspace an attempt runs in unless its launch names another. */
export const DEFAULT_WORKSPACE: WorkspaceSpec = { kind: "worktree" };

/** What a surface knows of an attempt's workspace kind. */
export type WorkspaceKindState =
  { known: true; kind: WorkspaceKind } | { known: false };

/**
 * Whether a contribution that `requires` these capabilities shows for the
 * workspace. A contribution requiring nothing always shows; one requiring
 * anything waits until the kind is known, so a git surface never flashes on a
 * scratch conversation.
 */
export function workspaceAllows(
  state: WorkspaceKindState,
  requires: readonly WorkspaceCapability[],
): boolean {
  if (requires.length === 0) return true;
  return state.known && satisfiesCapabilities(state.kind, requires);
}
