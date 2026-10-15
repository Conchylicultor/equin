import type { ReactElement } from "react";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/** Main's namespace: the other worktree whose logs are worth one click. */
const MAIN = "singularity";

/**
 * Whose logs: this page's worktree, main's, or the one a link named (a report
 * filed from another worktree opens its logs there).
 */
export function WorktreePicker({
  worktree,
  served,
  onPick,
}: {
  worktree: string;
  served: string | null;
  onPick: (worktree: string) => void;
}): ReactElement {
  const options = [
    ...new Set([served, MAIN, worktree].filter((w) => w !== null)),
  ];
  const label = (w: string): string =>
    w === served ? `${w} (this one)` : w === MAIN ? `${w} (main)` : w;
  return (
    <Inset pad="sm" className="border-b">
      <Stack direction="row" gap="sm" align="center">
        <Text variant="label" tone="muted">
          Worktree
        </Text>
        <Select
          items={options.map((w) => ({ value: w, label: label(w) }))}
          value={worktree}
          onValueChange={(v: string | null) => {
            if (v !== null) onPick(v);
          }}
        >
          <SelectTrigger aria-label="Worktree">
            <SelectValue>
              {(v: string | null) => (v === null ? "" : label(v))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((w) => (
              <SelectItem key={w} value={w}>
                {label(w)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Stack>
    </Inset>
  );
}
