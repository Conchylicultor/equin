/**
 * The files the ref watcher follows to hear its tracked refs move, and what
 * each one means when it changes.
 *
 * - `refFiles`: a tracked ref's loose file (`<common>/refs/heads/main`) and
 *   `<common>/packed-refs`. A change re-reads every tracked sha. A ref advance
 *   writes its loose file (lockfile + rename over it, even for a packed ref);
 *   a packed ref's deletion and `pack-refs` rewrite `packed-refs` (the latter
 *   also deletes the loose file).
 * - `structural`: where a tracked ref's directory is missing — a branch name
 *   with `/` (`refs/heads/claude-web/att-…`) lives in a nested dir, which git
 *   removes once its last loose ref is packed or deleted — the follow names
 *   the first missing directory as an entry of the deepest one that exists.
 *   Its appearing means the plan is stale: re-plan, then re-read.
 *
 * Every path is a NAMED entry of a directory that exists, which is what a
 * kqueue follow (`writesWhileOpen`) takes: one descriptor per present file
 * plus one per directory, never one per entry of the shared refs tree.
 */
export interface RefFollowPlan {
  readonly files: readonly string[];
  readonly refFiles: ReadonlySet<string>;
  readonly structural: ReadonlySet<string>;
}

/** Whether `path` is a directory now (false when absent). */
export type IsDir = (path: string) => Promise<boolean>;

const join = (dir: string, name: string): string => `${dir}/${name}`;

export async function planRefFollow(
  commonDir: string,
  refs: readonly string[],
  isDir: IsDir,
): Promise<RefFollowPlan> {
  const refFiles = new Set<string>([join(commonDir, "packed-refs")]);
  const structural = new Set<string>();
  for (const ref of refs) {
    const parts = ref.split("/");
    let dir = commonDir;
    let missing: string | null = null;
    for (const part of parts.slice(0, -1)) {
      const next = join(dir, part);
      if (!(await isDir(next))) {
        missing = next;
        break;
      }
      dir = next;
    }
    if (missing === null) refFiles.add(join(dir, parts.at(-1)!));
    else structural.add(missing);
  }
  return {
    files: [...refFiles, ...structural].sort(),
    refFiles,
    structural,
  };
}

/** Two plans follow the same files. */
export function samePlan(a: RefFollowPlan, b: RefFollowPlan): boolean {
  return (
    a.files.length === b.files.length &&
    a.files.every((f, i) => f === b.files[i])
  );
}
