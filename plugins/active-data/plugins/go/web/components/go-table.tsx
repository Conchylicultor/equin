import type { KeyboardEvent } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { CheckboxIndicator } from "@plugins/primitives/plugins/css/plugins/selection-indicator/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { GoItem } from "../internal/parse-go";
import { GoItemText } from "./go-item-text";
import { PickedBox } from "./picked-box";

/** Space / Enter on a checkbox span toggles it, as a click would. */
function onToggleKey(toggle: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    toggle();
  };
}

/**
 * A pick table: the agent's table with a box leading each row's first cell.
 * The row is the target — a click anywhere on it toggles the pick (unless it
 * ends a selection), an unpicked row is dimmed — and the header's box picks or
 * clears every row. Each cell's words render as inline markdown.
 */
export function GoTable({
  head,
  items,
  picked,
  onToggle,
  onToggleAll,
}: {
  head: string[];
  items: GoItem[];
  /** Null while the picks are not known yet: every box pending, nothing toggles. */
  picked: boolean[] | null;
  onToggle: (i: number) => void;
  /** Pick every row, or clear them all when every row is picked. */
  onToggleAll: () => void;
}) {
  const all = picked?.every(Boolean) ?? false;
  const some = !all && (picked?.some(Boolean) ?? false);
  const known = picked !== null;
  const stateOf = (i: number) => (picked ? picked[i]! : "pending");
  // A row short of cells is padded; one with extra cells keeps only the header's.
  const columns = head.length - 1;
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-foreground/10">
          {head.map((cell, c) => (
            <th key={c} className="px-xs py-2xs text-left align-bottom">
              <Text variant="caption" tone="muted">
                {c === 0 ? (
                  <span
                    role="checkbox"
                    tabIndex={0}
                    aria-checked={all ? true : some ? "mixed" : false}
                    aria-busy={!known || undefined}
                    title={all ? "Clear every row" : "Check every row"}
                    onClick={known ? onToggleAll : undefined}
                    onKeyDown={known ? onToggleKey(onToggleAll) : undefined}
                    className={cn("select-none", known && "cursor-pointer")}
                  >
                    <span className="pr-xs align-middle">
                      <CheckboxIndicator
                        checked={all}
                        className={known ? undefined : "animate-pulse"}
                      />
                    </span>
                    <GoItemText text={cell} />
                  </span>
                ) : (
                  <GoItemText text={cell} />
                )}
              </Text>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => (
          <tr
            key={i}
            onClick={() => {
              if (!known || String(window.getSelection() ?? "")) return;
              onToggle(i);
            }}
            className={cn(
              "border-t border-foreground/5 align-top transition-colors first:border-t-0",
              known && "cursor-pointer hover:bg-primary/10",
              stateOf(i) === false && "text-muted-foreground",
            )}
          >
            <td className="px-xs py-2xs">
              <span
                role="checkbox"
                tabIndex={0}
                aria-checked={stateOf(i) === true}
                aria-busy={!known || undefined}
                onKeyDown={known ? onToggleKey(() => onToggle(i)) : undefined}
              >
                <PickedBox checked={stateOf(i)} form="cell" />
                <GoItemText text={item.text} />
              </span>
            </td>
            {Array.from({ length: columns }, (_, c) => (
              <td key={c} className="px-xs py-2xs">
                <GoItemText text={item.cells[c] ?? ""} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
