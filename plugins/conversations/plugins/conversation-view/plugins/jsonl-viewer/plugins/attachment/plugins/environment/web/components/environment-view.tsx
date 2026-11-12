import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const computerIcon = symbol("computer");

/** One field of the snapshot that moved. The NEW value is not carried here —
 *  it is the snapshot's own value for `field`. */
interface EnvironmentChange {
  field?: string;
  from?: string;
}

interface EnvironmentPayload {
  type: "environment";
  /** An OPEN map of harness-owned facts, rendered over its own keys so a field
   *  added upstream appears instead of being silently dropped. */
  snapshot?: Record<string, unknown>;
  changes?: EnvironmentChange[];
}

/** The one field the header already shows, so the body never repeats it. */
const ASIDE_FIELD = "workingDirectory";

/** Keys the harness spells as acronyms; splitting camelCase alone would render
 *  `osVersion` as "Os version". */
const ACRONYMS: Record<string, string> = { os: "OS", id: "ID", url: "URL" };

/**
 * A payload key as a label: `workingDirectory` → `Working directory`,
 * `osVersion` → `OS version`, `isWorktree` → `Worktree`. Derived rather than
 * looked up, so a field the harness adds later still gets a readable label.
 *
 * The leading `is` of a boolean key is dropped: paired with a `yes`/`no` value
 * the prefix says nothing ("Worktree — yes" reads; "Is worktree — yes" stutters).
 */
function humanizeField(field: string): string {
  const words = field
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/);
  const kept = words.length > 1 && words[0] === "is" ? words.slice(1) : words;
  const [first, ...rest] = kept;
  if (!first) return field;
  const head = ACRONYMS[first.toLowerCase()] ?? first;
  return [
    head === first ? head.charAt(0).toUpperCase() + head.slice(1) : head,
    ...rest.map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase()),
  ].join(" ");
}

/** A snapshot value as one readable line. An empty list is "none" rather than a
 *  blank cell, which would read as a missing field instead of an empty one. */
function formatValue(value: unknown): string {
  if (value == null) return "none";
  if (Array.isArray(value)) {
    return value.length === 0 ? "none" : value.map(String).join(", ");
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" gap="sm" align="baseline">
      <Text
        as="span"
        variant="caption"
        className={cn(rigidClass(), "w-36 text-muted-foreground/60")}
      >
        {label}
      </Text>
      <Text
        as="span"
        variant="caption"
        className={cn(
          yieldClass("x"),
          "break-all font-mono text-muted-foreground",
        )}
      >
        {value}
      </Text>
    </Stack>
  );
}

/**
 * Where the agent is running. One component, two readings of the same payload:
 *
 * - the opening snapshot — routine chrome, so the row just says `Environment`
 *   and puts the working directory on the collapsed line;
 * - a snapshot WITH `changes` — the agent moved, which is a fact the reader
 *   cares about, so the label says what moved and the body opens with the
 *   from → to lines before the rest of the snapshot.
 *
 * The snapshot is rendered over its OWN keys rather than a field list of ours:
 * a harness that starts reporting something new shows it, instead of dropping
 * it silently.
 */
export function EnvironmentView({ event }: AttachmentRendererProps) {
  const payload = event.attachment as EnvironmentPayload;
  const snapshot = payload.snapshot;
  if (!snapshot) {
    throw new Error("environment attachment carries no `snapshot`");
  }

  const changes = (payload.changes ?? []).filter(
    (change): change is EnvironmentChange & { field: string } =>
      typeof change.field === "string" && change.field.length > 0,
  );
  const workingDirectory = snapshot[ASIDE_FIELD];
  const rest = Object.entries(snapshot).filter(
    ([field]) => field !== ASIDE_FIELD,
  );

  // Named separately so the single-change label can read the change itself
  // rather than index back into the list under a length test.
  const onlyChange = changes.length === 1 ? changes[0] : undefined;
  const label = onlyChange
    ? `${humanizeField(onlyChange.field)} changed`
    : changes.length === 0
      ? "Environment"
      : `${changes.length} environment fields changed`;

  return (
    <CollapsibleCard
      icon={<Icon icon={computerIcon} className="size-3.5" />}
      label={label}
      aside={
        typeof workingDirectory === "string" && workingDirectory ? (
          <FilePath filePath={workingDirectory} />
        ) : undefined
      }
    >
      <Stack gap="sm">
        {changes.length > 0 && (
          <Stack gap="xs">
            {changes.map((change) => (
              <Stack key={change.field} gap="2xs">
                <Text as="h4" variant="caption" className="text-foreground">
                  {humanizeField(change.field)}
                </Text>
                <FieldRow label="from" value={formatValue(change.from)} />
                <FieldRow
                  label="to"
                  value={formatValue(snapshot[change.field])}
                />
              </Stack>
            ))}
          </Stack>
        )}
        <Stack gap="2xs">
          {rest.map(([field, value]) => (
            <FieldRow
              key={field}
              label={humanizeField(field)}
              value={formatValue(value)}
            />
          ))}
        </Stack>
      </Stack>
    </CollapsibleCard>
  );
}
