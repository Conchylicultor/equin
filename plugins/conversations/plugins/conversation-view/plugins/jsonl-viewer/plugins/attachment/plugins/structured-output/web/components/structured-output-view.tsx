import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const dataObjectIcon = symbol("data-object");

interface StructuredOutputPayload {
  type: "structured_output";
  /** The subagent's own id for the call. Never rendered — it identifies the
   *  tool use, not the result, and the row already sits next to that call. */
  toolUseID?: string;
  /** Shaped by whatever schema the subagent was asked for, so there is no shape
   *  to hardcode: every key set in the sample is different from the last. */
  data?: Record<string, unknown>;
}

/** `openQuestions` → `Open questions`. Splits camelCase and snake/kebab, then
 *  reads as one sentence rather than as an identifier. */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return (line ?? text).trim();
}

/**
 * The one line that tells a reader what this result is ABOUT.
 *
 * `title` is the obvious answer but only two in five payloads carry one, so the
 * general rule is the schema author's own: the FIRST declared field holding a
 * string is the one they put first, and its first line is its headline
 * (`summary`, `thesis`, `winner`…). The key is named alongside it unless it is
 * `title`, where the name adds nothing — so `winner — harness` can never be
 * mistaken for the result's own title.
 */
function headlineOf(data: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const line = firstLine(value);
    return key === "title" ? line : `${humanizeKey(key)} — ${line}`;
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Depth-1 only, deliberately: a general JSON tree viewer would render every
 *  result as a shape rather than as prose, and prose is what these fields are.
 *  Anything that is not a string or a list of strings falls back to indented
 *  JSON — rare, and honest about being structure. */
function FieldValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return (
      <Text
        as="pre"
        variant="caption"
        tone="muted"
        className="whitespace-pre-wrap break-words"
      >
        {value}
      </Text>
    );
  }
  if (isStringArray(value)) {
    return (
      <Stack as="ul" gap="2xs">
        {value.map((item) => (
          <Stack as="li" direction="row" gap="xs" align="start" key={item}>
            <Text variant="caption" className="text-muted-foreground/60">
              •
            </Text>
            <Text
              variant="caption"
              tone="muted"
              className="whitespace-pre-wrap break-words"
            >
              {item}
            </Text>
          </Stack>
        ))}
      </Stack>
    );
  }
  return (
    <Text
      as="pre"
      variant="code"
      tone="muted"
      className="whitespace-pre-wrap break-words"
    >
      {JSON.stringify(value, null, 2)}
    </Text>
  );
}

/**
 * The result a subagent returned against a schema it was given.
 *
 * The collapsed line carries the headline (see `headlineOf`) plus the field
 * count, which together answer both "what is this about" and "how much is in
 * there". The body is a plain reading of the object one level deep: each field's
 * key as a heading, its value below it. Collapsed by default and capped at
 * `max-h-96` — some of these run to thousands of words.
 */
export function StructuredOutputView({ event }: AttachmentRendererProps) {
  const att = event.attachment as StructuredOutputPayload;
  const data = att.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("structured_output attachment carries no `data` object");
  }

  const entries = Object.entries(data);

  return (
    <CollapsibleCard
      icon={<Icon icon={dataObjectIcon} className="size-3.5" />}
      label="Structured output"
      note={`· ${entries.length} ${entries.length === 1 ? "field" : "fields"}`}
      // The headline goes in `summary`, not `note`: `note` sits in the header's
      // rigid identity zone, where a sentence-long title would refuse to shrink
      // and blow the row open. `summary` is the one flexible cell, so it
      // ellipsizes on a narrow pane.
      summary={headlineOf(data)}
    >
      {entries.length === 0 ? (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground/60 italic"
        >
          No fields.
        </Text>
      ) : (
        <Scroll className="max-h-96">
          <Stack gap="sm">
            {entries.map(([key, value]) => (
              <Stack gap="2xs" key={key}>
                <Text
                  as="p"
                  variant="caption"
                  tone="muted"
                  className="font-semibold"
                >
                  {humanizeKey(key)}
                </Text>
                <FieldValue value={value} />
              </Stack>
            ))}
          </Stack>
        </Scroll>
      )}
    </CollapsibleCard>
  );
}
