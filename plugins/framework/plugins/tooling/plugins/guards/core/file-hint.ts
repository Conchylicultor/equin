import type { FileInput, Guard, ToolMatcher } from "./types";

export interface FileHintSpec {
  name: string;
  match(filePath: string): boolean;
  message: string;
  /** Tools this hint fires on. Omit for every file tool (incl. Read). */
  tools?: ToolMatcher[];
  /** See `Guard.once`. */
  once?: boolean;
}

const FILE_TOOLS: ToolMatcher[] = ["Read", "Write", "Edit", "NotebookEdit"];

/** A guard that lets a file-tool call through, telling the agent `message`
 *  when the file matches. */
export function fileHint(spec: FileHintSpec): Guard<FileInput> {
  return {
    name: spec.name,
    matcher: spec.tools ?? FILE_TOOLS,
    ...(spec.once ? { once: true } : {}),
    check(input, ctx) {
      let f = input.file_path;
      if (!f) return ctx.allow();
      // Claude Code sends absolute paths; a relative one is the shell's cwd's.
      if (!f.startsWith("/")) f = `${ctx.cwd}/${f}`;
      return spec.match(f) ? ctx.inform(spec.message) : ctx.allow();
    },
  };
}
