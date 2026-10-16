import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  WorkspaceCapabilitySchema,
  WorkspaceKindSchema,
  WorkspaceSpecSchema,
} from "./workspace";

/**
 * One workspace a task can be launched in: the worktree, or one registered
 * scratch profile (a scratch launch needs a profile, so the profile IS the
 * choice). Built server-side from the kind and profile registries, so a reader
 * never names a profile.
 */
export const WorkspaceChoiceSchema = z.object({
  /** What a task stores to launch here (scratch input: `{}`). */
  spec: WorkspaceSpecSchema,
  kind: WorkspaceKindSchema,
  label: z.string(),
  description: z.string(),
  capabilities: z.array(WorkspaceCapabilitySchema),
  profile: z
    .object({
      id: z.string(),
      /** The plugin that registered the profile (null outside the register phase). */
      owner: z.string().nullable(),
      mcpToolCount: z.number(),
    })
    .optional(),
  /**
   * Why a bare task cannot launch here — a profile whose input has no
   * defaults is started from its own app, which supplies the input.
   */
  unavailable: z.string().optional(),
});
export type WorkspaceChoice = z.infer<typeof WorkspaceChoiceSchema>;

/**
 * Every workspace a task can name, worktree first. Fixed for the process: the
 * kinds are a closed set and profiles register at boot.
 */
export const workspaceCatalog = liveValue("workspace.catalog", {
  schema: z.array(WorkspaceChoiceSchema),
  preload: "boot-and-keep",
});
