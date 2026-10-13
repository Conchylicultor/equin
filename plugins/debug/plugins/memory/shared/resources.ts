import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

const MEMORY_FILE_TYPES = [
  "index",
  "feedback",
  "project",
  "user",
  "reference",
  "other",
] as const;

const MemoryFileSchema = z.object({
  name: z.string(),
  type: z.enum(MEMORY_FILE_TYPES),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

/**
 * The `.md` files of the project's Claude Code memory directory
 * (`~/.claude/projects/<main checkout key>/memory/`), `MEMORY.md` first then
 * alphabetical, with the directory's path.
 */
export const memoryFiles = liveValue("memory.files", {
  schema: z.object({
    files: z.array(MemoryFileSchema),
    dir: z.string(),
  }),
});

/**
 * One memory file's markdown. A name that is not a plain `.md` file name is
 * refused `invalid-name`; a file that is not (or no longer) there is refused
 * `missing`.
 */
export const memoryFile = liveValue("memory.file", {
  schema: z.object({ content: z.string() }),
  params: ["name"],
  refusals: ["missing", "invalid-name"],
});
