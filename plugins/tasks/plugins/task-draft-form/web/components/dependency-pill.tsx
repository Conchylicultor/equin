import { Icon } from "@plugins/ui/plugins/icons/web";
import { PickerPill } from "@plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill/web";
import { TooltipDoc } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import type { TaskChainRelateMode } from "@plugins/tasks/core";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";

const adjustIcon = symbol("adjust");
const subdirectoryArrowRightIcon = symbol("subdirectory-arrow-right");
const turnRightIcon = symbol("turn-right");

/** One row of the menu: where this task goes relative to the current one. */
interface DependencyChoice {
  /** `undefined` is the independent task — no edge at all. */
  value: TaskChainRelateMode | undefined;
  /** How the row reads in the menu. */
  label: string;
  /** How the pill's trigger reads once this row is chosen. */
  short: string;
  icon: IconRef;
}

const CHOICES: DependencyChoice[] = [
  {
    value: undefined,
    label: "As separate task",
    short: "Separate",
    icon: adjustIcon,
  },
  {
    value: "followup",
    label: "As follow up",
    short: "Follow-up",
    icon: subdirectoryArrowRightIcon,
  },
  {
    value: "prerequisite",
    label: "As prerequisite",
    short: "Prerequisite",
    icon: turnRightIcon,
  },
];

/** A task that already follows the current one — a candidate to insert before. */
export interface ChildEntry {
  id: string;
  title: string;
}

/**
 * Per-mode options shown under the menu's choices, each only while its mode is
 * picked. Absent (or an empty child list) means the mode has none.
 */
export interface DependencyExtras {
  /** Follow-up: which of the current task's dependents the new task goes before. */
  insertBefore?: {
    children: ChildEntry[];
    selected: Set<string>;
    onChange: (next: Set<string>) => void;
  };
  /** Prerequisite: skip inheriting the current task's own dependencies. */
  standalone?: { checked: boolean; onChange: (next: boolean) => void };
}

export interface DependencyPillProps {
  value: TaskChainRelateMode | undefined;
  onChange: (next: TaskChainRelateMode | undefined) => void;
  /** Offer the "As separate task" row — only where dropping the edge is allowed. */
  showIndependent?: boolean;
  disabled?: boolean;
  extras?: DependencyExtras;
}

/**
 * Where the drafted task goes relative to the one you are looking at: nowhere
 * (its own task), after it, or before it.
 *
 * Unset it reads "Dependency" and stays plain — an independent task is the
 * absence of an edge, not a choice you made. Pick either edge and the trigger
 * reads it back — its icon and its name — and tints, so a card that will be wired to another task says so
 * without opening anything.
 *
 * The picked mode's options sit under the choices in the same menu, as check
 * rows that toggle without closing it: follow-up lists the current task's
 * dependents to insert the new task before, prerequisite offers "Standalone".
 * A mode with nothing to offer adds no group.
 */
export function DependencyPill({
  value,
  onChange,
  showIndependent,
  disabled,
  extras,
}: DependencyPillProps) {
  const choices = showIndependent
    ? CHOICES
    : CHOICES.filter((choice) => choice.value !== undefined);
  const chosen = value && CHOICES.find((choice) => choice.value === value);
  const insertBefore =
    value === "followup" && extras?.insertBefore?.children.length
      ? extras.insertBefore
      : undefined;
  const standalone = value === "prerequisite" ? extras?.standalone : undefined;

  return (
    <PickerPill
      icon={chosen ? chosen.icon : adjustIcon}
      placeholder="Dependency"
      highlight={value !== undefined}
      disabled={disabled}
      ariaLabel="Relation to current task"
      tooltip={
        <TooltipDoc title="Dependency">
          How this task relates to the one you are looking at. A follow-up waits
          for it to finish first; a prerequisite must finish before it. A
          separate task is not linked to it.
        </TooltipDoc>
      }
    >
      {chosen && <PickerPill.Value>{chosen.short}</PickerPill.Value>}
      <PickerPill.Group title="Where this task goes">
        {choices.map((choice) => (
          <PickerPill.Item
            key={choice.value ?? "independent"}
            icon={<Icon icon={choice.icon} aria-hidden className="size-3.5" />}
            selected={choice.value === value}
            onSelect={() => onChange(choice.value)}
            disabled={disabled}
          >
            {choice.label}
          </PickerPill.Item>
        ))}
      </PickerPill.Group>
      {insertBefore && (
        <PickerPill.Group title="Insert before">
          {insertBefore.children.map((child) => (
            <PickerPill.Check
              key={child.id}
              checked={insertBefore.selected.has(child.id)}
              onCheckedChange={(checked) => {
                const next = new Set(insertBefore.selected);
                if (checked) next.add(child.id);
                else next.delete(child.id);
                insertBefore.onChange(next);
              }}
              disabled={disabled}
            >
              <span title={child.title}>{truncate(child.title, 50)}</span>
            </PickerPill.Check>
          ))}
        </PickerPill.Group>
      )}
      {standalone && (
        <PickerPill.Group title="Options">
          <PickerPill.Check
            checked={standalone.checked}
            onCheckedChange={standalone.onChange}
            disabled={disabled}
          >
            Standalone — don't inherit existing dependencies
          </PickerPill.Check>
        </PickerPill.Group>
      )}
    </PickerPill>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
