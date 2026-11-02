import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import {
  plural,
  readWebSearch,
  type SearchScope,
  type SearchSite,
} from "../internal/web-search";

function ScopeLine({ scope }: { scope: SearchScope }) {
  return (
    <Text as="p" variant="caption" className="text-muted-foreground">
      {scope.kind === "only" ? "Only searched " : "Excluded "}
      <span className="font-mono text-foreground">
        {scope.domains.join(", ")}
      </span>
    </Text>
  );
}

function Site({ site }: { site: SearchSite }) {
  return (
    <Stack gap="none" className={yieldClass("x")}>
      <Text as="p" variant="caption" className="font-medium">
        {site.host}
        {site.links.length > 1 && (
          <span className="text-muted-foreground"> · {site.links.length}</span>
        )}
      </Text>
      {site.links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          title={link.url}
          target="_blank"
          rel="noreferrer"
          className="truncate text-caption text-foreground/80 hover:text-primary-text hover:underline"
        >
          {link.title}
        </a>
      ))}
    </Stack>
  );
}

/** Sources stay folded: the summary already cites what matters, and an
 *  extended search returns enough links to bury it. */
function Sources({ sites, count }: { sites: SearchSite[]; count: number }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="gap-xs text-caption text-muted-foreground hover:text-foreground">
        <CollapsibleChevron className="size-3" />
        Sources · {count} from {plural(sites.length, "site")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Inset t="xs">
          <Stack gap="xs">
            {sites.map((site) => (
              <Site key={site.host} site={site} />
            ))}
          </Stack>
        </Inset>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * WebSearch asks the harness to search the web; the result is a model-written
 * summary plus the links it drew on. The row names the query and how many
 * sources came back; opened, it shows the summary in full and the sources,
 * grouped by site, folded beneath it.
 */
export function WebSearchToolView({ event }: ToolRendererProps) {
  const { query, mode, scope, outcome } = readWebSearch(event);
  const errorText = event.result?.isError ? event.result.content : undefined;

  const notes = [
    mode === "extended" ? "extended" : undefined,
    scope
      ? `${scope.kind === "only" ? "only" : "excluding"} ${plural(scope.domains.length, "site")}`
      : undefined,
    outcome
      ? outcome.links.length > 0
        ? plural(outcome.links.length, "source")
        : "no sources"
      : undefined,
  ].filter((n): n is string => n !== undefined);

  return (
    <ToolCallCard
      event={event}
      summary={`“${query}”`}
      note={notes.length > 0 ? `· ${notes.join(" · ")}` : undefined}
    >
      <Stack gap="sm">
        {scope && <ScopeLine scope={scope} />}
        {outcome?.summary && <Markdown>{outcome.summary}</Markdown>}
        {outcome && outcome.sites.length > 0 && (
          <Sources sites={outcome.sites} count={outcome.links.length} />
        )}
        {errorText && (
          <Text as="p" variant="caption" className="text-destructive">
            {errorText}
          </Text>
        )}
      </Stack>
    </ToolCallCard>
  );
}
